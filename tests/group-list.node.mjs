import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { router } from '../src/endpoints/groups.js';
import { createGroupListFixture, serveGroupRouter } from './util/group-list-fixture.mjs';

async function setup(t, options) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-group-list-'));
    const directories = await createGroupListFixture(root, options);
    const server = await serveGroupRouter(router, directories);
    t.after(async () => {
        await server.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    });
    return { root, directories, server };
}

// Retain the original directory-order membership algorithm as a compatibility
// oracle. The optimized route must produce the same public JSON response.
function referenceGroups(directories) {
    const chats = fs.readdirSync(directories.groupChats).filter(file => path.extname(file) === '.jsonl');
    return fs.readdirSync(directories.groups).filter(file => path.extname(file) === '.json').map(file => {
        const filePath = path.join(directories.groups, file);
        const group = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const stat = fs.statSync(filePath);
        group.date_added = stat.birthtimeMs;
        group.create_date = new Date(stat.birthtimeMs).toISOString();
        group.chat_size = 0;
        group.date_last_chat = 0;
        if (Array.isArray(group.chats)) {
            for (const chat of chats) {
                if (group.chats.includes(path.parse(chat).name)) {
                    const chatStat = fs.statSync(path.join(directories.groupChats, chat));
                    group.chat_size += chatStat.size;
                    group.date_last_chat = Math.max(group.date_last_chat, chatStat.mtimeMs);
                }
            }
        }
        return group;
    });
}

async function writeGroup(directories, id, chats) {
    await fs.promises.writeFile(path.join(directories.groups, `${id}.json`), JSON.stringify({ id, name: id, chats }));
}

test('HTTP groups preserve directory order, strict IDs, extensions and duplicate-reference semantics', async t => {
    const { directories, server } = await setup(t);
    for (const name of ['a.jsonl', 'story.v1.jsonl', 'story.v1.JSONL', 'story.v1.jsonl.bak', '__proto__.jsonl', '.hidden.jsonl', '.jsonl', 'name.jsonl.jsonl', '1.jsonl']) {
        await fs.promises.writeFile(path.join(directories.groupChats, name), `Contents of ${name}`);
    }
    // The old route includes matching directory entries too; do not silently
    // narrow it to regular files during the indexing optimization.
    await fs.promises.mkdir(path.join(directories.groupChats, 'directory.jsonl'));
    await writeGroup(directories, 'z-last', ['story.v1', 'a', 'a', 'missing', '__proto__', '.hidden', '', 'name.jsonl', 1, null, {}, ['a'], 'directory']);
    await writeGroup(directories, 'a-first', ['1', 'a', 'story.v1.jsonl.bak']);
    await writeGroup(directories, 'no-array', 'a');
    const readDirectory = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (directory, ...args) => {
        const entries = readDirectory(directory, ...args);
        return directory === directories.groups || directory === directories.groupChats ? entries.reverse() : entries;
    });
    const stat = fs.statSync;
    const statOrder = [];
    t.mock.method(fs, 'statSync', (file, ...args) => {
        if (String(file).startsWith(directories.groupChats + path.sep)) statOrder.push(path.basename(file));
        return stat(file, ...args);
    });
    const expected = referenceGroups(directories);
    const expectedStats = [...new Set(statOrder)];
    statOrder.length = 0;
    assert.deepEqual(await server.request(), expected);
    assert.deepEqual(statOrder, expectedStats);
});

test('shared group chats are statted once per HTTP request, and never retained between requests', async t => {
    const { directories, server } = await setup(t, { groups: 4, chatsPerGroup: 2, sharedChats: 3 });
    const expected = referenceGroups(directories);
    const stat = fs.statSync;
    let chatStats = 0;
    t.mock.method(fs, 'statSync', (file, ...args) => {
        if (String(file).startsWith(directories.groupChats + path.sep)) chatStats++;
        return stat(file, ...args);
    });
    assert.deepEqual(await server.request(), expected);
    assert.equal(chatStats, 11);
    assert.deepEqual(await server.request(), expected);
    assert.equal(chatStats, 22);
});

test('edits, additions, rename and deletion are visible in the next group list', async t => {
    const { directories, server } = await setup(t, { groups: 2, sharedChats: 1 });
    await server.request();
    const chat = path.join(directories.groupChats, 'shared-0.jsonl');
    const originalStat = await fs.promises.stat(chat);
    await fs.promises.writeFile(chat, 'changed contents with a different size');
    await fs.promises.utimes(chat, originalStat.atime, originalStat.mtime);
    assert.deepEqual(await server.request(), referenceGroups(directories));
    await fs.promises.rename(chat, path.join(directories.groupChats, 'renamed.jsonl'));
    await writeGroup(directories, 'group-00000', ['renamed', 'new']);
    await fs.promises.writeFile(path.join(directories.groupChats, 'new.jsonl'), 'new chat');
    assert.deepEqual(await server.request(), referenceGroups(directories));
    await fs.promises.unlink(path.join(directories.groupChats, 'renamed.jsonl'));
    await fs.promises.unlink(path.join(directories.groupChats, 'new.jsonl'));
    const empty = await server.request();
    assert.deepEqual(empty, referenceGroups(directories));
    assert.ok(empty.every(group => group.chat_size === 0 && group.date_last_chat === 0));
});

test('a failed chat stat skips that group without poisoning later groups or requests', async t => {
    const { directories, server } = await setup(t);
    await fs.promises.writeFile(path.join(directories.groupChats, 'shared.jsonl'), 'shared chat');
    await writeGroup(directories, 'a-fails', ['shared']);
    await writeGroup(directories, 'b-recovers', ['shared']);
    await writeGroup(directories, 'c-empty', []);
    await fs.promises.writeFile(path.join(directories.groups, 'd-malformed.json'), '{broken');
    t.mock.method(console, 'error', () => {});
    const stat = fs.statSync;
    let fail = true;
    let chatStats = 0;
    t.mock.method(fs, 'statSync', (file, ...args) => {
        if (String(file).startsWith(directories.groupChats + path.sep)) {
            chatStats++;
            if (fail) {
                fail = false;
                throw Object.assign(new Error('temporarily unreadable'), { code: 'EACCES' });
            }
        }
        return stat(file, ...args);
    });
    assert.deepEqual((await server.request()).map(group => group.id), ['b-recovers', 'c-empty']);
    assert.equal(chatStats, 2, 'A failed stat must be retried for another group');
    assert.deepEqual((await server.request()).map(group => group.id), ['a-fails', 'b-recovers', 'c-empty']);
    assert.equal(chatStats, 3);
});

test('groups and chat IDs shared by separate user directories remain isolated', async t => {
    const { root, directories, server } = await setup(t, { groups: 1, sharedChats: 1 });
    const otherDirectories = await createGroupListFixture(root, { groups: 1, sharedChats: 1, user: 'another-user' });
    await fs.promises.writeFile(path.join(otherDirectories.groupChats, 'shared-0.jsonl'), 'another user');
    const other = await serveGroupRouter(router, otherDirectories);
    t.after(() => other.close());
    const first = await server.request();
    const second = await other.request();
    assert.deepEqual(first, referenceGroups(directories));
    assert.deepEqual(second, referenceGroups(otherDirectories));
    assert.notEqual(first[0].chat_size, second[0].chat_size);
    assert.deepEqual(await server.request(), first);
});
