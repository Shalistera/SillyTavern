// Isolated Chromium + real IndexedDB comparison. No application/user storage is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';

const chats = Number(process.env.BENCHMARK_CHATS || 500);
const counts = Number(process.env.BENCHMARK_COUNTS || 1000);
const rounds = Number(process.env.BENCHMARK_ROUNDS || 7);
assert.ok([chats, counts, rounds].every(x => Number.isSafeInteger(x) && x > 0));
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ baseURL: process.env.ST_BASE_URL || 'http://127.0.0.1:18349' });
    await page.route('**/token-cache-benchmark', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated cache benchmark</title>' }));
    await page.goto('/token-cache-benchmark');
    const report = await page.evaluate(async ({ chats, counts, rounds }) => {
        const { localforage } = await import('/lib.js');
        const { ChatTokenCache, TOKEN_CACHE_PREFIX } = await import('/scripts/util/chat-token-cache.js');
        const store = localforage.createInstance({ name: 'SillyTavern_TokenCache_Benchmark' });
        const legacy = Object.create(null);
        for (let chat = 0; chat < chats; chat++) {
            const values = Object.fromEntries(Array.from({ length: counts }, (_, token) => [`1-${chat * counts + token}+0`, token]));
            legacy[`chat-${chat}`] = values;
            await store.setItem(TOKEN_CACHE_PREFIX + `chat-${chat}`, values);
        }
        await store.setItem('tokenCache', legacy);
        const wholeJsonBytes = new TextEncoder().encode(JSON.stringify(legacy)).length;
        const chatJsonBytes = new TextEncoder().encode(JSON.stringify(legacy['chat-0'])).length;
        const samples = [];
        try {
            for (let round = 0; round < rounds; round++) {
                for (const mode of round % 2 ? ['partitioned', 'monolithic'] : ['monolithic', 'partitioned']) {
                    const start = performance.now();
                    let loaded;
                    let cache;
                    let state;
                    if (mode === 'monolithic') loaded = await store.getItem('tokenCache');
                    else {
                        cache = new ChatTokenCache(store);
                        state = cache.acquire('chat-0');
                        await state.ready;
                        loaded = state.values;
                    }
                    const loadMs = performance.now() - start;
                    const valueCount = mode === 'monolithic' ? Object.values(loaded).reduce((sum, bucket) => sum + Object.keys(bucket).length, 0) : Object.keys(loaded).length;
                    if (valueCount !== (mode === 'monolithic' ? chats * counts : counts)) throw new Error('Wrong loaded count');
                    const writeStart = performance.now();
                    if (mode === 'monolithic') {
                        loaded['chat-0']['1-0+0'] = round;
                        await store.setItem('tokenCache', loaded);
                    } else {
                        cache.set(state, '1-0+0', round);
                        await cache.save();
                        cache.release(state);
                    }
                    const saveMs = performance.now() - writeStart;
                    samples.push({ round, mode, loadMs, saveMs, loadedCounts: valueCount });
                }
            }
            const old = await store.getItem('tokenCache');
            const current = await store.getItem(TOKEN_CACHE_PREFIX + 'chat-0');
            if (JSON.stringify(old['chat-0']) !== JSON.stringify(current)) throw new Error('Final active-chat counts differ');
            const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
            const summary = Object.fromEntries(['monolithic', 'partitioned'].map(mode => [mode, {
                loadMs: median(samples.filter(x => x.mode === mode).map(x => x.loadMs)),
                saveMs: median(samples.filter(x => x.mode === mode).map(x => x.saveMs)),
            }]));
            return { chats, counts, rounds, wholeJsonBytes, chatJsonBytes, summary, samples, scope: 'Real Chromium IndexedDB read/write of cached counts. Fixture setup excluded; storage/OS caches are warm. No claim about provider latency or entire application startup.' };
        } finally {
            await store.dropInstance();
        }
    }, { chats, counts, rounds });
    const output = process.env.BENCHMARK_OUTPUT || '/tmp/csilly-token-cache-benchmark.json';
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
} finally {
    await browser.close();
}
