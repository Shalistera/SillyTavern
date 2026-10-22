// Measure the real character-list HTTP route with an existing on-disk cache.
// All cards and cache entries are temporary synthetic fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { createCharacterCacheFixture, serveCharacterRouter } from './util/character-cache-fixture.mjs';

const { values } = parseArgs({ options: {
    baseline: { type: 'string', default: '78a22e873' },
    rounds: { type: 'string', default: '5' },
    count: { type: 'string', default: '200' },
    'text-length': { type: 'string', default: '8192' },
    help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
    console.log('Usage: node tests/bench-character-list.mjs [--baseline REF] [--rounds N] [--count N] [--text-length N]\n'
        + 'Defaults: --baseline 78a22e873 --rounds 5 --count 200 --text-length 8192\n'
        + 'Alternates baseline/current HTTP requests; reports wall time, CPU and cache-file reads.\n'
        + 'Each round uses fresh card paths and an existing disk cache, with a 100 MB memory budget.\n'
        + 'Uses current supporting modules and dependencies for both character endpoint versions.');
    process.exit(0);
}
const rounds = Number(values.rounds);
const count = Number(values.count);
const textLength = Number(values['text-length']);
if (![rounds, count, textLength].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Rounds, count and text length must be positive integers.');
}
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE = 'true';
process.env.SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS = 'false';
process.env.SILLYTAVERN_PERFORMANCE_MEMORYCACHECAPACITY = '100mb';
const endpoint = new URL('../src/endpoints/characters.js', import.meta.url);
const gitOptions = { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' };
const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${values.baseline}^{commit}`], gitOptions).trim();
const source = execFileSync('git', ['show', `${commit}:src/endpoints/characters.js`], gitOptions);
const resolvedSource = source.replace(/\bfrom\s+(['"])([^'"\r\n]+)\1(?=\s*;)/g, (_, quote, specifier) => {
    const resolved = specifier.startsWith('.') || specifier.startsWith('/')
        ? new URL(specifier, endpoint).href : import.meta.resolve(specifier);
    return `from '${resolved}'`;
});
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bench-character-list-'));
globalThis.DATA_ROOT = root;
const implementations = {
    baseline: await import('data:text/javascript;base64,' + Buffer.from(resolvedSource).toString('base64')),
    current: await import(endpoint.href),
};
const caches = [];
const samples = [];
const originalReadFile = fs.readFile;
let counters;
fs.readFile = function (file, ...args) {
    const sample = counters;
    if (!sample || !String(file).startsWith(path.join(root, '_cache', 'characters') + path.sep)) {
        return originalReadFile.call(this, file, ...args);
    }
    sample.diskCacheReads++;
    const callback = args.pop();
    args.push((error, data) => {
        if (data) sample.diskCacheBytes += Buffer.byteLength(data);
        callback(error, data);
    });
    return originalReadFile.call(this, file, ...args);
};
const rounded = value => +value.toFixed(2);
const median = items => {
    const sorted = [...items].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return rounded(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
};

try {
    // Complete initialization before counting actual HTTP reads.
    for (const implementation of Object.values(implementations)) caches.push(await implementation.diskCache.instance());
    for (let round = 0; round < rounds; round++) {
        const fixture = await createCharacterCacheFixture(root, { count, textLength, user: `round-${round}` });
        const order = round % 2 ? ['current', 'baseline'] : ['baseline', 'current'];
        const sample = { round: round + 1, order };
        let expected;
        for (const name of order) {
            const server = await serveCharacterRouter(implementations[name].router, fixture.directories);
            try {
                sample[name] = {};
                for (const phase of ['first', 'repeated']) {
                    counters = { diskCacheReads: 0, diskCacheBytes: 0 };
                    const cpuStart = process.cpuUsage();
                    const start = performance.now();
                    const result = await server.request();
                    const durationMs = performance.now() - start;
                    const cpu = process.cpuUsage(cpuStart);
                    sample[name][phase] = { durationMs: rounded(durationMs), cpuMs: rounded((cpu.user + cpu.system) / 1000), ...counters };
                    counters = undefined;
                    assert.equal(result.length, count);
                    if (expected) assert.deepEqual(result, expected);
                    else expected = result;
                }
            } finally {
                await server.close();
            }
        }
        samples.push(sample);
    }
    const summary = {};
    for (const name of Object.keys(implementations)) {
        summary[name] = {};
        for (const phase of ['first', 'repeated']) {
            const items = samples.map(sample => sample[name][phase]);
            summary[name][phase] = {
                medianMs: median(items.map(item => item.durationMs)),
                medianCpuMs: median(items.map(item => item.cpuMs)),
                minMs: Math.min(...items.map(item => item.durationMs)),
                maxMs: Math.max(...items.map(item => item.durationMs)),
                diskCacheReads: items.map(item => item.diskCacheReads),
                diskCacheBytes: items.map(item => item.diskCacheBytes),
            };
        }
    }
    console.log(JSON.stringify({ baseline: commit, count, textLength, rounds, summary, samples,
        note: 'Real localhost HTTP responses include JSON serialization and parsing. OS disk cache is not cleared; results vary with workload and machine load. First means a fresh application memory cache with existing disk-cache entries.',
    }, null, 2));
} finally {
    fs.readFile = originalReadFile;
    for (const implementation of Object.values(implementations)) implementation.diskCache.dispose();
    for (const cache of caches) cache.stopWriteQueueInterval();
    await fs.promises.rm(root, { recursive: true, force: true });
}
