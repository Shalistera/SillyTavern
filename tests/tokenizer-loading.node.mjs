import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { SentencePieceProcessor } from '@agnai/sentencepiece-js';
import { Tokenizer } from '@agnai/web-tokenizers';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const tick = () => new Promise(resolve => setImmediate(resolve));
let generation = 0;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function freshEndpoint(t) {
    t.mock.method(console, 'info', () => {});
    t.mock.method(console, 'error', () => {});
    return import(`../src/endpoints/tokenizers.js?loading-test=${generation++}`);
}

function mockModelReads(t, callback) {
    const original = fs.promises.readFile;
    return t.mock.method(fs.promises, 'readFile', function (file, ...args) {
        if (file === 'src/tokenizers/claude.json' || file === 'src/tokenizers/llama3.json') return callback(file);
        return original.call(this, file, ...args);
    });
}

test('SentencePiece callers before and during initialization share one ready instance', async t => {
    const { getSentencepiceTokenizer } = await freshEndpoint(t);
    const started = deferred();
    const gate = deferred();
    const load = t.mock.method(SentencePieceProcessor.prototype, 'load', async function () {
        started.resolve();
        await gate.promise;
        this.ready = true;
    });
    const tokenizer = getSentencepiceTokenizer('llama');
    const early = Array.from({ length: 12 }, () => tokenizer.get());
    await started.promise;
    let settled = 0;
    const late = Array.from({ length: 12 }, () => tokenizer.get().then(instance => { settled++; return instance; }));
    await tick();
    const beforeReady = settled;
    gate.resolve();
    const instances = await Promise.all([...early, ...late]);
    assert.equal(beforeReady, 0, 'no caller may observe an uninitialized processor');
    assert.equal(load.mock.callCount(), 1, 'only one model initialization should run');
    assert.ok(instances.every(instance => instance === instances[0] && instance.ready));
    assert.equal(await tokenizer.get(), instances[0]);
    assert.equal(load.mock.callCount(), 1);
});

test('failed SentencePiece initialization is shared, discarded and retried', async t => {
    const { getSentencepiceTokenizer } = await freshEndpoint(t);
    const started = deferred();
    const gate = deferred();
    let attempts = 0;
    const instances = [];
    t.mock.method(SentencePieceProcessor.prototype, 'load', async function () {
        instances.push(this);
        if (++attempts === 1) {
            started.resolve();
            await gate.promise;
        }
        this.ready = true;
    });
    const tokenizer = getSentencepiceTokenizer('llama');
    const first = tokenizer.get();
    await started.promise;
    const concurrent = tokenizer.get();
    gate.reject(new Error('synthetic model failure'));
    assert.deepEqual(await Promise.all([first, concurrent]), [null, null]);
    const retried = await tokenizer.get();
    assert.equal(attempts, 2);
    assert.equal(retried.ready, true);
    assert.notEqual(retried, instances[0]);
    assert.equal(await tokenizer.get(), retried);
});

test('different SentencePiece models can initialize independently', async t => {
    const { getSentencepiceTokenizer } = await freshEndpoint(t);
    const llama = deferred();
    const mistral = deferred();
    const started = [];
    t.mock.method(SentencePieceProcessor.prototype, 'load', async function (file) {
        started.push(file);
        await (file.includes('llama') ? llama.promise : mistral.promise);
        this.file = file;
    });
    const first = getSentencepiceTokenizer('llama').get();
    let secondFinished = false;
    const second = getSentencepiceTokenizer('mistral').get().then(instance => { secondFinished = true; return instance; });
    await tick();
    assert.deepEqual(started.sort(), ['src/tokenizers/llama.model', 'src/tokenizers/mistral.model']);
    llama.resolve();
    assert.equal((await first).file, 'src/tokenizers/llama.model');
    assert.equal(secondFinished, false);
    mistral.resolve();
    assert.equal((await second).file, 'src/tokenizers/mistral.model');
});

test('WebTokenizer shares both the model read and the pending parser', async t => {
    const { getWebTokenizer } = await freshEndpoint(t);
    const reading = deferred();
    const readGate = deferred();
    const parsing = deferred();
    const parseGate = deferred();
    let reads = 0;
    mockModelReads(t, async () => { reads++; reading.resolve(); await readGate.promise; return Buffer.from('model'); });
    const instance = { ready: true };
    const parser = t.mock.method(Tokenizer, 'fromJSON', async data => {
        assert.equal(data.toString(), 'model');
        parsing.resolve();
        await parseGate.promise;
        return instance;
    });
    const tokenizer = getWebTokenizer('claude');
    const early = Array.from({ length: 12 }, () => tokenizer.get());
    await reading.promise;
    readGate.resolve();
    await parsing.promise;
    const late = Array.from({ length: 12 }, () => tokenizer.get());
    await tick();
    parseGate.resolve();
    assert.ok((await Promise.all([...early, ...late])).every(value => value === instance));
    assert.equal(reads, 1);
    assert.equal(parser.mock.callCount(), 1);
    assert.equal(await tokenizer.get(), instance);
    assert.equal(reads, 1);
});

for (const failure of ['read', 'parse']) {
    test(`WebTokenizer retries after a shared ${failure} failure`, async t => {
        const { getWebTokenizer } = await freshEndpoint(t);
        const entered = deferred();
        const gate = deferred();
        let reads = 0;
        let parses = 0;
        const instance = { ready: true };
        mockModelReads(t, async () => {
            reads++;
            if (failure === 'read' && reads === 1) { entered.resolve(); await gate.promise; }
            return Buffer.from('model');
        });
        t.mock.method(Tokenizer, 'fromJSON', async () => {
            parses++;
            if (failure === 'parse' && parses === 1) { entered.resolve(); await gate.promise; }
            return instance;
        });
        const tokenizer = getWebTokenizer('claude');
        const first = tokenizer.get();
        await entered.promise;
        const second = tokenizer.get();
        gate.reject(new Error('synthetic model failure'));
        assert.deepEqual(await Promise.all([first, second]), [null, null]);
        assert.equal(await tokenizer.get(), instance);
        assert.equal(reads, 2);
        assert.equal(parses, failure === 'read' ? 1 : 2);
        assert.equal(await tokenizer.get(), instance);
    });
}

test('different WebTokenizer models initialize independently without sharing instances', async t => {
    const { getWebTokenizer } = await freshEndpoint(t);
    const claude = deferred();
    const llama = deferred();
    const started = [];
    mockModelReads(t, file => Promise.resolve(Buffer.from(file)));
    t.mock.method(Tokenizer, 'fromJSON', async data => {
        const file = data.toString();
        started.push(file);
        await (file.includes('claude') ? claude.promise : llama.promise);
        return { file };
    });
    const first = getWebTokenizer('claude').get();
    let secondFinished = false;
    const second = getWebTokenizer('llama3').get().then(instance => { secondFinished = true; return instance; });
    await tick();
    assert.deepEqual(started.sort(), ['src/tokenizers/claude.json', 'src/tokenizers/llama3.json']);
    claude.resolve();
    assert.equal((await first).file, 'src/tokenizers/claude.json');
    assert.equal(secondFinished, false);
    llama.resolve();
    assert.equal((await second).file, 'src/tokenizers/llama3.json');
});

for (const model of ['llama', 'claude']) {
    test(`concurrent ${model} HTTP encodes wait for readiness and retain their response shape`, async t => {
        const { router } = await freshEndpoint(t);
        const gate = deferred();
        let loads = 0;
        if (model === 'llama') {
            t.mock.method(SentencePieceProcessor.prototype, 'load', async function () { loads++; await gate.promise; this.ready = true; });
            t.mock.method(SentencePieceProcessor.prototype, 'encodeIds', function () { assert.ok(this.ready); return [7, 8]; });
            t.mock.method(SentencePieceProcessor.prototype, 'encodePieces', function () { assert.ok(this.ready); return ['a', 'b']; });
        } else {
            mockModelReads(t, async () => Buffer.from('model'));
            t.mock.method(Tokenizer, 'fromJSON', async () => {
                loads++;
                await gate.promise;
                return { encode: () => new Int32Array([7, 8]), decode: ids => ids[0] === 7 ? 'a' : 'b' };
            });
        }
        const arrived = deferred();
        const app = express();
        let requests = 0;
        app.use(express.json());
        app.use((request, response, next) => { if (++requests === 8) arrived.resolve(); next(); });
        app.use('/api/tokenizers', router);
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        t.after(() => new Promise(resolve => server.close(resolve)));
        const endpoint = `http://127.0.0.1:${server.address().port}/api/tokenizers/${model}/encode`;
        let completed = 0;
        const pending = Array.from({ length: 8 }, async () => {
            const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'ab' }) });
            completed++;
            assert.equal(response.status, 200);
            return response.json();
        });
        await arrived.promise;
        await tick();
        const prematureResponses = completed;
        gate.resolve();
        const results = await Promise.all(pending);
        assert.equal(prematureResponses, 0);
        assert.equal(loads, 1);
        for (const result of results) assert.deepEqual(result, { ids: [7, 8], count: 2, chunks: ['a', 'b'] });
        const countResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/tokenizers/openai/count?model=${model}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ role: 'user', content: 'ab' }]),
        });
        assert.equal(countResponse.status, 200);
        assert.deepEqual(await countResponse.json(), { token_count: 2 });
        assert.equal(loads, 1);
    });
}

test('SentencePiece HTTP failure estimates once, then a later request retries successfully', async t => {
    const { router } = await freshEndpoint(t);
    let attempts = 0;
    t.mock.method(SentencePieceProcessor.prototype, 'load', async function () {
        if (++attempts === 1) throw new Error('synthetic first-load failure');
        this.ready = true;
    });
    t.mock.method(SentencePieceProcessor.prototype, 'encodeIds', function () { assert.ok(this.ready); return [7, 8]; });
    t.mock.method(SentencePieceProcessor.prototype, 'encodePieces', function () { assert.ok(this.ready); return ['a', 'b']; });
    const app = express();
    app.use(express.json());
    app.use('/api/tokenizers', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    async function encode() {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tokenizers/llama/encode`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'ab' }),
        });
        assert.equal(response.status, 200);
        return response.json();
    }
    assert.deepEqual(await encode(), { ids: [], count: 1 });
    assert.equal(attempts, 1, 'one request must not retry its own failed initialization');
    assert.deepEqual(await encode(), { ids: [7, 8], count: 2, chunks: ['a', 'b'] });
    assert.equal(attempts, 2);
});
