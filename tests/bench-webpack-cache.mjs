import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWebpackCacheFixture, compileWebpackFixture } from './util/webpack-cache-fixture.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.env.ST_WEBPACK_BASELINE || 'bebe62bda';
const rounds = Number(process.env.BENCHMARK_ROUNDS || 2);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('BENCHMARK_ROUNDS must be between 1 and 10');
const gitOptions = { cwd: repositoryRoot, encoding: 'utf8' };
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${baseline}^{commit}`], gitOptions).trim();
const baselineSource = execFileSync('git', ['show', `${baselineCommit}:webpack.config.js`], gitOptions);
const currentSource = await fs.readFile(new URL('../webpack.config.js', import.meta.url), 'utf8');
const fixtures = {};
const results = [];
const initialOutputs = {};
try {
    for (const [version, source] of [['baseline', baselineSource], ['current', currentSource]]) {
        fixtures[version] = await createWebpackCacheFixture(source, { realLibraries: true });
        const result = await compileWebpackFixture(await fixtures[version].config());
        initialOutputs[version] = result.output;
        results.push({ version, phase: 'initial', elapsedMs: result.elapsedMs, builtModules: result.builtModules });
        console.log(JSON.stringify(results.at(-1)));
    }
    assert.equal(initialOutputs.current, initialOutputs.baseline, 'both configs must emit the same application library');
    for (let round = 0; round < rounds; round++) {
        for (const version of round % 2 ? ['baseline', 'current'] : ['current', 'baseline']) {
            const fixture = fixtures[version];
            // The legacy config reads this revision through its normal getVersion
            // call. The build inputs and dependency tree stay unchanged.
            await fixture.write('revision', `unrelated-commit-${round}`);
            await fixture.write('public/unrelated.js', `export const unrelatedChange = ${round};\n`);
            const result = await compileWebpackFixture(await fixture.config());
            assert.equal(result.output, initialOutputs[version]);
            results.push({ version, phase: 'unrelated-commit', round, elapsedMs: result.elapsedMs, builtModules: result.builtModules });
            console.log(JSON.stringify(results.at(-1)));
        }
    }
    const report = { baseline, baselineCommit, rounds, node: process.version, results };
    await fs.writeFile(process.env.BENCHMARK_OUTPUT || '/tmp/csillytavern-webpack-cache-benchmark.json', JSON.stringify(report, null, 2));
} finally {
    for (const fixture of Object.values(fixtures)) await fixture.cleanup();
}
