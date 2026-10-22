import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';

process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';
const { getChatInfo, createChatSearchMatcher } = await import('../src/endpoints/chats.js');

const metadata = { note: '魔女🙂 metadata' };
const header = JSON.stringify({ chat_metadata: metadata });
const message = text => JSON.stringify({ name: 'Character', mes: text, send_date: '2026-01-01' });

async function directory(t) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-byte-scan-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    return root;
}

test('byte scanning preserves readline counts, previews and metadata across UTF-8 and line-ending boundaries', async (t) => {
    const root = await directory(t);
    const open = fs.createReadStream;
    let chunkSize = 1;
    t.mock.method(fs, 'createReadStream', (file, options) => open(file, { ...options, highWaterMark: chunkSize }));
    let index = 0;
    const variants = [
        [header, message('first 魔女🙂'), message('last 汉字🚀')],
        [header, '', message('last 汉字🚀')],
        [header],
        [''],
    ];
    for (chunkSize of [1, 2, 3, 7, 64]) {
        for (const ending of ['\n', '\r', '\r\n']) {
            for (const lines of variants) {
                for (const suffix of ['', ending, ending + ending]) {
                    const contents = lines.join(ending) + suffix;
                    const file = path.join(root, `${index++}.jsonl`);
                    await fs.promises.writeFile(file, contents);
                    // Native readline is the compatibility oracle for line
                    // boundaries, including its treatment of trailing blanks.
                    const referenceLines = [];
                    const reader = readline.createInterface({ input: Readable.from([Buffer.from(contents)]), crlfDelay: Infinity });
                    for await (const line of reader) referenceLines.push(line);
                    const lastLine = referenceLines.at(-1);
                    const expected = lastLine ? JSON.parse(lastLine) : null;
                    const actual = await getChatInfo(file, {}, true);
                    const context = JSON.stringify({ chunkSize, ending, lines, suffix });
                    assert.equal(actual.chat_items, expected ? referenceLines.length - 1 : 0, context);
                    assert.equal(actual.mes, expected ? expected.mes || '[The message is empty]' : '[The chat is empty]', context);
                    assert.equal(actual.match, !!expected, context);
                    assert.deepEqual(actual.chat_metadata, referenceLines[0] === header ? metadata : undefined, context);
                }
            }
        }
    }
});

test('mixed CR/LF endings and malformed UTF-8 retain literal search and preview behavior', async (t) => {
    const root = await directory(t);
    const open = fs.createReadStream;
    t.mock.method(fs, 'createReadStream', (file, options) => open(file, { ...options, highWaterMark: 1 }));
    const file = path.join(root, 'mixed.jsonl');
    const contents = Buffer.concat([
        Buffer.from(header + '\r\n' + message('ALPHA 魔女🙂') + '\r\n\r' + message('beta') + '\n{"name":"Character","mes":"'),
        Buffer.from([0xe2, 0x82]), // Truncated UTF-8 sequence inside valid JSON.
        Buffer.from(' final","send_date":"2026-01-01"}\r\n'),
    ]);
    await fs.promises.writeFile(file, contents);
    const visited = [];
    const matching = createChatSearchMatcher(['alpha', 'beta']);
    const result = await getChatInfo(file, {}, true, { test(text) { visited.push(text); return matching.test(text); } });
    assert.equal(result.chat_items, 4);
    assert.equal(result.mes, '\ufffd final');
    assert.equal(result.match, true);
    assert.deepEqual(visited, ['ALPHA 魔女🙂', 'beta']);
    assert.equal((await getChatInfo(file, {}, false, createChatSearchMatcher(['\ufffd final']))).match, true);
    assert.equal((await getChatInfo(file, {}, false, createChatSearchMatcher(['metadata']))).match, false);
});

test('multi-megabyte metadata and final messages span many chunks without losing text', async (t) => {
    const root = await directory(t);
    const open = fs.createReadStream;
    t.mock.method(fs, 'createReadStream', (file, options) => open(file, { ...options, highWaterMark: 4096 }));
    const file = path.join(root, 'long.jsonl');
    const longText = '汉字🙂'.repeat(256 * 1024);
    await fs.promises.writeFile(file, JSON.stringify({ chat_metadata: { note: longText } }) + '\r\n' + message('early match') + '\n' + message(longText));
    const result = await getChatInfo(file, {}, true, createChatSearchMatcher(['early']));
    assert.equal(result.chat_items, 2);
    assert.equal(result.mes, longText);
    assert.equal(result.chat_metadata.note, longText);
    assert.equal(result.match, true);
});

test('a throwing matcher closes the stream and leaves summary reads usable', async (t) => {
    const root = await directory(t);
    const file = path.join(root, 'retry.jsonl');
    await fs.promises.writeFile(file, header + '\n' + message('first') + '\n' + message('last'));
    const open = fs.createReadStream;
    const opened = [];
    t.mock.method(fs, 'createReadStream', (...args) => {
        const stream = open(...args);
        opened.push(stream);
        return stream;
    });
    const failure = new Error('matcher failure');
    await assert.rejects(getChatInfo(file, {}, false, { test() { throw failure; } }), failure);
    assert.ok(opened.every(stream => stream.closed));
    assert.equal((await getChatInfo(file)).mes, 'last');
    assert.ok(opened.every(stream => stream.closed));
});
