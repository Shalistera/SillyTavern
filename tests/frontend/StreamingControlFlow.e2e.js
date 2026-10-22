import { test, expect } from '@playwright/test';
import { setupStreamingFixture } from '../util/streaming-fixture.mjs';

test.beforeEach(async ({ page }) => {
    await page.route('**/api/chats/save', route => route.fulfill({ json: { result: 'ok' } }));
    await page.route('**/api/backends/chat-completions/status', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/tokenizers/**', route => route.fulfill({ json: { count: 8, token_count: 8, ids: [1, 2, 3] } }));
    await setupStreamingFixture(page);
});

for (const type of ['continue', 'impersonate']) {
    test(`an interrupted ${type} stream preserves its pending content and original event rules`, async ({ page }) => {
        const result = await page.evaluate(async type => {
            const st = await import('/script.js');
            const { power_user } = await import('/scripts/power-user.js');
            const { PromptReasoning } = await import('/scripts/reasoning.js');
            const { replaceArrayContents } = await import('/scripts/util/array-contents.js');
            Object.assign(power_user, { streaming_fps: 30, stream_fade_in: false, message_token_count_enabled: false });
            st.changeMainAPI('openai');
            const prefix = 'Existing prefix. ';
            const message = { name: 'Assistant', mes: prefix, is_user: false, is_system: false, extra: {}, send_date: new Date().toISOString(), swipe_id: 0, swipes: [prefix], swipe_info: [{}] };
            replaceArrayContents(st.chat, [message]);
            await st.redisplayChat({ fade: false });
            const processor = new st.StreamingProcessor(type, false, new Date(), prefix, new PromptReasoning());
            processor.messageId = 0;
            const originalNow = Date.now;
            const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
            let time = Date.now();
            const events = [];
            const previews = [];
            const received = id => events.push(['received', id]);
            const rendered = id => events.push(['rendered', id]);
            st.eventSource.on(st.event_types.MESSAGE_RECEIVED, received);
            st.eventSource.on(st.event_types.CHARACTER_MESSAGE_RENDERED, rendered);
            const progress = processor.onProgressStreaming.bind(processor);
            processor.onProgressStreaming = async (id, text, final) => {
                previews.push({ text, final: Boolean(final) });
                return progress(id, text, final);
            };
            processor.generator = async function* () {
                time += 100;
                yield { text: '**Partial answer**', swipes: [], toolCalls: [], state: { reasoning: 'Partial reasoning' } };
                throw new Error('Stream interrupted');
            };
            try {
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
                Date.now = () => time;
                await processor.generate();
                await new Promise(resolve => setTimeout(resolve, 0));
                return { previews, events, text: st.chat[0].mes, swipe: st.chat[0].swipes[0], reasoning: st.chat[0].extra.reasoning, rawReasoning: processor.reasoningHandler.reasoning, input: document.querySelector('#send_textarea').value, stopped: processor.isStopped, aborted: processor.abortController.signal.aborted, finished: processor.isFinished };
            } finally {
                Date.now = originalNow;
                if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor);
                else delete document.hidden;
                st.eventSource.removeListener(st.event_types.MESSAGE_RECEIVED, received);
                st.eventSource.removeListener(st.event_types.CHARACTER_MESSAGE_RENDERED, rendered);
            }
        }, type);
        expect(result).toMatchObject({ stopped: true, aborted: true, finished: false, rawReasoning: 'Partial reasoning', events: [] });
        expect(result.previews).toEqual([{ text: type === 'continue' ? 'Existing prefix. **Partial answer**' : '**Partial answer**', final: false }]);
        expect(result.text).toBe(type === 'continue' ? 'Existing prefix. **Partial answer**' : 'Existing prefix. ');
        expect(result.swipe).toBe(result.text);
        expect(result.reasoning).toBe(type === 'continue' ? 'Partial reasoning' : undefined);
        expect(result.input).toBe(type === 'impersonate' ? '**Partial answer**' : '');
    });
}

test('stopping Generate before its first hidden preview performs one final flush without error completion', async ({ page }) => {
    test.setTimeout(60000);
    const result = await page.evaluate(async () => {
        const st = await import('/script.js');
        const { oai_settings } = await import('/scripts/openai.js');
        const { power_user } = await import('/scripts/power-user.js');
        await st.newAssistantChat({ temporary: true });
        st.changeMainAPI('openai');
        Object.assign(oai_settings, { chat_completion_source: 'custom', custom_url: 'https://example.invalid', custom_model: 'stop-stream-test', stream_openai: true, function_calling: false, show_thoughts: true });
        Object.assign(power_user, { streaming_fps: 30, stream_fade_in: false, message_token_count_enabled: false });
        st.setOnlineStatus('stop-stream-test');
        const user = { name: 'User', is_user: true, is_system: false, mes: 'Start a reply.', extra: {} };
        st.chat.push(user);
        await st.addOneMessage(user);
        const originalFetch = window.fetch;
        const originalNow = Date.now;
        const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
        const progress = st.StreamingProcessor.prototype.onProgressStreaming;
        const onError = st.StreamingProcessor.prototype.onErrorStreaming;
        let clock = Date.now();
        let requests = 0;
        let stops = 0;
        let errors = 0;
        const previews = [];
        const received = [];
        const rendered = [];
        const stopOnToken = () => {
            clock += 100;
            stops++;
            st.streamingProcessor.onStopStreaming();
        };
        const receivedListener = id => received.push(id);
        const renderedListener = id => rendered.push(id);
        st.eventSource.on(st.event_types.STREAM_TOKEN_RECEIVED, stopOnToken);
        st.eventSource.on(st.event_types.MESSAGE_RECEIVED, receivedListener);
        st.eventSource.on(st.event_types.CHARACTER_MESSAGE_RENDERED, renderedListener);
        st.StreamingProcessor.prototype.onProgressStreaming = async function (id, text, final) {
            previews.push({ id, final: Boolean(final) });
            return progress.call(this, id, text, final);
        };
        st.StreamingProcessor.prototype.onErrorStreaming = function () { errors++; return onError.call(this); };
        window.fetch = (url, options) => {
            if (url !== '/api/backends/chat-completions/generate') return originalFetch(url, options);
            requests++;
            const stream = new ReadableStream({
                start(controller) {
                    options.signal.addEventListener('abort', () => controller.error(new DOMException('User stopped generation', 'AbortError')), { once: true });
                    const delta = { choices: [{ index: 0, delta: { content: '**Stopped answer**', reasoning_content: 'Thought before stop' } }] };
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta)}\n\n`));
                },
            });
            return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
        };
        try {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            Date.now = () => clock;
            await st.Generate('normal', { automatic_trigger: true });
            const last = st.chat.at(-1);
            return { requests, stops, errors, previews, received, rendered, messageId: st.chat.length - 1, text: last.mes, reasoning: last.extra.reasoning, domText: document.querySelector('#chat .last_mes .mes_text')?.textContent, streamingStopped: st.streamingProcessor === null };
        } finally {
            Date.now = originalNow;
            window.fetch = originalFetch;
            st.StreamingProcessor.prototype.onProgressStreaming = progress;
            st.StreamingProcessor.prototype.onErrorStreaming = onError;
            if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor);
            else delete document.hidden;
            st.eventSource.removeListener(st.event_types.STREAM_TOKEN_RECEIVED, stopOnToken);
            st.eventSource.removeListener(st.event_types.MESSAGE_RECEIVED, receivedListener);
            st.eventSource.removeListener(st.event_types.CHARACTER_MESSAGE_RENDERED, renderedListener);
        }
    });
    expect(result).toMatchObject({ requests: 1, stops: 1, errors: 0, text: '**Stopped answer**', reasoning: 'Thought before stop', domText: 'Stopped answer', streamingStopped: true });
    expect(result.previews).toEqual([{ id: result.messageId, final: true }]);
    expect(result.received).toEqual([result.messageId]);
    expect(result.rendered).toEqual([result.messageId]);
});
