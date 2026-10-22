import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import express from 'express';
import encodePng from '../../src/png/encode.js';

/** Valid one-pixel PNG, optionally with an APNG frame and a large ancillary chunk. */
export function thumbnailPng({ animated = false, paddingBytes = 0 } = {}) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const chunks = [{ name: 'IHDR', data: header }];
    if (animated) {
        const control = Buffer.alloc(8);
        control.writeUInt32BE(1, 0);
        const frame = Buffer.alloc(26);
        frame.writeUInt32BE(1, 4);
        frame.writeUInt32BE(1, 8);
        frame.writeUInt16BE(1, 20);
        frame.writeUInt16BE(10, 22);
        chunks.push({ name: 'acTL', data: control }, { name: 'fcTL', data: frame });
    }
    if (paddingBytes > 0) {
        // Private ancillary chunks are skipped by image decoders. Keep each
        // chunk below the WASM decoder's per-chunk allocation limit.
        for (let remaining = paddingBytes; remaining > 0; remaining -= 262144) {
            chunks.push({ name: 'stAg', data: Buffer.alloc(Math.min(remaining, 262144), 65) });
        }
    }
    chunks.push({ name: 'IDAT', data: deflateSync(Buffer.from([0, 255, 0, 0, 255])) });
    chunks.push({ name: 'IEND', data: Buffer.alloc(0) });
    return Buffer.from(encodePng(chunks));
}

/** Header-only synthetic animated WebP; decoding is deliberately bypassed. */
export function thumbnailWebp(size = 256) {
    const data = Buffer.alloc(Math.max(size, 44));
    data.write('RIFF');
    data.writeUInt32LE(data.length - 8, 4);
    data.write('WEBPVP8X', 8);
    data.writeUInt32LE(10, 16);
    data[20] = 2;
    data.write('ANIM', 30);
    data.writeUInt32LE(6, 34);
    return data;
}

export async function createThumbnailDirectories(root) {
    const directories = Object.fromEntries([
        'backgrounds', 'characters', 'avatars', 'thumbnailsBg', 'thumbnailsAvatar', 'thumbnailsPersona',
    ].map(key => [key, path.join(root, key)]));
    await Promise.all(Object.values(directories).map(directory => fs.mkdir(directory, { recursive: true })));
    return directories;
}

export async function serveThumbnails(router, directories) {
    const app = express();
    app.use((request, response, next) => {
        request.user = { directories };
        next();
    });
    app.use('/thumbnail', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    return {
        request: (file, type = 'bg') => fetch(`http://127.0.0.1:${server.address().port}/thumbnail?${new URLSearchParams({ file, type })}`),
        close: () => new Promise(resolve => server.close(resolve)),
    };
}
