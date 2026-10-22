import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { read, write } from '../../src/character-card-parser.js';

export async function createCharacterCacheFixture(root, { count = 1, textLength = 1024, user = 'test-user' } = {}) {
    const directories = Object.fromEntries(['characters', 'chats', 'worlds'].map(name => [name, path.join(root, user, name)]));
    await Promise.all(Object.values(directories).map(directory => fs.mkdir(directory, { recursive: true })));
    const cacheDirectory = path.join(root, '_cache', 'characters');
    await fs.mkdir(cacheDirectory, { recursive: true });
    const avatar = await fs.readFile(new URL('../../public/img/ai4.png', import.meta.url));
    const cards = [];
    for (let index = 0; index < count; index++) {
        const name = `${user} ${index}`;
        const data = {
            name, description: 'x'.repeat(textLength), personality: '', scenario: '', first_mes: 'Hello', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
            tags: ['fixture'], creator: '', character_version: '', extensions: { fav: false, talkativeness: 0.5 },
        };
        const card = { spec: 'chara_card_v2', spec_version: '2.0', name, chat: 'fixture-chat', create_date: '2026-01-01T00:00:00.000Z', data };
        const file = path.join(directories.characters, `card-${index}.png`);
        const png = write(avatar, JSON.stringify(card));
        // Seed exactly what the normal PNG parser would persist, including the
        // preferred ccv3 chunk emitted by the card writer.
        const serialized = read(png);
        await fs.writeFile(file, png);
        const key = `${file}-${(await fs.stat(file)).mtimeMs}`;
        const cachedFile = path.join(cacheDirectory, createHash('sha256').update(key).digest('hex'));
        await fs.writeFile(cachedFile, JSON.stringify({ key, value: serialized }));
        cards.push({ file, cachedFile, card, serialized });
    }
    return { directories, cards, cacheDirectory };
}

export async function serveCharacterRouter(router, directories) {
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
        request.user = { profile: { handle: 'test-user' }, directories };
        next();
    });
    app.use('/api/characters', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return {
        async request(route = '/all', body = {}) {
            const response = await fetch(`${origin}/api/characters${route}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error(`Character request failed: ${response.status}`);
            return response.json();
        },
        close: () => new Promise(resolve => server.close(resolve)),
    };
}
