// Compare the real startup initializer with a reproducible delay per template request.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

const { values } = parseArgs({ options: {
    baseline: { type: 'string', default: '46c47c5b0' },
    rounds: { type: 'string', default: '2' },
    'delay-ms': { type: 'string', default: '100' },
    help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
    console.log('Usage: ST_BASE_URL=http://127.0.0.1:18349 node tests/bench-startup-templates.mjs [--baseline REF] [--rounds N] [--delay-ms N]\n'
        + 'Measures only initSystemMessages with six cold templates, adding the specified delay to each real template response.\n'
        + 'Alternates baseline/current in fresh browser contexts and checks exact message output. It does not measure total startup time.');
    process.exit(0);
}
const rounds = Number(values.rounds);
const delayMs = Number(values['delay-ms']);
assert.ok(Number.isSafeInteger(rounds) && rounds > 0 && Number.isSafeInteger(delayMs) && delayMs >= 0);
const gitOptions = { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' };
const baseline = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${values.baseline}^{commit}`], gitOptions).trim();
const sources = {
    baseline: execFileSync('git', ['show', `${baseline}:public/scripts/system-messages.js`], gitOptions),
    current: readFileSync(new URL('../public/scripts/system-messages.js', import.meta.url), 'utf8'),
};
const start = 'export async function initSystemMessages() {';
const end = 'SAFETY_CHAT.splice(0, SAFETY_CHAT.length, safetyMessage);';
for (const implementation of Object.keys(sources)) {
    assert.equal(sources[implementation].split(start).length, 2);
    assert.equal(sources[implementation].split(end).length, 2);
    sources[implementation] = sources[implementation]
        .replace(start, `${start}\nconst benchmarkStart = performance.now();`)
        .replace(end, `${end}\nglobalThis.__startupTemplateDuration = performance.now() - benchmarkStart;`);
}
const browser = await chromium.launch();
const results = [];
let expected;
try {
    for (let round = 0; round < rounds; round++) {
        for (const implementation of round % 2 === 0 ? ['baseline', 'current'] : ['current', 'baseline']) {
            const page = await browser.newPage({ baseURL: process.env.ST_BASE_URL || 'http://127.0.0.1:18349' });
            let active = 0;
            let maxConcurrentRequests = 0;
            let requests = 0;
            await page.route('**/scripts/system-messages.js', route => route.fulfill({ contentType: 'application/javascript', body: sources[implementation] }));
            await page.route(/\/scripts\/templates\/(help|hotkeys|formatting|welcome|welcomePrompt|assistantNote)\.html$/, async route => {
                active++;
                requests++;
                maxConcurrentRequests = Math.max(maxConcurrentRequests, active);
                try {
                    const response = await route.fetch();
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    await route.fulfill({ response });
                } finally {
                    active--;
                }
            });
            await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const data = await response.json();
                const settings = JSON.parse(data.settings);
                settings.firstRun = false;
                data.settings = JSON.stringify(settings);
                await route.fulfill({ response, json: data });
            });
            try {
                await testSetup.awaitST({ page });
                const result = await page.evaluate(async () => {
                    const { system_messages, SAFETY_CHAT } = await import('/scripts/system-messages.js');
                    return {
                        ms: Math.round(window.__startupTemplateDuration * 100) / 100,
                        messages: system_messages,
                        safety: SAFETY_CHAT.map(({ send_date, ...message }) => message),
                    };
                });
                assert.equal(requests, 6);
                if (expected) assert.deepEqual({ messages: result.messages, safety: result.safety }, expected);
                else expected = { messages: result.messages, safety: result.safety };
                results.push({ implementation, round, ms: result.ms, requests, maxConcurrentRequests });
            } finally {
                await page.close();
            }
        }
    }
    console.log(JSON.stringify({ baseline, delayMs, scope: 'Six cold startup templates; initSystemMessages only, real HTML with injected per-response delay, exact message equality checked.', results }, null, 2));
} finally {
    await browser.close();
}
