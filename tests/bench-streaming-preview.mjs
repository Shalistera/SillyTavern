import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { runStreamingScenario, setupStreamingFixture } from './util/streaming-fixture.mjs';

const baseURL = process.env.ST_BASE_URL || 'http://127.0.0.1:18349';
const baseline = process.env.ST_STREAMING_BASELINE || '46c47c5b0';
const browser = await chromium.launch({ headless: true });
const rows = [];
let expectedFinal;
try {
    for (const version of ['baseline', 'current', 'current', 'baseline']) {
        const page = await browser.newPage({ baseURL });
        await setupStreamingFixture(page, { baseline: version === 'baseline' ? baseline : undefined });
        const client = await page.context().newCDPSession(page);
        await client.send('Performance.enable');
        for (const hidden of [false, true]) {
            const before = await client.send('Performance.getMetrics');
            const result = await page.evaluate(runStreamingScenario, { hidden, count: 500, wordsPerChunk: 4 });
            const after = await client.send('Performance.getMetrics');
            const metric = (metrics, name) => metrics.metrics.find(item => item.name === name)?.value ?? 0;
            const taskMs = (metric(after, 'TaskDuration') - metric(before, 'TaskDuration')) * 1000;
            assert.equal(result.emittedTokens, 500);
            assert.equal(result.latestToken, result.result);
            assert.equal(result.finalMessage, result.result.trim());
            assert.equal(result.finalSwipe, result.finalMessage);
            assert.equal(result.finalReasoning, 'Thought 500');
            assert.equal(result.finalSignature, 'signature-500');
            assert.equal(result.strongCount, 2000);
            assert.equal(result.previews.filter(x => x.final).length, 1);
            const final = { message: result.finalMessage, dom: result.domText, reasoning: result.finalReasoning, signature: result.finalSignature, tools: result.finalToolCalls };
            expectedFinal ??= final;
            assert.deepEqual(final, expectedFinal);
            const row = { version, hidden, chunks: result.emittedTokens, virtualStreamMs: 5000, workMs: result.workMs, taskMs, previews: result.previews.filter(x => !x.final).length, finalFlushes: 1 };
            rows.push(row);
            console.log(JSON.stringify(row));
        }
        await page.close();
    }
    const report = {
        baseline,
        method: 'ABBA, same current supporting modules; actual StreamingProcessor and Markdown/DOM path, deterministic 100 chunks/second over five simulated seconds, document.hidden overridden. workMs measures execution, not provider/wall-clock streaming latency.',
        rows,
    };
    await fs.writeFile(process.env.BENCHMARK_OUTPUT || '/tmp/csilly-streaming-preview-benchmark.json', JSON.stringify(report, null, 2));
} finally {
    await browser.close();
}
