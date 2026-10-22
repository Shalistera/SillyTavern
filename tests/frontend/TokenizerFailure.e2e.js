import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { testSetup } from './frontent-test-utils.js';

const baseline = process.env.ST_TOKENIZER_BASELINE;
const baselineSource = baseline ? execFileSync('git', ['show', `${baseline}:public/scripts/tokenizers.js`], { encoding: 'utf8' }) : null;

test.beforeEach(async ({ page }) => {
    if (baselineSource) await page.route('**/scripts/tokenizers.js', route => route.fulfill({ contentType: 'application/javascript', body: baselineSource }));
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
    await page.evaluate(async () => (await import('/script.js')).changeMainAPI('kobold'));
});

test('failed HTTP and network tokenizer requests settle with the existing estimate', async ({ page }) => {
    let failure = 'http';
    const requests = [];
    await page.route('**/api/tokenizers/**', async route => {
        requests.push(new URL(route.request().url()).pathname);
        if (failure === 'http') await route.fulfill({ status: 500, json: { error: 'Tokenizer unavailable' } });
        else await route.abort('failed');
    });
    for (const mode of ['http', 'network']) {
        failure = mode;
        const results = await page.evaluate(async mode => {
            const { getTokenCountAsync, guesstimate, tokenizers, TOKENIZER_WARNING_KEY } = await import('/scripts/tokenizers.js');
            const { power_user } = await import('/scripts/power-user.js');
            const rows = [];
            for (const type of [tokenizers.GPT2, tokenizers.API_KOBOLD, tokenizers.API_TEXTGENERATIONWEBUI]) {
                power_user.tokenizer = type;
                sessionStorage.removeItem(TOKENIZER_WARNING_KEY);
                const text = `Failure ${mode}-${type} 日本語 👩🏽‍💻`;
                const value = await Promise.race([getTokenCountAsync(text, 3), new Promise(resolve => setTimeout(() => resolve('still pending'), 1000))]);
                rows.push({ type, value, expected: guesstimate(text) + 3, warned: sessionStorage.getItem(TOKENIZER_WARNING_KEY) === 'true' });
            }
            return rows;
        }, mode);
        for (const row of results) {
            expect(row.value, `${mode} tokenizer ${row.type} completed its failed request but stayed pending`).toBe(row.expected);
            expect(row.warned).toBe(true);
        }
    }
    expect(requests).toEqual([
        '/api/tokenizers/gpt2/encode', '/api/tokenizers/remote/kobold/count', '/api/tokenizers/remote/textgenerationwebui/encode',
        '/api/tokenizers/gpt2/encode', '/api/tokenizers/remote/kobold/count', '/api/tokenizers/remote/textgenerationwebui/encode',
    ]);
});

test('tokenizer success, empty payloads and synchronous callers keep their count contracts', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { getTokenCountAsync, getTokenCount, guesstimate, tokenizers, TOKENIZER_WARNING_KEY } = await import('/scripts/tokenizers.js');
        const { power_user } = await import('/scripts/power-user.js');
        const ajax = jQuery.ajax;
        let mode = 'success';
        const requests = [];
        jQuery.ajax = options => {
            requests.push({ async: options.async, url: options.url });
            const complete = () => {
                if (mode === 'error') options.error?.({}, 'error', 'failed');
                else options.success?.(mode === 'success' ? { count: 0 } : mode === 'null' ? null : {});
            };
            if (options.async) queueMicrotask(complete);
            else complete();
            return {};
        };
        const rows = [];
        try {
            for (const type of [tokenizers.GPT2, tokenizers.API_KOBOLD, tokenizers.API_TEXTGENERATIONWEBUI]) {
                power_user.tokenizer = type;
                for (const response of ['success', 'empty', 'null', 'error']) {
                    mode = response;
                    sessionStorage.setItem(TOKENIZER_WARNING_KEY, 'true');
                    const asyncText = `Async contract ${type}-${response}`;
                    const syncText = `Sync contract ${type}-${response}`;
                    rows.push({ asyncValue: await getTokenCountAsync(asyncText, 2), asyncExpected: response === 'success' ? 2 : guesstimate(asyncText) + 2, syncValue: getTokenCount(syncText, 4), syncExpected: response === 'success' ? 4 : guesstimate(syncText) + 4 });
                }
            }
        } finally {
            jQuery.ajax = ajax;
        }
        return { rows, calls: requests.length, asyncRequests: requests.filter(request => request.async).length, syncRequests: requests.filter(request => !request.async).length };
    });
    for (const row of result.rows) {
        expect(row.asyncValue).toBe(row.asyncExpected);
        expect(row.syncValue).toBe(row.syncExpected);
    }
    expect(result).toMatchObject({ calls: 24, asyncRequests: 12, syncRequests: 12 });
});

test('BEST_MATCH retries a failed remote tokenizer once and does not recurse on fallback failure', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const st = await import('/script.js');
        const { getTokenCountAsync, guesstimate, tokenizers, TOKENIZER_WARNING_KEY } = await import('/scripts/tokenizers.js');
        const { power_user } = await import('/scripts/power-user.js');
        const { kai_flags } = await import('/scripts/kai-settings.js');
        const ajax = jQuery.ajax;
        st.setOnlineStatus('test-model');
        kai_flags.can_use_tokenization = true;
        power_user.tokenizer = tokenizers.BEST_MATCH;
        const rows = [];
        const requests = [];
        let fallbackSucceeds = true;
        jQuery.ajax = options => {
            requests.push({ url: options.url, async: options.async });
            const complete = () => {
                if (options.url.includes('/llama/') && fallbackSucceeds) options.success?.({ count: 41 });
                else options.error?.({}, 'error', 'failed');
            };
            if (options.async) queueMicrotask(complete);
            else complete();
            return {};
        };
        try {
            for (const success of [true, false]) {
                fallbackSucceeds = success;
                sessionStorage.removeItem(TOKENIZER_WARNING_KEY);
                const text = `BEST_MATCH fallback ${success}`;
                rows.push({ value: await getTokenCountAsync(text, 2), expected: success ? 43 : guesstimate(text) + 2 });
            }
        } finally {
            jQuery.ajax = ajax;
        }
        return { rows, requests };
    });
    for (const row of result.rows) expect(row.value).toBe(row.expected);
    expect(result.requests).toEqual([
        { url: '/api/tokenizers/remote/kobold/count', async: true }, { url: '/api/tokenizers/llama/encode', async: false },
        { url: '/api/tokenizers/remote/kobold/count', async: true }, { url: '/api/tokenizers/llama/encode', async: false },
    ]);
});
