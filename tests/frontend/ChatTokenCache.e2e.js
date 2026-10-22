import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.beforeEach(async ({ page }) => {
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        data.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: data });
    });
    await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
    await testSetup.awaitST({ page });
    await page.locator('#chat .mes[type="welcome_prompt"]').waitFor();
});

test('tokenizer counts persist per chat and reload after LRU eviction', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/tokenizers/gpt2/encode', route => route.fulfill({ json: { count: ++calls } }));
    const result = await page.evaluate(async () => {
        const script = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        const { getTokenCountAsync, saveTokenCache, tokenizers } = await import('/scripts/tokenizers.js');
        const { TOKEN_CACHE_PREFIX } = await import('/scripts/util/chat-token-cache.js');
        const { localforage } = await import('/lib.js');
        const store = localforage.createInstance({ name: 'SillyTavern_ChatCompletions' });
        script.changeMainAPI('kobold');
        power_user.tokenizer = tokenizers.GPT2;
        const index = script.characters.length;
        script.characters.push({ chat: 'partition-0' });
        script.setCharacterId(index);
        const counts = [];
        for (let i = 0; i < 7; i++) {
            script.characters[index].chat = `partition-${i}`;
            counts.push(await getTokenCountAsync('same text across separate chats'));
            await saveTokenCache();
        }
        script.characters[index].chat = 'partition-0';
        const again = await getTokenCountAsync('same text across separate chats');
        const persisted = await Promise.all(Array.from({ length: 7 }, (_, i) => store.getItem(TOKEN_CACHE_PREFIX + `partition-${i}`)));
        return { counts, again, persisted: persisted.map(bucket => Object.values(bucket)) };
    });
    expect(result.counts).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.again).toBe(1);
    expect(result.persisted).toEqual([[1], [2], [3], [4], [5], [6], [7]]);
    expect(calls).toBe(7);
});

test('pending tokenizer results stay with their original chat after navigation', async ({ page }) => {
    let finishFirst;
    const firstSeen = new Promise(resolve => { finishFirst = resolve; });
    let delayedRoute;
    await page.route('**/api/tokenizers/gpt2/encode', async route => {
        if (route.request().postDataJSON().text === 'first chat pending') {
            delayedRoute = route;
            finishFirst();
        } else await route.fulfill({ json: { count: 22 } });
    });
    await page.evaluate(async () => {
        const script = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        const tokenizer = await import('/scripts/tokenizers.js');
        script.changeMainAPI('kobold');
        power_user.tokenizer = tokenizer.tokenizers.GPT2;
        const index = script.characters.length;
        script.characters.push({ chat: 'pending-a' });
        script.setCharacterId(index);
        window.pendingTokenCount = tokenizer.getTokenCountAsync('first chat pending');
    });
    await firstSeen;
    const second = await page.evaluate(async () => {
        const script = await import('/script.js');
        script.characters[script.this_chid].chat = 'pending-b';
        return (await import('/scripts/tokenizers.js')).getTokenCountAsync('second chat immediate');
    });
    await delayedRoute.fulfill({ json: { count: 11 } });
    const stored = await page.evaluate(async () => {
        const first = await window.pendingTokenCount;
        await (await import('/scripts/tokenizers.js')).saveTokenCache();
        const { TOKEN_CACHE_PREFIX } = await import('/scripts/util/chat-token-cache.js');
        const { localforage } = await import('/lib.js');
        const store = localforage.createInstance({ name: 'SillyTavern_ChatCompletions' });
        return { first, a: Object.values(await store.getItem(TOKEN_CACHE_PREFIX + 'pending-a')), b: Object.values(await store.getItem(TOKEN_CACHE_PREFIX + 'pending-b')) };
    });
    expect(second).toBe(22);
    expect(stored).toEqual({ first: 11, a: [11], b: [22] });
});

test('startup never deserializes the monolithic legacy cache and eventually removes it', async ({ page }) => {
    await page.evaluate(async () => {
        const { localforage } = await import('/lib.js');
        const store = localforage.createInstance({ name: 'SillyTavern_ChatCompletions' });
        await store.setItem('tokenCache', { legacyChat: { count: 123 } });
        await store.setItem('unrelated-cache', { keep: true });
    });
    await page.addInitScript(() => {
        window.legacyCacheReads = 0;
        const get = IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get = function (key) {
            if (key === 'tokenCache') window.legacyCacheReads++;
            return get.call(this, key);
        };
    });
    await testSetup.awaitST({ page });
    const result = await page.evaluate(async () => {
        const reads = window.legacyCacheReads;
        const { localforage } = await import('/lib.js');
        const store = localforage.createInstance({ name: 'SillyTavern_ChatCompletions' });
        return { reads, unrelated: await store.getItem('unrelated-cache') };
    });
    expect(result).toEqual({ reads: 0, unrelated: { keep: true } });
    await expect.poll(() => page.evaluate(async () => {
        const { localforage } = await import('/lib.js');
        return localforage.createInstance({ name: 'SillyTavern_ChatCompletions' }).getItem('tokenCache');
    })).toBeNull();
});

test('cache loading cannot switch the model or remote server of an already requested count', async ({ page }) => {
    const requests = [];
    await page.route('**/api/tokenizers/**', route => {
        requests.push({ path: new URL(route.request().url()).pathname, model: new URL(route.request().url()).searchParams.get('model'), payload: route.request().postDataJSON() });
        return route.fulfill({ json: { count: 17, token_count: 17 } });
    });
    const result = await page.evaluate(async () => {
        const script = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        const { oai_settings, chat_completion_sources } = await import('/scripts/openai.js');
        const { kai_settings } = await import('/scripts/kai-settings.js');
        const { getTokenCountAsync, countTokensOpenAIAsync, saveTokenCache, tokenizers } = await import('/scripts/tokenizers.js');
        const { localforage } = await import('/lib.js');
        const { TOKEN_CACHE_PREFIX } = await import('/scripts/util/chat-token-cache.js');
        const index = script.characters.length;
        script.characters.push({ chat: 'connection-capture' });
        script.setCharacterId(index);
        oai_settings.chat_completion_source = chat_completion_sources.OPENAI;
        oai_settings.openai_model = 'model-before-cache-load';
        const openai = countTokensOpenAIAsync([{ content: 'first' }, { content: 'second' }], true);
        oai_settings.openai_model = 'model-after-cache-load';
        script.changeMainAPI('kobold');
        power_user.tokenizer = tokenizers.API_CURRENT;
        kai_settings.api_server = 'http://before-cache-load.invalid';
        const remote = getTokenCountAsync('captured remote');
        kai_settings.api_server = 'http://after-cache-load.invalid';
        const values = await Promise.all([openai, remote]);
        await saveTokenCache();
        const stored = await localforage.createInstance({ name: 'SillyTavern_ChatCompletions' }).getItem(TOKEN_CACHE_PREFIX + 'connection-capture');
        return { values, keys: Object.keys(stored) };
    });
    expect(result.values).toEqual([34, 17]);
    expect(requests.filter(x => x.path === '/api/tokenizers/openai/count').map(x => x.model)).toEqual(['model-before-cache-load', 'model-before-cache-load']);
    expect(requests.find(x => x.path === '/api/tokenizers/remote/kobold/count').payload).toEqual({ text: 'captured remote', url: 'http://before-cache-load.invalid' });
    expect(result.keys.filter(key => key.startsWith('model-before-cache-load-'))).toHaveLength(2);
    expect(result.keys.some(key => key.startsWith('model-after-cache-load-'))).toBe(false);
});
