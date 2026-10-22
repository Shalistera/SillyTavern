import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const baseURL = process.env.ST_BASE_URL || 'http://127.0.0.1:18348';
const baseline = process.env.ST_STREAM_BASELINE || '78a22e873';
const baselineSource = execFileSync('git', ['show', `${baseline}:public/scripts/util/stream-fadein.js`], { encoding: 'utf8' });
const browser = await chromium.launch();
const results = [];
try {
    // Isolate the rendering functions from application startup and background work.
    for (const implementation of ['baseline', 'current', 'current', 'baseline']) {
        const page = await browser.newPage({ baseURL });
        await page.route('**/__stream_fade_bench__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
        if (implementation === 'baseline') {
            await page.route('**/scripts/util/stream-fadein.js*', route => route.fulfill({ contentType: 'application/javascript', body: baselineSource }));
        }
        await page.goto('/__stream_fade_bench__');
        const rows = await page.evaluate(async () => {
            const rows = [];
            const ticks = 12;
            for (const [shape, size] of [['single', 4096], ['single', 8192], ['single', 32768], ['unique-paragraphs', 32768]]) {
                const phrase = 'The traveler described the changing landscape with careful observations. ';
                const body = phrase.repeat(Math.ceil(size / phrase.length)).slice(0, size);
                const html = tick => shape === 'single'
                    ? `<p>${body}${' Next word'.repeat(tick)}</p>`
                    : Array.from({ length: Math.ceil(size / 180) }, (_, paragraph) => `<p>Revision ${tick}, paragraph ${paragraph}: ${body.slice(0, 150)}</p>`).join('');
                const row = { shape, size, ticks };
                for (const phase of ['segment', 'fade']) {
                    // Separate module instances prevent the segmentation phase warming the fade cache.
                    const module = await import(`/scripts/util/stream-fadein.js?bench=${shape}-${size}-${phase}`);
                    const render = phase === 'segment' ? module.segmentTextInElement : module.applyStreamFadeIn;
                    const element = document.createElement('div');
                    render(element, html(0));
                    const times = [];
                    for (let tick = 1; tick <= ticks; tick++) {
                        const content = html(tick);
                        const started = performance.now();
                        render(element, content);
                        times.push(performance.now() - started);
                    }
                    const sorted = times.toSorted((a, b) => a - b);
                    row[phase] = { totalMs: +times.reduce((sum, time) => sum + time, 0).toFixed(1), medianMs: +sorted[Math.floor(times.length / 2)].toFixed(2) };
                }
                rows.push(row);
            }
            return rows;
        });
        results.push({ implementation, baseline, rows });
        await page.close();
    }
    console.log(JSON.stringify(results, null, 2));
} finally {
    await browser.close();
}
