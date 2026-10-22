import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { testSetup } from '../frontend/frontent-test-utils.js';

export async function setupStreamingFixture(page, { baseline } = {}) {
    const source = baseline
        ? execFileSync('git', ['show', `${baseline}:public/script.js`], { encoding: 'utf8' })
        : await fs.readFile(new URL('../../public/script.js', import.meta.url), 'utf8');
    // Expose the actual private class only in this test page, without changing
    // the extension-facing production module or substituting the render loop.
    await page.route('**/script.js', route => route.fulfill({ contentType: 'application/javascript', body: `${source}\nexport { StreamingProcessor };\n` }));
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
}

/** Runs the real generator, event and Markdown/DOM update paths on a simulated chunk clock. */
export async function runStreamingScenario({ hidden, count = 120, fps = 30, visibleAt = null, wordsPerChunk = 1 }) {
    const st = await import('/script.js');
    const { power_user } = await import('/scripts/power-user.js');
    const { PromptReasoning } = await import('/scripts/reasoning.js');
    const { replaceArrayContents } = await import('/scripts/util/array-contents.js');
    power_user.streaming_fps = fps;
    power_user.message_token_count_enabled = false;
    power_user.stream_fade_in = false;
    power_user.pin_styles = false;
    st.changeMainAPI('openai');
    const message = { name: 'Assistant', mes: '', is_user: false, is_system: false, send_date: new Date().toISOString(), extra: {}, swipe_id: 0, swipes: [''], swipe_info: [] };
    replaceArrayContents(st.chat, [message]);
    await st.redisplayChat({ fade: false });
    const processor = new st.StreamingProcessor('normal', false, new Date(), '', new PromptReasoning());
    processor.messageId = 0;
    const originalNow = Date.now;
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
    const baseTime = Date.now();
    let elapsed = 0;
    let isHidden = hidden;
    let emittedTokens = 0;
    let latestToken = '';
    const previews = [];
    const tokenListener = text => { emittedTokens++; latestToken = text; };
    const onProgress = processor.onProgressStreaming.bind(processor);
    processor.onProgressStreaming = async (id, text, final) => {
        previews.push({ elapsed, final: Boolean(final), hidden: isHidden });
        await onProgress(id, text, final);
    };
    processor.generator = async function* () {
        let text = '';
        for (let i = 1; i <= count; i++) {
            elapsed = i * 10;
            if (visibleAt !== null && elapsed >= visibleAt) isHidden = false;
            text += `${'**word** '.repeat(wordsPerChunk)}${i} `;
            yield { text, swipes: [], toolCalls: [{ id: `tool-${i}` }], state: { reasoning: `Thought ${i}`, signature: `signature-${i}` } };
        }
    };
    st.eventSource.on(st.event_types.STREAM_TOKEN_RECEIVED, tokenListener);
    try {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden });
        Date.now = () => baseTime + elapsed;
        const started = performance.now();
        const result = await processor.generate();
        await processor.finalizeIntermediaryMessage(0, result, { unlockUI: false });
        return {
            workMs: performance.now() - started,
            emittedTokens, result, latestToken,
            finalMessage: st.chat[0].mes,
            finalSwipe: st.chat[0].swipes[0],
            finalReasoning: st.chat[0].extra.reasoning,
            finalSignature: st.chat[0].extra.reasoning_signature,
            finalToolCalls: processor.toolCalls,
            domText: document.querySelector('#chat .mes_text').textContent,
            strongCount: document.querySelectorAll('#chat .mes_text strong').length,
            previews,
        };
    } finally {
        Date.now = originalNow;
        if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor);
        else delete document.hidden;
        st.eventSource.removeListener(st.event_types.STREAM_TOKEN_RECEIVED, tokenListener);
    }
}
