import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { imageSize } from 'image-size';
import { setConfigFilePath } from '../src/util.js';
import '../src/fetch-patch.js';
import { createThumbnailDirectories, serveThumbnails, thumbnailPng, thumbnailWebp } from './util/thumbnail-fixture.mjs';

process.env.SILLYTAVERN_THUMBNAILS_FORMAT = 'png';
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { generateThumbnail, publicRouter } = await import('../src/endpoints/thumbnails.js');
const { Jimp } = await import('../src/jimp.js');

async function setup(t) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-thumbnail-header-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const directories = await createThumbnailDirectories(root);
    const server = await serveThumbnails(publicRouter, directories);
    t.after(server.close);
    return { directories, server };
}

function watchReads(t, file, { maxRead = Infinity, readError = false, openError = false } = {}) {
    const original = { open: fs.openSync, read: fs.readSync, close: fs.closeSync, readFile: fs.readFileSync };
    const descriptors = new Set();
    const counts = { opened: 0, closed: 0, headerBytes: 0, fullReads: 0, fullBytes: 0 };
    let insideFullRead = false;
    t.mock.method(fs, 'openSync', function (name, ...args) {
        if (String(name) === file && openError) throw Object.assign(new Error('Synthetic open failure'), { code: 'EACCES' });
        const descriptor = original.open.call(this, name, ...args);
        if (String(name) === file && !insideFullRead) {
            descriptors.add(descriptor);
            counts.opened++;
        }
        return descriptor;
    });
    t.mock.method(fs, 'readSync', function (descriptor, buffer, offset, length, position) {
        if (descriptors.has(descriptor)) {
            if (readError) throw Object.assign(new Error('Synthetic read failure'), { code: 'EIO' });
            const count = original.read.call(this, descriptor, buffer, offset, Math.min(length, maxRead), position);
            counts.headerBytes += count;
            return count;
        }
        return original.read.call(this, descriptor, buffer, offset, length, position);
    });
    t.mock.method(fs, 'closeSync', function (descriptor) {
        if (descriptors.delete(descriptor)) counts.closed++;
        return original.close.call(this, descriptor);
    });
    t.mock.method(fs, 'readFileSync', function (name, ...args) {
        insideFullRead = true;
        try {
            const result = original.readFile.call(this, name, ...args);
            if (String(name) === file) {
                counts.fullReads++;
                counts.fullBytes += result.length;
            }
            return result;
        } finally {
            insideFullRead = false;
        }
    });
    return counts;
}

test('animated PNG and WebP HTTP responses preserve originals without a full probe read', async (t) => {
    const { directories, server } = await setup(t);
    const readImage = t.mock.method(Jimp, 'read', () => { throw new Error('Animated images must not be decoded'); });
    for (const [name, source] of [['animated.png', thumbnailPng({ animated: true, paddingBytes: 4096 })], ['animated.webp', thumbnailWebp(4096)]]) {
        await t.test(name, async (t) => {
            const file = path.join(directories.backgrounds, name);
            await fs.promises.writeFile(file, source);
            const counts = watchReads(t, file);
            const response = await server.request(name);
            assert.equal(response.status, 200);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), source);
            assert.deepEqual(counts, { opened: 1, closed: 1, headerBytes: 200, fullReads: 0, fullBytes: 0 });
            assert.equal(fs.existsSync(path.join(directories.thumbnailsBg, name)), false);
        });
    }
    assert.equal(readImage.mock.callCount(), 0);
});

test('static PNG and WebP HTTP generation read their pixels once, then serve cached thumbnails', async (t) => {
    const { directories, server } = await setup(t);
    const png = thumbnailPng({ paddingBytes: 4096 });
    const webp = await (await Jimp.read(png)).getBuffer('image/webp');
    for (const [name, source] of [['static.png', png], ['static.webp', webp]]) {
        await t.test(name, async (t) => {
            const file = path.join(directories.backgrounds, name);
            await fs.promises.writeFile(file, source);
            const counts = watchReads(t, file);
            const first = await server.request(name);
            assert.equal(first.status, 200);
            const thumbnail = Buffer.from(await first.arrayBuffer());
            assert.equal(imageSize(thumbnail).width, 120);
            assert.equal(imageSize(thumbnail).height, 120);
            assert.deepEqual(counts, { opened: 1, closed: 1, headerBytes: Math.min(source.length, 200), fullReads: 1, fullBytes: source.length });
            const second = await server.request(name);
            assert.equal(second.status, 200);
            assert.deepEqual(Buffer.from(await second.arrayBuffer()), thumbnail);
            assert.equal(counts.opened, 1);
            assert.equal(counts.fullReads, 1);
        });
    }
});

test('short header reads preserve the exact 200-byte detector boundary', async (t) => {
    const { directories } = await setup(t);
    for (const [marker, extension] of [['acTL', 'png'], ['ANIM', 'webp'], ['ANMF', 'webp']]) {
        for (const offset of [196, 197]) {
            await t.test(`${marker} at ${offset}`, async (t) => {
                const name = `boundary-${marker}-${offset}.${extension}`;
                const file = path.join(directories.backgrounds, name);
                const source = Buffer.alloc(256);
                source.write(marker, offset);
                await fs.promises.writeFile(file, source);
                const counts = watchReads(t, file, { maxRead: 7 });
                const decoder = t.mock.method(Jimp, 'read', () => { throw new Error('Deliberately invalid static fixture'); });
                t.mock.method(console, 'warn', () => {});
                t.mock.method(console, 'error', () => {});
                assert.equal((await generateThumbnail(directories, 'bg', name)).path, null);
                assert.equal(counts.headerBytes, 200);
                assert.equal(counts.opened, counts.closed);
                assert.equal(decoder.mock.callCount(), offset === 196 ? 0 : 1);
            });
        }
    }
});

test('empty and truncated files close the probe descriptor and retain failure fallback', async (t) => {
    const { directories } = await setup(t);
    for (const size of [0, 3, 199]) {
        await t.test(`${size} bytes`, async (t) => {
            const name = `short-${size}.png`;
            const file = path.join(directories.backgrounds, name);
            await fs.promises.writeFile(file, Buffer.alloc(size));
            const counts = watchReads(t, file, { maxRead: 7 });
            t.mock.method(Jimp, 'read', () => { throw new Error('Invalid short image'); });
            t.mock.method(console, 'warn', () => {});
            t.mock.method(console, 'error', () => {});
            assert.equal((await generateThumbnail(directories, 'bg', name)).path, null);
            assert.equal(counts.headerBytes, size);
            assert.equal(counts.opened, 1);
            assert.equal(counts.closed, 1);
        });
    }
});

test('read errors close the descriptor and HTTP falls back to the original image', async (t) => {
    const { directories, server } = await setup(t);
    const name = 'read-error.png';
    const file = path.join(directories.backgrounds, name);
    const source = thumbnailPng();
    await fs.promises.writeFile(file, source);
    const counts = watchReads(t, file, { readError: true });
    t.mock.method(console, 'error', () => {});
    const response = await server.request(name);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), source);
    assert.deepEqual(counts, { opened: 1, closed: 1, headerBytes: 0, fullReads: 0, fullBytes: 0 });
});

test('open errors preserve the original-image fallback without closing an unrelated descriptor', async (t) => {
    const { directories, server } = await setup(t);
    const name = 'open-error.png';
    const file = path.join(directories.backgrounds, name);
    const source = thumbnailPng();
    await fs.promises.writeFile(file, source);
    const counts = watchReads(t, file, { openError: true });
    t.mock.method(console, 'error', () => {});
    const response = await server.request(name);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), source);
    assert.deepEqual(counts, { opened: 0, closed: 0, headerBytes: 0, fullReads: 0, fullBytes: 0 });
});

test('known animation flags preserve their existing probe bypass', async (t) => {
    const { directories } = await setup(t);
    const name = 'known-static.png';
    const file = path.join(directories.backgrounds, name);
    const source = thumbnailPng();
    await fs.promises.writeFile(file, source);
    const counts = watchReads(t, file);
    assert.equal((await generateThumbnail(directories, 'bg', name, false, true)).path, null);
    assert.deepEqual(counts, { opened: 0, closed: 0, headerBytes: 0, fullReads: 0, fullBytes: 0 });
    assert.ok((await generateThumbnail(directories, 'bg', name, false, false)).path);
    assert.equal(counts.opened, 0);
    assert.equal(counts.fullReads, 1);
});
