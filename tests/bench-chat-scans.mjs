// Compare the JSONL scan paths against a local Git revision. Uses synthetic
// fixtures only; neither a running server nor a provider connection is needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
    options: {
        baseline: { type: 'string', default: '78a22e873' },
        rounds: { type: 'string', default: '3' },
        messages: { type: 'string', default: '10000' },
        repeats: { type: 'string', default: '1024' },
        charset: { type: 'string', default: 'both' },
        help: { type: 'boolean', short: 'h' },
    },
});
if (values.help) {
    console.log('Usage: node tests/bench-chat-scans.mjs [--baseline REF] [--rounds N] [--messages N] [--repeats N] [--charset both|ascii|unicode]\n'
        + 'Defaults: --baseline 78a22e873 --rounds 3 --messages 10000 --repeats 1024 --charset both\n'
        + 'Each fixture is about 98 MiB by default. ASCII and multilingual bodies have equal byte lengths.\n'
        + 'Reports wall time, process CPU, content bytes and open streams for summaries and searches.\n'
        + 'Uses current supporting modules and dependencies for both endpoint versions. Temporary files are removed.');
    process.exit(0);
}
const roundCount = Number(values.rounds);
const messageCount = Number(values.messages);
const repeats = Number(values.repeats);
if (![roundCount, messageCount, repeats].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Rounds, messages and repeats must be positive integers.');
}
if (!['both', 'ascii', 'unicode'].includes(values.charset)) throw new Error('Charset must be both, ascii or unicode.');
const charsets = values.charset === 'both' ? ['ascii', 'unicode'] : [values.charset];
const endpointUrl = new URL('../src/endpoints/chats.js', import.meta.url);
const repository = fileURLToPath(new URL('../', import.meta.url));
const gitOptions = { cwd: repository, encoding: /** @type {const} */ ('utf8') };
const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${values.baseline}^{commit}`], gitOptions).trim();
const source = execFileSync('git', ['show', `${commit}:src/endpoints/chats.js`], gitOptions);
// Preserve the real endpoint code while giving a data URL the import context
// of its original file. Supporting modules are deliberately shared.
const resolvedSource = source.replace(/\bfrom\s+(['"])([^'"\r\n]+)\1(?=\s*;)/g, (_, quote, specifier) => {
    const resolved = specifier.startsWith('.') || specifier.startsWith('/')
        ? new URL(specifier, endpointUrl).href : import.meta.resolve(specifier);
    return `from '${resolved}'`;
});
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';
const implementations = {
    baseline: await import('data:text/javascript;base64,' + Buffer.from(resolvedSource).toString('base64')),
    current: await import(endpointUrl.href),
};
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bench-scans-'));
const open = fs.createReadStream;
let counters;
fs.createReadStream = (...args) => {
    const sample = counters;
    sample.contentReads++;
    sample.peakStreams = Math.max(sample.peakStreams, ++sample.activeStreams);
    const stream = open(...args);
    stream.once('close', () => {
        sample.bytesRead += stream.bytesRead;
        sample.activeStreams--;
    });
    return stream;
};
const rounded = value => +value.toFixed(2);
const median = samples => {
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return rounded(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
};
async function measure(operation) {
    counters = { contentReads: 0, bytesRead: 0, activeStreams: 0, peakStreams: 0 };
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const result = await operation();
    // Include descriptor closure in both versions. Never reset counters while
    // a prior stream still has an outstanding close event.
    while (counters.activeStreams > 0) await new Promise(resolve => setImmediate(resolve));
    const durationMs = rounded(performance.now() - start);
    const cpu = process.cpuUsage(cpuStart);
    return { result, metrics: { durationMs, cpuMs: rounded((cpu.user + cpu.system) / 1000), ...counters } };
}

try {
    const results = [];
    for (const charset of charsets) {
        const body = (charset === 'ascii' ? 'abcdefghij' : '汉字🙂').repeat(repeats);
        const message = JSON.stringify({ name: 'Character', mes: body, send_date: '2026-01-01' });
        const firstMessage = JSON.stringify({ name: 'Character', mes: 'early needle ' + body, send_date: '2026-01-01' });
        const contents = JSON.stringify({ chat_metadata: {} }) + '\n' + firstMessage + (messageCount > 1 ? '\n' + Array(messageCount - 1).fill(message).join('\n') : '');
        const preview = messageCount > 1 ? body : 'early needle ' + body;
        const rounds = [];
        for (let round = 0; round < roundCount; round++) {
            const roundRoot = path.join(root, `${charset}-${round}`);
            const characterDirectory = path.join(roundRoot, 'Character');
            await fs.promises.mkdir(characterDirectory, { recursive: true });
            const file = path.join(characterDirectory, 'filename match.jsonl');
            await fs.promises.writeFile(file, contents);
            const order = round % 2 ? ['current', 'baseline'] : ['baseline', 'current'];
            const roundResult = { round: round + 1, order };
            for (const name of order) {
                const implementation = implementations[name];
                const phases = {};
                for (const phase of ['summaryFirst', 'summaryRepeated', 'searchEarly', 'searchAbsent', 'filenameWarm']) {
                    const measured = await measure(async () => {
                        if (phase === 'filenameWarm') {
                            const handler = implementation.router.stack.find(layer => layer.route?.path === '/search').route.stack.at(-1).handle;
                            let result;
                            await handler({ body: { query: 'filename match', avatar_url: 'Character.png' }, user: { directories: { chats: roundRoot } } }, {
                                send(value) { result = value; },
                                status(code) { throw new Error(`Search failed with status ${code}`); },
                            });
                            assert.equal(result.length, 1);
                            assert.equal(result[0].message_count, messageCount);
                            return;
                        }
                        const matcher = phase === 'searchEarly' ? implementation.createChatSearchMatcher(['early', 'needle'])
                            : phase === 'searchAbsent' ? implementation.createChatSearchMatcher(['never-present']) : null;
                        const result = await implementation.getChatInfo(file, {}, false, matcher);
                        assert.equal(result.chat_items, messageCount);
                        assert.equal(result.mes, preview);
                        assert.equal(result.match, phase !== 'searchAbsent');
                    });
                    phases[phase] = measured.metrics;
                }
                roundResult[name] = phases;
            }
            rounds.push(roundResult);
            await fs.promises.rm(roundRoot, { recursive: true, force: true });
        }
        const summary = {};
        for (const name of Object.keys(implementations)) {
            summary[name] = {};
            for (const phase of Object.keys(rounds[0][name])) {
                const samples = rounds.map(round => round[name][phase]);
                summary[name][phase] = {
                    medianMs: median(samples.map(sample => sample.durationMs)),
                    medianCpuMs: median(samples.map(sample => sample.cpuMs)),
                    minMs: Math.min(...samples.map(sample => sample.durationMs)),
                    maxMs: Math.max(...samples.map(sample => sample.durationMs)),
                    bytesReadPerRound: samples.map(sample => sample.bytesRead),
                    peakStreams: Math.max(...samples.map(sample => sample.peakStreams)),
                };
            }
        }
        results.push({ charset, inputMiB: rounded(Buffer.byteLength(contents) / 1024 / 1024), summary, rounds });
    }
    console.log(JSON.stringify({
        baseline: { ref: values.baseline, commit, scope: 'Git endpoint with current supporting modules and dependencies' },
        messages: messageCount,
        repeats,
        note: 'OS disk cache is not cleared. First means no retained application summary. CPU is process user+system time. Both timings include stream closure. Filename searches start with a valid cached summary. Workload and machine contention affect results.',
        results,
    }, null, 2));
} finally {
    fs.createReadStream = open;
    await fs.promises.rm(root, { recursive: true, force: true });
}
