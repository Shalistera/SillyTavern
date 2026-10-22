// Compare the real group-list HTTP route using temporary synthetic groups.
// Neither a running SillyTavern instance nor a provider connection is needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { createGroupListFixture, serveGroupRouter } from './util/group-list-fixture.mjs';

const { values } = parseArgs({ options: {
    baseline: { type: 'string', default: 'bebe62bda' },
    rounds: { type: 'string', default: '5' },
    groups: { type: 'string', default: '200' },
    'chats-per-group': { type: 'string', default: '20' },
    'shared-chats': { type: 'string', default: '0' },
    help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
    console.log('Usage: node tests/bench-group-list.mjs [--baseline REF] [--rounds N] [--groups N] [--chats-per-group N] [--shared-chats N]\n'
        + 'Defaults: --baseline bebe62bda --rounds 5 --groups 200 --chats-per-group 20 --shared-chats 0\n'
        + 'Each group has its own chats plus any shared chats. Both versions return identical HTTP JSON.\n'
        + 'Reports wall time, process CPU, path parsing and filesystem calls. Temporary fixtures are removed.\n'
        + 'Uses current supporting modules and dependencies for both endpoint versions.');
    process.exit(0);
}
const rounds = Number(values.rounds);
const groups = Number(values.groups);
const chatsPerGroup = Number(values['chats-per-group']);
const sharedChats = Number(values['shared-chats']);
if (![rounds, groups].every(value => Number.isSafeInteger(value) && value > 0)
    || ![chatsPerGroup, sharedChats].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Rounds and groups must be positive integers; chat counts must be nonnegative integers.');
}
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const endpoint = new URL('../src/endpoints/groups.js', import.meta.url);
const gitOptions = { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' };
const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${values.baseline}^{commit}`], gitOptions).trim();
const source = execFileSync('git', ['show', `${commit}:src/endpoints/groups.js`], gitOptions);
const resolvedSource = source.replace(/\bfrom\s+(['"])([^'"\r\n]+)\1(?=\s*;)/g, (_, quote, specifier) => {
    const resolved = specifier.startsWith('.') || specifier.startsWith('/')
        ? new URL(specifier, endpoint).href : import.meta.resolve(specifier);
    return `from '${resolved}'`;
});
const implementations = {
    baseline: await import('data:text/javascript;base64,' + Buffer.from(resolvedSource).toString('base64')),
    current: await import(endpoint.href),
};
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bench-group-list-'));
const original = { parse: path.parse, statSync: fs.statSync, readFileSync: fs.readFileSync };
const servers = {};
let counters;

try {
    const directories = await createGroupListFixture(root, { groups, chatsPerGroup, sharedChats });
    for (const [name, implementation] of Object.entries(implementations)) {
        servers[name] = await serveGroupRouter(implementation.router, directories);
    }
    const samples = [];
    let expected;
    for (let round = 0; round < rounds; round++) {
        const order = round % 2 ? ['current', 'baseline'] : ['baseline', 'current'];
        const sample = { round: round + 1, order };
        for (const name of order) {
            const cpuStart = process.cpuUsage();
            const start = performance.now();
            const result = await servers[name].request();
            const durationMs = performance.now() - start;
            const cpu = process.cpuUsage(cpuStart);
            sample[name] = { durationMs: rounded(durationMs), cpuMs: rounded((cpu.user + cpu.system) / 1000) };
            assert.equal(result.length, groups);
            if (expected) assert.deepEqual(result, expected);
            else expected = result;
        }
        samples.push(sample);
    }
    // Instrumentation inside a hot path can distort its timing. Collect the
    // operation counts in separate requests after every timed round completes.
    path.parse = function (file) {
        if (counters && file.endsWith('.jsonl')) counters.chatPathParses++;
        return original.parse.call(this, file);
    };
    fs.statSync = function (file, ...args) {
        if (counters) {
            if (String(file).startsWith(directories.groupChats + path.sep)) counters.chatStats++;
            if (String(file).startsWith(directories.groups + path.sep)) counters.groupStats++;
        }
        return original.statSync.call(this, file, ...args);
    };
    fs.readFileSync = function (file, ...args) {
        const result = original.readFileSync.call(this, file, ...args);
        if (counters && String(file).startsWith(directories.groups + path.sep)) {
            counters.groupReads++;
            counters.groupBytesRead += Buffer.byteLength(result);
        }
        return result;
    };
    const operationCounts = {};
    for (const name of Object.keys(implementations)) {
        counters = { chatPathParses: 0, chatStats: 0, groupStats: 0, groupReads: 0, groupBytesRead: 0 };
        assert.deepEqual(await servers[name].request(), expected);
        operationCounts[name] = counters;
        counters = undefined;
    }
    const summary = {};
    for (const name of Object.keys(implementations)) {
        const items = samples.map(sample => sample[name]);
        summary[name] = {
            medianMs: median(items.map(item => item.durationMs)),
            medianCpuMs: median(items.map(item => item.cpuMs)),
            minMs: Math.min(...items.map(item => item.durationMs)),
            maxMs: Math.max(...items.map(item => item.durationMs)),
            operationCounts: operationCounts[name],
        };
    }
    console.log(JSON.stringify({ baseline: { ref: values.baseline, commit }, groups, chatsPerGroup, sharedChats,
        uniqueChatFiles: groups * chatsPerGroup + sharedChats, rounds, summary, samples,
        note: 'Real localhost HTTP responses include JSON serialization and parsing. Every request rereads group JSON and obtains fresh stats; no cross-request cache is used. Operation counts are collected separately after all uninstrumented timed rounds. OS disk cache is not cleared; timings vary with machine load.',
    }, null, 2));
} finally {
    path.parse = original.parse;
    fs.statSync = original.statSync;
    fs.readFileSync = original.readFileSync;
    for (const server of Object.values(servers)) await server.close();
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
