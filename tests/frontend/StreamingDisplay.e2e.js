import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.beforeEach(testSetup.awaitST);

test('unchanged panel text reuses Markdown and DOM while regexes, hooks and sanitization stay live', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { StreamingDisplay } = await import('/scripts/streaming-display.js');
        const st = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const { MessageFormatter } = await import('/scripts/message-formatter.js');
        const { showdown, DOMPurify } = await import('/lib.js');
        power_user.markdown_escape_strings = '';
        extension_settings.regex = [];

        let conversions = 0;
        const NativeConverter = showdown.Converter;
        try {
            showdown.Converter = function (...args) {
                const converter = new NativeConverter(...args);
                const makeHtml = converter.makeHtml;
                converter.makeHtml = function (...args) {
                    conversions++;
                    return makeHtml.apply(this, args);
                };
                return converter;
            };
            st.reloadMarkdownProcessor();
        } finally {
            showdown.Converter = NativeConverter;
        }
        let hooks = 0;
        let marker = 'initial';
        MessageFormatter.addHook(html => {
            hooks++;
            return `${html}<span data-panel-hook="${marker}">hook</span><img src="x" onerror="window.unsafePanel=true">`;
        });
        let sanitizations = 0;
        const sanitize = DOMPurify.sanitize;
        DOMPurify.sanitize = function (...args) {
            sanitizations++;
            return sanitize.apply(this, args);
        };
        const display = new StreamingDisplay().show();
        try {
            display.updateReasoning('**Thinking** placeholder').updateContent('**Body** placeholder');
            const reasoning = document.querySelector('.streaming-display-reasoning-content strong');
            const body = document.querySelector('.streaming-display-text-content strong');
            for (let index = 0; index < 5; index++) {
                display.updateReasoning('**Thinking** placeholder').updateContent('**Body** placeholder');
            }
            const repeated = {
                conversions, hooks, sanitizations,
                stableReasoning: document.querySelector('.streaming-display-reasoning-content strong') === reasoning,
                stableBody: document.querySelector('.streaming-display-text-content strong') === body,
            };
            marker = 'updated';
            display.updateReasoning('**Thinking** placeholder').updateContent('**Body** placeholder');
            const afterHook = {
                conversions, hooks, sanitizations,
                markers: [...document.querySelectorAll('[data-panel-hook]')].map(node => node.dataset.panelHook),
                unsafe: !!document.querySelector('.streaming-display [onerror]'),
            };
            extension_settings.regex = [{
                id: 'panel-regex', scriptName: 'Panel test', findRegex: '/placeholder/g',
                replaceString: 'changed by regex', trimStrings: [], placement: [2],
                disabled: false, markdownOnly: true, promptOnly: false,
                runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
            }];
            display.updateContent('**Body** placeholder');
            return { repeated, afterHook, afterRegex: { conversions, hooks, sanitizations, text: document.querySelector('.streaming-display-text-content').textContent } };
        } finally {
            DOMPurify.sanitize = sanitize;
            display.hide({ instant: true });
        }
    });
    expect(result.repeated).toEqual({ conversions: 2, hooks: 12, sanitizations: 12, stableReasoning: true, stableBody: true });
    expect(result.afterHook).toEqual({ conversions: 2, hooks: 14, sanitizations: 14, markers: ['updated', 'updated'], unsafe: false });
    expect(result.afterRegex).toMatchObject({ conversions: 3, hooks: 15, sanitizations: 15 });
    expect(result.afterRegex.text).toContain('changed by regex');
});

test('hidden and reused panels reset cached content and keep separate instances independent', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { StreamingDisplay } = await import('/scripts/streaming-display.js');
        const first = new StreamingDisplay().show({ label: 'first' });
        const firstElement = document.querySelector('.streaming-display');
        first.updateContent('**First answer**').updateReasoning('First thought');
        const originalBody = firstElement.querySelector('.streaming-display-text-content strong');
        const second = new StreamingDisplay().show({ label: 'second' });
        second.updateContent('**Second answer**');
        first.updateContent('**First answer**');
        const independent = [...document.querySelectorAll('.streaming-display-text-content')].map(node => node.textContent);
        first.updateContent('').updateReasoning('');
        const emptyIgnored = firstElement.querySelector('.streaming-display-text-content').textContent;
        first.complete({ delay: null });
        const complete = first.isComplete;
        first.hide({ instant: true });
        first.updateContent('Must stay hidden');
        const hidden = { hasContent: first.hasContent, complete: first.isComplete, stopped: first.isStopped };
        first.show({ label: 'reused' });
        const reused = [...document.querySelectorAll('.streaming-display')].at(-1);
        const reset = { hasContent: first.hasContent, text: reused.querySelector('.streaming-display-text-content').textContent, reasoning: reused.querySelector('.streaming-display-reasoning-content').textContent };
        first.updateContent('**First answer**');
        const restored = { text: reused.querySelector('.streaming-display-text-content').textContent, newNode: reused.querySelector('.streaming-display-text-content strong') !== originalBody };
        first.markStopped();
        const stopped = first.isStopped;
        first.show();
        const restarted = { stopped: first.isStopped, hasContent: first.hasContent };
        first.hide({ instant: true });
        second.hide({ instant: true });
        return { independent, emptyIgnored, complete, hidden, reset, restored, stopped, restarted };
    });
    expect(result).toEqual({
        independent: ['First answer', 'Second answer'], emptyIgnored: 'First answer', complete: true,
        hidden: { hasContent: false, complete: false, stopped: false },
        reset: { hasContent: false, text: '', reasoning: '' }, restored: { text: 'First answer', newNode: true },
        stopped: true, restarted: { stopped: false, hasContent: false },
    });
});
