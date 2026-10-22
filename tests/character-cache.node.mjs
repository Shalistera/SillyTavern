import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCharacterCacheFixture, serveCharacterRouter } from './util/character-cache-fixture.mjs';
import { write } from '../src/character-card-parser.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE = 'true';
process.env.SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS = 'false';

async function setup(t, options = {}, capacity = '100mb') {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-character-cache-'));
    globalThis.DATA_ROOT = root;
    process.env.SILLYTAVERN_PERFORMANCE_MEMORYCACHECAPACITY = capacity;
    const fixture = await createCharacterCacheFixture(root, options);
    const module = await import(`../src/endpoints/characters.js?cache-test=${encodeURIComponent(root)}`);
    const server = await serveCharacterRouter(module.router, fixture.directories);
    const cache = await module.diskCache.instance();
    const originalReadFile = fs.readFile;
    let cacheReads = 0;
    t.mock.method(fs, 'readFile', function (file, ...args) {
        if (String(file).startsWith(fixture.cacheDirectory + path.sep)) cacheReads++;
        return originalReadFile.call(this, file, ...args);
    });
    t.after(async () => {
        await server.close();
        module.diskCache.dispose();
        cache.stopWriteQueueInterval();
        await fs.promises.rm(root, { recursive: true, force: true });
    });
    return { ...fixture, root, server, reads: () => cacheReads };
}

test('persisted character metadata is reused in memory after its first HTTP read', async t => {
    const fixture = await setup(t, { count: 3 });
    const first = await fixture.server.request();
    assert.equal(first.length, 3);
    assert.equal(fixture.reads(), 3);
    const second = await fixture.server.request();
    assert.deepEqual(second, first);
    assert.equal(fixture.reads(), 3, 'unchanged cards must not reread their disk-cache entries');
    const selected = await fixture.server.request('/get', { avatar_url: 'card-1.png' });
    assert.equal(selected.name, 'test-user 1');
    assert.equal(selected.description, fixture.cards[1].card.data.description);
    assert.equal(fixture.reads(), 3);
});

test('editing a cached card invalidates the promoted metadata', async t => {
    const fixture = await setup(t);
    assert.equal((await fixture.server.request())[0].name, 'test-user 0');
    const card = fixture.cards[0];
    card.card.name = card.card.data.name = 'Updated character';
    await fs.promises.writeFile(card.file, write(await fs.promises.readFile(card.file), JSON.stringify(card.card)));
    const updatedTime = new Date(Date.now() + 1000);
    await fs.promises.utimes(card.file, updatedTime, updatedTime);
    const updated = await fixture.server.request('/get', { avatar_url: 'card-0.png' });
    assert.equal(updated.name, 'Updated character');
    assert.equal((await fixture.server.request())[0].name, 'Updated character');
});

test('equal avatar filenames in separate user directories retain separate metadata', async t => {
    const fixture = await setup(t);
    const other = await createCharacterCacheFixture(fixture.root, { user: 'another-user' });
    const module = await import(`../src/endpoints/characters.js?cache-test=${encodeURIComponent(fixture.root)}`);
    const server = await serveCharacterRouter(module.router, other.directories);
    t.after(() => server.close());
    assert.equal((await fixture.server.request())[0].name, 'test-user 0');
    assert.equal((await server.request())[0].name, 'another-user 0');
    assert.equal((await fixture.server.request())[0].name, 'test-user 0');
});

for (const [capacity, textLength] of [['0', 1024], ['1kb', 2048]]) {
    test(`disk hits respect the ${capacity} memory budget`, async t => {
        const fixture = await setup(t, { textLength }, capacity);
        const first = await fixture.server.request();
        assert.equal(first[0].description.length, textLength);
        assert.deepEqual(await fixture.server.request(), first);
        assert.equal(fixture.reads(), 2, 'disabled or oversized memory entries must remain disk-backed');
    });
}
