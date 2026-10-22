import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { testSetup } from './frontend/frontent-test-utils.js';

const baseURL = process.env.ST_BASE_URL || 'http://127.0.0.1:18348';
const browser = await chromium.launch();
try {
    const page = await browser.newPage({ baseURL });
    // A/B against a committed implementation without touching the checkout.
    if (process.env.ST_STREAM_BASELINE) {
        for (const file of ['stream-fadein.js', 'showdown-patch.js']) {
            const source = execFileSync('git', ['show', `${process.env.ST_STREAM_BASELINE}:public/scripts/util/${file}`], { encoding: 'utf8' });
            await page.route(`**/scripts/util/${file}`, route => route.fulfill({ contentType: 'application/javascript', body: source }));
        }
    }
    await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
    await testSetup.awaitST({ page });
    const profiler = process.env.STREAM_PROFILE ? await page.context().newCDPSession(page) : null;
    if (profiler) {
        await profiler.send('Profiler.enable');
        await profiler.send('Profiler.start');
    }
    const result = await page.evaluate(async () => {
        const st = await import('/script.js');
        const { applyStreamFadeIn, segmentTextInElement } = await import('/scripts/util/stream-fadein.js');
        const { DOMPurify } = await import('/lib.js');
        const { power_user } = await import('/scripts/power-user.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const { runRegexScript } = await import('/scripts/extensions/regex/engine.js');
        extension_settings.regex = [];
        power_user.markdown_escape_strings = '';
        power_user.message_token_count_enabled = false;
        const converter = st.reloadMarkdownProcessor();
        const makeHtml = converter.makeHtml;
        const sanitize = DOMPurify.sanitize;
        let markdownMs = 0;
        let sanitizeMs = 0;
        converter.makeHtml = function (...args) {
            const start = performance.now();
            const result = makeHtml.apply(this, args);
            markdownMs += performance.now() - start;
            return result;
        };
        DOMPurify.sanitize = function (...args) {
            const start = performance.now();
            const result = sanitize.apply(this, args);
            sanitizeMs += performance.now() - start;
            return result;
        };
        const summarize = values => {
            const sorted = values.toSorted((a, b) => a - b);
            return { totalMs: +values.reduce((sum, value) => sum + value, 0).toFixed(1), medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2) };
        };
        const measure = (samples, callback) => samples.map(sample => {
            const start = performance.now();
            callback(sample);
            return performance.now() - start;
        });
        const ticks = 12;
        const rows = [];
        for (const targetLength of [4096, 32768, 131072]) {
            const paragraph = index => `Paragraph ${index}: **The traveler** said, "A growing answer stays readable." 日本語の文章も少し含めます。\n\n`;
            let body = '';
            for (let index = 0; body.length < targetLength; index++) body += paragraph(index);
            const samples = Array.from({ length: ticks }, (_, index) => body + 'Continuing answer '.repeat(index + 1));
            st.messageFormatting(samples[0], 'Assistant', false, false, -1);
            markdownMs = 0;
            sanitizeMs = 0;
            const html = [];
            const format = summarize(measure(samples, text => html.push(st.messageFormatting(text, 'Assistant', false, false, -1))));
            const breakdown = { markdownMs: +markdownMs.toFixed(1), sanitizeMs: +sanitizeMs.toFixed(1) };
            const element = document.createElement('div');
            const segmented = summarize(measure(html, text => segmentTextInElement(element, text)));
            element.innerHTML = '';
            const fade = summarize(measure(html, text => applyStreamFadeIn(element, text)));
            const innerHTML = summarize(measure(html, text => { element.innerHTML = text; }));
            const regex = { findRegex: '/(traveler)/g', replaceString: '<em>$1</em>', trimStrings: [], substituteRegex: 0 };
            const regexTime = summarize(measure(samples, text => runRegexScript(regex, text)));
            rows.push({ chars: body.length, ticks, format, ...breakdown, segmented, fade, innerHTML, regex: regexTime });
        }
        return { userAgent: navigator.userAgent, rows };
    });
    if (profiler) {
        const { profile } = await profiler.send('Profiler.stop');
        const selfTime = new Map();
        for (let index = 0; index < profile.samples.length; index++) {
            const id = profile.samples[index];
            selfTime.set(id, (selfTime.get(id) ?? 0) + profile.timeDeltas[index]);
        }
        result.hotspots = profile.nodes.map(node => ({
            function: node.callFrame.functionName,
            url: node.callFrame.url,
            line: node.callFrame.lineNumber + 1,
            selfMs: Math.round((selfTime.get(node.id) ?? 0) / 1000),
        })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 20);
    }
    result.implementation = process.env.ST_STREAM_BASELINE || 'working tree';
    console.log(JSON.stringify(result, null, 2));
} finally {
    await browser.close();
}
