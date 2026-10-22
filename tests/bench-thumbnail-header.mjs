// Compare actual thumbnail generation using temporary synthetic images. The
// image probe is timed together with decoding/encoding for static PNGs; this is
// not an end-to-end page or HTTP download benchmark.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import '../src/fetch-patch.js';
import { createThumbnailDirectories, thumbnailPng, thumbnailWebp } from './util/thumbnail-fixture.mjs';

const { values } = parseArgs({ options: {
    baseline: { type: 'string', default: '46c47c5b0' },
    rounds: { type: 'string', default: '5' },
    files: { type: 'string', default: '12' },
    'image-mib': { type: 'string', default: '2' },
    help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
    console.log('Usage: node tests/bench-thumbnail-header.mjs [--baseline REF] [--rounds N] [--files N] [--image-mib N]\n'
        + 'Defaults: --baseline 46c47c5b0 --rounds 5 --files 12 --image-mib 2\n'
        + 'Reports real generateThumbnail wall time, CPU, and separately instrumented original-file bytes read.\n'
        + 'Static/APNG fixtures are one-pixel images with large ancillary chunks; WebP fixtures are synthetic animated headers.\n'
        + 'Uses current supporting modules and dependencies for both endpoint versions. Temporary data is removed.');
    process.exit(0);
}
const rounds = Number(values.rounds);
const files = Number(values.files);
const imageMiB = Number(values['image-mib']);
if (![rounds, files, imageMiB].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Rounds, files and image MiB must be positive integers.');
}
process.env.SILLYTAVERN_THUMBNAILS_FORMAT = 'png';
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const endpoint = new URL('../src/endpoints/thumbnails.js', import.meta.url);
const endpointRequire = createRequire(endpoint);
const gitOptions = { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' };
const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${values.baseline}^{commit}`], gitOptions).trim();
const source = execFileSync('git', ['show', `${commit}:src/endpoints/thumbnails.js`], gitOptions);
const resolvedSource = source.replace(/\bfrom\s+(['"])([^'"\r\n]+)\1(?=\s*;)/g, (_, quote, specifier) => {
    const resolved = specifier.startsWith('.') || specifier.startsWith('/')
        ? new URL(specifier, endpoint).href
        : specifier.startsWith('node:') ? specifier : pathToFileURL(endpointRequire.resolve(specifier)).href;
    return `from '${resolved}'`;
});
const implementations = {
    baseline: await import('data:text/javascript;base64,' + Buffer.from(resolvedSource).toString('base64')),
    current: await import(endpoint.href),
};
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bench-thumbnail-header-'));
const original = { open: fs.openSync, read: fs.readSync, close: fs.closeSync, readFile: fs.readFileSync };
let counters;
let insideFullRead = false;
const descriptors = new Set();

try {
    const directories = await createThumbnailDirectories(root);
    const paddingBytes = imageMiB * 1024 * 1024;
    const scenarios = [
        { name: 'animatedPng', extension: 'png', source: thumbnailPng({ animated: true, paddingBytes }), animated: true },
        { name: 'animatedWebp', extension: 'webp', source: thumbnailWebp(paddingBytes), animated: true },
        { name: 'staticPng', extension: 'png', source: thumbnailPng({ paddingBytes }), animated: false },
    ];
    for (const scenario of scenarios) {
        scenario.files = Array.from({ length: files }, (_, i) => `${scenario.name}-${i}.${scenario.extension}`);
        for (const file of scenario.files) await fs.promises.writeFile(path.join(directories.backgrounds, file), scenario.source);
    }

    async function run(name, scenario) {
        const results = [];
        for (const file of scenario.files) {
            results.push(await implementations[name].generateThumbnail(directories, 'bg', file, true));
        }
        return results;
    }

    async function verify(results, scenario, expected) {
        for (const result of results) {
            if (scenario.animated) {
                assert.deepEqual(result, { path: null, aspectRatio: null, resolution: null });
            } else {
                assert.ok(result.path);
                assert.equal(result.aspectRatio, 1);
                assert.equal(result.resolution, 14400);
            }
        }
        const signatures = await Promise.all(results.map(async result => ({
            ...result,
            hash: result.path ? createHash('sha256').update(await fs.promises.readFile(result.path)).digest('hex') : null,
        })));
        if (expected) assert.deepEqual(signatures, expected);
        return signatures;
    }

    // Warm the real image codec before measurements. Both implementations still
    // force a fresh thumbnail generation for every static image on every run.
    for (const name of Object.keys(implementations)) await run(name, scenarios[2]);
    const reports = [];
    for (const scenario of scenarios) {
        let expected;
        const samples = [];
        for (let round = 0; round < rounds; round++) {
            const order = round % 2 ? ['current', 'baseline'] : ['baseline', 'current'];
            const sample = { round: round + 1, order };
            for (const name of order) {
                const cpuStart = process.cpuUsage();
                const start = performance.now();
                const result = await run(name, scenario);
                const durationMs = performance.now() - start;
                const cpu = process.cpuUsage(cpuStart);
                sample[name] = { durationMs: rounded(durationMs), cpuMs: rounded((cpu.user + cpu.system) / 1000) };
                expected = await verify(result, scenario, expected);
            }
            samples.push(sample);
        }
        reports.push({ scenario: scenario.name, bytesPerOriginal: scenario.source.length, samples, expected });
    }

    // Count original-file I/O separately so instrumentation does not affect the
    // timings. Serving an original to the browser is outside this measurement.
    fs.openSync = function (file, ...args) {
        const descriptor = original.open.call(this, file, ...args);
        if (counters && !insideFullRead && String(file).startsWith(directories.backgrounds + path.sep)) {
            descriptors.add(descriptor);
            counters.headerOpens++;
        }
        return descriptor;
    };
    fs.readSync = function (descriptor, ...args) {
        const count = original.read.call(this, descriptor, ...args);
        if (counters && descriptors.has(descriptor)) counters.headerBytes += count;
        return count;
    };
    fs.closeSync = function (descriptor) {
        if (descriptors.delete(descriptor) && counters) counters.headerCloses++;
        return original.close.call(this, descriptor);
    };
    fs.readFileSync = function (file, ...args) {
        insideFullRead = true;
        try {
            const result = original.readFile.call(this, file, ...args);
            if (counters && String(file).startsWith(directories.backgrounds + path.sep)) {
                counters.fullReads++;
                counters.fullBytes += result.length;
            }
            return result;
        } finally {
            insideFullRead = false;
        }
    };
    for (let i = 0; i < reports.length; i++) {
        const report = reports[i];
        report.summary = {};
        for (const name of Object.keys(implementations)) {
            counters = { headerOpens: 0, headerCloses: 0, headerBytes: 0, fullReads: 0, fullBytes: 0 };
            const result = await run(name, scenarios[i]);
            const counts = counters;
            counters = undefined;
            await verify(result, scenarios[i], report.expected);
            assert.equal(counts.headerOpens, counts.headerCloses);
            report.summary[name] = {
                medianMs: median(report.samples.map(sample => sample[name].durationMs)),
                medianCpuMs: median(report.samples.map(sample => sample[name].cpuMs)),
                originalBytesRead: counts.fullBytes + counts.headerBytes,
                operations: counts,
            };
        }
        delete report.expected;
    }
    console.log(JSON.stringify({ baseline: { ref: values.baseline, commit }, filesPerScenario: files, imageMiB, rounds, reports,
        note: 'Actual generateThumbnail calls; animated images skip decoding and static PNGs use the real Jimp WASM codec, resize and encode. One-pixel synthetic fixtures isolate redundant reads without simulating the decode cost of high-resolution images. Every static output is hash-compared. Measurements exclude HTTP delivery, directory setup, verification and instrumented operation counts. OS disk cache is not cleared; timings vary with load.',
    }, null, 2));
} finally {
    fs.openSync = original.open;
    fs.readSync = original.read;
    fs.closeSync = original.close;
    fs.readFileSync = original.readFile;
    await fs.promises.rm(root, { recursive: true, force: true });
}

function rounded(value) {
    return +value.toFixed(2);
}

function median(items) {
    const sorted = [...items].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return rounded(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}
