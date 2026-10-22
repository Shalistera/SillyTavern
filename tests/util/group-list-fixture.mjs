import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

/** Synthetic groups and JSONL files; no application users or providers are used. */
export async function createGroupListFixture(root, { groups = 0, chatsPerGroup = 0, sharedChats = 0, user = 'fixture' } = {}) {
    const directories = { groups: path.join(root, user, 'groups'), groupChats: path.join(root, user, 'group-chats') };
    await Promise.all(Object.values(directories).map(directory => fs.mkdir(directory, { recursive: true })));
    const sharedIds = Array.from({ length: sharedChats }, (_, index) => `shared-${index}`);
    for (const id of sharedIds) await fs.writeFile(path.join(directories.groupChats, `${id}.jsonl`), chatContents(id));
    for (let index = 0; index < groups; index++) {
        const id = `group-${String(index).padStart(5, '0')}`;
        const chats = Array.from({ length: chatsPerGroup }, (_, chat) => `${id}-chat-${chat}`);
        for (const chat of chats) await fs.writeFile(path.join(directories.groupChats, `${chat}.jsonl`), chatContents(chat));
        await fs.writeFile(path.join(directories.groups, `${id}.json`), JSON.stringify({
            id, name: `Group ${index}`, members: ['Character.png'], chats: [...chats, ...sharedIds],
        }));
    }
    return directories;
}

function chatContents(id) {
    return JSON.stringify({ chat_metadata: {} }) + '\n'
        + JSON.stringify({ name: 'Character', mes: `Synthetic chat ${id}`, send_date: '2026-01-01' });
}

export async function serveGroupRouter(router, directories) {
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
        request.user = { directories };
        next();
    });
    app.use('/api/groups', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return {
        async request() {
            const response = await fetch(`${origin}/api/groups/all`, { method: 'POST' });
            if (!response.ok) throw new Error(`Group request failed: ${response.status}`);
            return response.json();
        },
        close: () => new Promise(resolve => server.close(resolve)),
    };
}
