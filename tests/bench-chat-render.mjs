import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

const baseURL = process.env.ST_BASE_URL || 'http://127.0.0.1:18348';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ baseURL, viewport: { width: 1280, height: 900 } });
for (const [module, sourcePath] of [['tags', process.env.BENCHMARK_TAGS_SOURCE], ['keyboard', process.env.BENCHMARK_KEYBOARD_SOURCE]]) {
    if (sourcePath) {
        const body = await fs.readFile(sourcePath, 'utf8');
        await page.route(`**/scripts/${module}.js`, route => route.fulfill({ contentType: 'text/javascript', body }));
    }
}
await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
await page.route('**/api/settings/get', async route => {
    const response = await route.fetch();
    const data = await response.json();
    const settings = JSON.parse(data.settings);
    settings.firstRun = false;
    settings.power_user = { ...settings.power_user, chat_truncation: 0, pin_styles: false };
    data.settings = JSON.stringify(settings);
    await route.fulfill({ response, json: data });
});

try {
    await testSetup.awaitST({ page });
    // APP_READY renders the welcome messages after the initialization overlay
    // disappears. Let that finish before replacing the chat with a fixture.
    await page.locator('#chat .mes[type="welcome_prompt"]').waitFor();
    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');
    await page.evaluate(async () => {
        const st = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        const tagsModule = await import('/scripts/tags.js');
        power_user.chat_truncation = 0;
        power_user.pin_styles = false;
        const makeMessages = count => Array.from({ length: count }, (_, id) => ({
            name: id % 2 ? 'Assistant' : 'User',
            is_user: id % 2 === 0,
            is_system: false,
            send_date: '2026-10-22T10:00:00.000Z',
            mes: `Message ${id}: **A long conversation** with a distinct sentence.\n\nWe discuss the route through the forest, the weather, and the next town. The path crosses a stream and passes a quiet field. This is ordinary prose with *emphasis* and an inline \`value\`.`,
            extra: {},
        }));
        window.chatRenderBenchmark = { st, tagsModule, makeMessages };
    });

    const results = [];
    const counts = (process.env.BENCHMARK_COUNTS || '100,500,1000,2000').split(',').map(Number);
    for (const count of counts) {
        await page.evaluate(() => document.getElementById('chat').replaceChildren());
        const before = await client.send('Performance.getMetrics');
        if (count === 1000) {
            await client.send('Profiler.enable');
            await client.send('Profiler.start');
        }
        const timings = await page.evaluate(async count => {
            const { st, tagsModule, makeMessages } = window.chatRenderBenchmark;
            st.chat.splice(0, st.chat.length, ...makeMessages(count));
            const started = performance.now();
            await st.redisplayChat({ fade: false });
            const renderMs = performance.now() - started;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const visibleMs = performance.now() - started;
            const tagMs = [];
            const ids = Array.from({ length: count }, (_, index) => index);
            for (let i = 0; i < 3; i++) {
                const tagStart = performance.now();
                tagsModule.applyCharacterTagsToMessageDivs({ mesIds: ids });
                tagMs.push(performance.now() - tagStart);
            }
            return { renderMs, visibleMs, tagMs, messageCount: document.querySelectorAll('#chat > .mes').length };
        }, count);
        if (timings.messageCount !== count) {
            throw new Error(`Expected ${count} messages, rendered ${timings.messageCount}`);
        }
        if (count === 1000) {
            const { profile } = await client.send('Profiler.stop');
            await fs.writeFile(process.env.PROFILE_PATH || '/tmp/csillytavern-chat-render.cpuprofile', JSON.stringify(profile));
        }
        const after = await client.send('Performance.getMetrics');
        const delta = Object.fromEntries(after.metrics.map(({ name, value }) => [name, value - (before.metrics.find(metric => metric.name === name)?.value ?? 0)]));
        results.push({ count, ...timings, layoutMs: delta.LayoutDuration * 1000, styleMs: delta.RecalcStyleDuration * 1000, taskMs: delta.TaskDuration * 1000 });
        console.log(JSON.stringify(results.at(-1)));
    }
    await fs.writeFile(process.env.BENCHMARK_OUTPUT || '/tmp/csillytavern-chat-render-benchmark.json', JSON.stringify({ baseURL, results }, null, 2));
} finally {
    await browser.close();
}
