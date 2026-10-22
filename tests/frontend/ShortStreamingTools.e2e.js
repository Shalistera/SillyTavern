import { test, expect } from '@playwright/test';
import { setupStreamingFixture } from '../util/streaming-fixture.mjs';

test.beforeEach(async ({ page }) => {
    await page.route('**/api/chats/save', route => route.fulfill({ json: { result: 'ok' } }));
    await page.route('**/api/backends/chat-completions/status', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/tokenizers/**', route => route.fulfill({ json: { count: 8, token_count: 8, ids: [1, 2, 3] } }));
    await setupStreamingFixture(page, { baseline: process.env.ST_SHORT_STREAM_BASELINE });
});

for (const scenario of [
    { name: 'stealth tool preserves short-stream reasoning before stopping', stealth: true, reasoning: 'Reasoning before the stealth tool.' },
    { name: 'ordinary tool preserves short-stream reasoning before the follow-up reply', stealth: false, reasoning: 'Reasoning before the ordinary tool.' },
    { name: 'a truly empty stealth-tool placeholder is still removed', stealth: true, reasoning: '' },
]) {
    const expectedMessages = [
        ...(scenario.reasoning ? [{ text: '', reasoning: scenario.reasoning, domReasoning: scenario.reasoning }] : []),
        ...(!scenario.stealth ? [{ text: 'Answer after the tool.', reasoning: '', domReasoning: '' }] : []),
    ];
    test(`${scenario.name}`, async ({ page }) => {
        test.setTimeout(60000);
        const result = await page.evaluate(async ({ stealth, reasoning }) => {
            const st = await import('/script.js');
            const { oai_settings } = await import('/scripts/openai.js');
            const { power_user } = await import('/scripts/power-user.js');
            const { ToolManager } = await import('/scripts/tool-calling.js');
            await st.newAssistantChat({ temporary: true });
            st.changeMainAPI('openai');
            Object.assign(oai_settings, {
                chat_completion_source: 'custom', custom_url: 'https://example.invalid', custom_model: 'short-tool-stream-test',
                stream_openai: true, function_calling: true, show_thoughts: true, custom_prompt_post_processing: '',
            });
            Object.assign(power_user, { streaming_fps: 30, stream_fade_in: false, message_token_count_enabled: false });
            st.setOnlineStatus('short-tool-stream-test');
            const userMessage = { name: 'User', is_user: true, is_system: false, mes: 'Use the registered tool.', extra: {} };
            st.chat.push(userMessage);
            await st.addOneMessage(userMessage);

            const originalFetch = window.fetch;
            const originalNow = Date.now;
            const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
            const progress = st.StreamingProcessor.prototype.onProgressStreaming;
            const toolName = 'short_stream_reasoning_probe';
            let virtualNow = Date.now();
            let toolCalls = 0;
            const requests = [];
            const previews = [];
            const events = { tokens: [], received: [], rendered: [], reasoningDone: [], deleted: [] };
            const handlers = [
                [st.event_types.STREAM_TOKEN_RECEIVED, text => { virtualNow += 100; events.tokens.push(text); }],
                [st.event_types.MESSAGE_RECEIVED, id => events.received.push(id)],
                [st.event_types.CHARACTER_MESSAGE_RENDERED, id => events.rendered.push(id)],
                [st.event_types.STREAM_REASONING_DONE, (text, duration, id) => events.reasoningDone.push({ text, duration, id })],
                [st.event_types.MESSAGE_DELETED, id => events.deleted.push(id)],
            ];
            for (const [event, handler] of handlers) st.eventSource.on(event, handler);
            ToolManager.registerFunctionTool({
                name: toolName, displayName: 'Short stream regression tool', description: 'A deterministic test tool.',
                parameters: { type: 'object', properties: {} }, stealth,
                action: () => { toolCalls++; return 'Tool completed.'; },
            });
            st.StreamingProcessor.prototype.onProgressStreaming = async function (id, text, final) {
                previews.push({ id, final: Boolean(final) });
                return progress.call(this, id, text, final);
            };
            window.fetch = (url, options) => {
                if (url !== '/api/backends/chat-completions/generate') return originalFetch(url, options);
                requests.push(JSON.parse(options.body));
                if (requests.length > 2) throw new Error('Unexpected repeated tool generation');
                const delta = requests.length === 1 ? {
                    content: '', reasoning_content: reasoning,
                    tool_calls: [{ index: 0, id: 'short-tool-call', type: 'function', function: { name: toolName, arguments: '{}' } }],
                } : { content: 'Answer after the tool.' };
                const body = `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\ndata: [DONE]\n\n`;
                return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
            };
            try {
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
                // Each real SSE delta advances the processor's clock by 100 ms:
                // long enough for a foreground preview, below the hidden cap.
                Date.now = () => virtualNow;
                await st.Generate('normal', { automatic_trigger: true });
                const assistantMessages = st.chat.map((message, id) => ({ message, id }))
                    .filter(({ message }) => !message.is_user && !message.is_system)
                    .map(({ message, id }) => ({ id, text: message.mes, reasoning: message.extra?.reasoning ?? '', domReasoning: document.querySelector(`#chat .mes[mesid="${id}"] .mes_reasoning`)?.textContent ?? '' }));
                return {
                    assistantMessages, previews, events, toolCalls,
                    requestCount: requests.length,
                    registeredInRequest: requests[0]?.tools?.some(tool => tool.function?.name === toolName),
                    invocationCount: st.chat.flatMap(message => message.extra?.tool_invocations ?? []).length,
                    streamingStopped: st.streamingProcessor === null,
                };
            } finally {
                Date.now = originalNow;
                window.fetch = originalFetch;
                st.StreamingProcessor.prototype.onProgressStreaming = progress;
                if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor);
                else delete document.hidden;
                for (const [event, handler] of handlers) st.eventSource.removeListener(event, handler);
                ToolManager.unregisterFunctionTool(toolName);
            }
        }, scenario);

        expect(result.toolCalls).toBe(1);
        expect(result.registeredInRequest).toBe(true);
        expect(result.requestCount).toBe(scenario.stealth ? 1 : 2);
        expect(result.invocationCount).toBe(scenario.stealth ? 0 : 1);
        expect(result.streamingStopped).toBe(true);
        expect(result.previews.filter(preview => !preview.final)).toEqual([]);
        expect(result.events.tokens).toEqual(scenario.stealth ? [''] : ['', 'Answer after the tool.']);
        expect(result.assistantMessages.map(({ text, reasoning, domReasoning }) => ({ text, reasoning, domReasoning }))).toEqual(expectedMessages);
        expect(result.events.deleted).toHaveLength(scenario.reasoning ? 0 : 1);
        expect(result.events.reasoningDone).toEqual(scenario.reasoning
            ? [expect.objectContaining({ text: scenario.reasoning, id: result.assistantMessages[0]?.id })]
            : []);
        const ids = result.assistantMessages.map(message => message.id);
        expect(result.events.received).toEqual(ids);
        expect(result.events.rendered).toEqual(ids);
        expect(result.previews).toEqual(ids.map(id => ({ id, final: true })));
    });
}
