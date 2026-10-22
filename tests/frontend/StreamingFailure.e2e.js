import { test, expect } from '@playwright/test';
import { setupStreamingFixture } from '../util/streaming-fixture.mjs';

test.beforeEach(async ({ page }) => {
    await setupStreamingFixture(page, { baseline: process.env.ST_STREAM_FAILURE_BASELINE });
});

for (const scenario of [
    { name: 'an interrupted hidden stream preserves its pending answer and reasoning', elapsed: 100, rendererThrows: false },
    { name: 'a renderer exception is not retried by the stream error handler', elapsed: 300, rendererThrows: true },
    { name: 'a failing pending preview still stops generation and emits completion once', elapsed: 100, rendererThrows: true },
]) {
    test(`${scenario.name}`, async ({ page }) => {
        const result = await page.evaluate(async ({ elapsed, rendererThrows }) => {
            const st = await import('/script.js');
            const { power_user } = await import('/scripts/power-user.js');
            const { PromptReasoning } = await import('/scripts/reasoning.js');
            const { replaceArrayContents } = await import('/scripts/util/array-contents.js');
            Object.assign(power_user, { streaming_fps: 30, message_token_count_enabled: false, stream_fade_in: false, pin_styles: false });
            st.changeMainAPI('openai');
            const message = { name: 'Assistant', mes: '...', is_user: false, is_system: false, send_date: new Date().toISOString(), extra: {}, swipe_id: 0, swipes: ['...'], swipe_info: [] };
            replaceArrayContents(st.chat, [message]);
            await st.redisplayChat({ fade: false });
            const processor = new st.StreamingProcessor('normal', false, new Date(), '', new PromptReasoning());
            processor.messageId = 0;
            const originalNow = Date.now;
            const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
            const baseTime = Date.now();
            let virtualTime = baseTime;
            let finalizations = 0;
            let generatorClosed = 0;
            const previews = [];
            const events = { tokens: [], received: [], rendered: [] };
            const handlers = [
                [st.event_types.STREAM_TOKEN_RECEIVED, text => events.tokens.push(text)],
                [st.event_types.MESSAGE_RECEIVED, id => events.received.push(id)],
                [st.event_types.CHARACTER_MESSAGE_RENDERED, id => events.rendered.push(id)],
            ];
            for (const [event, handler] of handlers) st.eventSource.on(event, handler);
            const onProgress = processor.onProgressStreaming.bind(processor);
            processor.onProgressStreaming = async (id, text, final) => {
                previews.push({ id, final: Boolean(final) });
                await onProgress(id, text, final);
                if (rendererThrows) throw new Error('Renderer failed after the DOM update');
            };
            const finalize = processor.finalizeIntermediaryMessage.bind(processor);
            processor.finalizeIntermediaryMessage = async (...args) => {
                finalizations++;
                return finalize(...args);
            };
            processor.generator = async function* () {
                try {
                    virtualTime = baseTime + elapsed;
                    yield { text: '**Partial answer**', swipes: [], toolCalls: [], state: { reasoning: 'Partial reasoning' } };
                    throw new Error('The connection ended before the next token');
                } finally {
                    generatorClosed++;
                }
            };
            try {
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
                Date.now = () => virtualTime;
                const result = await processor.generate();
                // onErrorStreaming emits through the application's asynchronous
                // EventEmitter; let all existing extension listeners finish.
                await new Promise(resolve => setTimeout(resolve, 0));
                return {
                    result, previews, events, finalizations, generatorClosed,
                    text: st.chat[0].mes, reasoning: st.chat[0].extra.reasoning,
                    domText: document.querySelector('#chat .mes_text').textContent,
                    bold: document.querySelector('#chat .mes_text strong')?.textContent,
                    stopped: processor.isStopped, aborted: processor.abortController.signal.aborted,
                    finished: processor.isFinished,
                };
            } finally {
                Date.now = originalNow;
                if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor);
                else delete document.hidden;
                for (const [event, handler] of handlers) st.eventSource.removeListener(event, handler);
            }
        }, scenario);

        expect(result).toMatchObject({
            result: '**Partial answer**', text: '**Partial answer**', reasoning: 'Partial reasoning',
            domText: 'Partial answer', bold: 'Partial answer', stopped: true, aborted: true,
            finished: false, finalizations: 0, generatorClosed: 1,
        });
        expect(result.previews).toEqual([{ id: 0, final: false }]);
        expect(result.events).toEqual({ tokens: ['**Partial answer**'], received: [0], rendered: [0] });
    });
}
