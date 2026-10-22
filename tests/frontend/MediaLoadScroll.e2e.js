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
    await page.evaluate(async () => {
        const { scrollOnMediaLoad } = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.auto_scroll_chat_to_bottom = true;
        power_user.waifuMode = false;
        const chat = document.getElementById('chat');
        const block = document.createElement('div');
        block.className = 'mes_block';
        chat.replaceChildren(block);
        scrollOnMediaLoad();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let scrolls = 0;
        Object.defineProperty(chat, 'scrollTop', { configurable: true, get: () => 0, set: () => { scrolls++; } });
        const media = [];
        window.mediaScrollTest = {
            watch: scrollOnMediaLoad,
            clear: () => block.replaceChildren(),
            flush: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            snapshot: () => ({ scrolls, listeners: media.map(item => [...item.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0)) }),
            add(tag, ready = false) {
                const element = document.createElement(tag);
                Object.defineProperty(element, tag === 'img' ? 'complete' : 'readyState', { configurable: true, value: ready ? (tag === 'img' ? true : HTMLMediaElement.HAVE_CURRENT_DATA) : 0 });
                const listeners = new Map();
                const add = element.addEventListener;
                const remove = element.removeEventListener;
                element.addEventListener = function (type, callback, options) {
                    if (!listeners.has(type)) listeners.set(type, new Set());
                    listeners.get(type).add(callback);
                    add.call(this, type, callback, options);
                };
                element.removeEventListener = function (type, callback, options) {
                    listeners.get(type)?.delete(callback);
                    remove.call(this, type, callback, options);
                };
                media.push({ element, listeners });
                block.append(element);
                return media.length - 1;
            },
            fire(index, type) {
                media[index].element.dispatchEvent(new Event(type));
            },
            ready(index) {
                const element = media[index].element;
                Object.defineProperty(element, element instanceof HTMLImageElement ? 'complete' : 'readyState', { configurable: true, value: element instanceof HTMLImageElement ? true : HTMLMediaElement.HAVE_CURRENT_DATA });
            },
        };
    });
});

test('media settle once, release both listeners, and preserve loaded and empty chat scrolling', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const fixture = window.mediaScrollTest;
        fixture.add('img');
        fixture.add('video');
        fixture.add('audio', true);
        fixture.watch();
        const pending = fixture.snapshot();
        fixture.fire(0, 'load');
        fixture.fire(0, 'error');
        await fixture.flush();
        const oneLoaded = fixture.snapshot();
        fixture.fire(1, 'error');
        await fixture.flush();
        const complete = fixture.snapshot();
        fixture.fire(1, 'loadeddata');
        fixture.fire(1, 'error');
        await fixture.flush();
        const duplicate = fixture.snapshot();
        fixture.ready(0);
        fixture.ready(1);
        fixture.watch();
        await fixture.flush();
        const alreadyLoaded = fixture.snapshot();
        fixture.clear();
        fixture.watch();
        await fixture.flush();
        return { pending, oneLoaded, complete, duplicate, alreadyLoaded, empty: fixture.snapshot() };
    });
    expect(result).toEqual({
        pending: { scrolls: 0, listeners: [2, 2, 0] },
        oneLoaded: { scrolls: 0, listeners: [0, 2, 0] },
        complete: { scrolls: 1, listeners: [0, 0, 0] },
        duplicate: { scrolls: 1, listeners: [0, 0, 0] },
        alreadyLoaded: { scrolls: 2, listeners: [0, 0, 0] },
        empty: { scrolls: 2, listeners: [0, 0, 0] },
    });
});

test('a new media wait replaces old listeners and ignores detached media', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const fixture = window.mediaScrollTest;
        fixture.add('img');
        fixture.watch();
        fixture.watch();
        const repeated = fixture.snapshot();
        fixture.clear();
        fixture.add('audio');
        fixture.watch();
        fixture.fire(0, 'load');
        await fixture.flush();
        const replaced = fixture.snapshot();
        fixture.fire(1, 'loadeddata');
        await fixture.flush();
        const complete = fixture.snapshot();
        fixture.clear();
        fixture.add('video');
        fixture.watch();
        fixture.clear();
        fixture.watch();
        fixture.fire(2, 'loadeddata');
        await fixture.flush();
        return { repeated, replaced, complete, cancelledByEmptyChat: fixture.snapshot() };
    });
    expect(result).toEqual({
        repeated: { scrolls: 0, listeners: [2] },
        replaced: { scrolls: 0, listeners: [0, 2] },
        complete: { scrolls: 1, listeners: [0, 0] },
        cancelledByEmptyChat: { scrolls: 1, listeners: [0, 0, 0] },
    });
});

test('the one second deadline releases pending listeners and never scrolls on late completion', async ({ page }) => {
    await page.evaluate(() => {
        window.mediaScrollTest.add('img');
        window.mediaScrollTest.watch();
    });
    await expect.poll(() => page.evaluate(() => window.mediaScrollTest.snapshot()), { timeout: 5000 }).toEqual({ scrolls: 0, listeners: [0] });
    const result = await page.evaluate(async () => {
        const fixture = window.mediaScrollTest;
        fixture.fire(0, 'load');
        await fixture.flush();
        const expired = fixture.snapshot();
        fixture.clear();
        fixture.add('img');
        fixture.add('audio');
        fixture.watch();
        // A busy main thread may deliver an overdue load event before the timeout callback.
        const now = Date.now;
        try {
            Date.now = () => now() + 2000;
            fixture.fire(1, 'load');
        } finally {
            Date.now = now;
        }
        fixture.fire(2, 'loadeddata');
        await fixture.flush();
        return { expired, overdueBeforeTimer: fixture.snapshot() };
    });
    expect(result).toEqual({ expired: { scrolls: 0, listeners: [0] }, overdueBeforeTimer: { scrolls: 0, listeners: [0, 0, 0] } });
});

test('expiration during media inspection never leaves listeners on later elements', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const fixture = window.mediaScrollTest;
        fixture.add('img', true);
        fixture.add('img');
        const now = Date.now;
        Object.defineProperty(document.querySelector('#chat img'), 'complete', {
            configurable: true,
            get() {
                Date.now = () => now() + 2000;
                return true;
            },
        });
        try {
            fixture.watch();
        } finally {
            Date.now = now;
        }
        const afterSetup = fixture.snapshot();
        fixture.fire(1, 'load');
        await fixture.flush();
        return { afterSetup, afterLateLoad: fixture.snapshot() };
    });
    expect(result).toEqual({ afterSetup: { scrolls: 0, listeners: [0, 0] }, afterLateLoad: { scrolls: 0, listeners: [0, 0] } });
});
