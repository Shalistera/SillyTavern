import { test, expect } from '@playwright/test';
import { runStreamingScenario, setupStreamingFixture } from '../util/streaming-fixture.mjs';

test.beforeEach(async ({ page }) => {
    await setupStreamingFixture(page);
});

test('background generation keeps every token and final message with fewer real DOM previews', async ({ page }) => {
    const foreground = await page.evaluate(runStreamingScenario, { hidden: false });
    const background = await page.evaluate(runStreamingScenario, { hidden: true });
    expect(foreground.previews.filter(x => !x.final)).toHaveLength(30);
    expect(background.previews.filter(x => !x.final)).toHaveLength(4);
    for (const result of [foreground, background]) {
        expect(result.emittedTokens).toBe(120);
        expect(result.latestToken).toBe(result.result);
        expect(result.finalMessage).toBe(result.result.trim());
        expect(result.finalSwipe).toBe(result.finalMessage);
        expect(result.finalReasoning).toBe('Thought 120');
        expect(result.finalSignature).toBe('signature-120');
        expect(result.finalToolCalls).toEqual([{ id: 'tool-120' }]);
        expect(result.strongCount).toBe(120);
        expect(result.domText).toContain('word 120');
        expect(result.previews.filter(x => x.final)).toEqual([{ elapsed: 1200, final: true, hidden: result === background }]);
    }
    expect(background.finalMessage).toBe(foreground.finalMessage);
    expect(background.domText).toBe(foreground.domText);
});

test('returning to the foreground restores the configured FPS during the same stream', async ({ page }) => {
    const result = await page.evaluate(runStreamingScenario, { hidden: true, visibleAt: 600 });
    const previews = result.previews.filter(x => !x.final);
    expect(previews.filter(x => x.hidden).map(x => x.elapsed)).toEqual([250, 500]);
    expect(previews.filter(x => !x.hidden).map(x => x.elapsed)).toEqual(Array.from({ length: 16 }, (_, i) => 600 + i * 40));
    expect(result.emittedTokens).toBe(120);
    expect(result.finalMessage).toBe(result.result.trim());
    expect(result.previews.at(-1)).toEqual({ elapsed: 1200, final: true, hidden: false });
});

test('a background stream shorter than one preview interval still flushes its final Markdown', async ({ page }) => {
    const result = await page.evaluate(runStreamingScenario, { hidden: true, count: 1 });
    expect(result.previews).toEqual([{ elapsed: 10, final: true, hidden: true }]);
    expect(result.emittedTokens).toBe(1);
    expect(result.finalMessage).toBe('**word** 1');
    expect(result.domText).toBe('word 1');
    expect(result.strongCount).toBe(1);
});

test('restoring a large neutral chat preserves the shared array without argument-count failure', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const st = await import('/script.js');
        const { restoreNeutralChat } = await import('/scripts/chats.js');
        const original = st.chat;
        st.setCharacterId(undefined);
        st.setCharacterName(st.neutralCharacterName);
        const messages = Array.from({ length: 200000 }, (_, id) => ({ id }));
        sessionStorage.setItem('neutralChat', JSON.stringify({ chat: messages, chat_metadata: { fixture: true } }));
        restoreNeutralChat();
        return { sameArray: original === st.chat, length: st.chat.length, allPresent: st.chat.every((message, index) => message.id === index), metadata: st.chat_metadata.fixture, storageCleared: sessionStorage.getItem('neutralChat') === null };
    });
    expect(result).toEqual({ sameArray: true, length: 200000, allPresent: true, metadata: true, storageCleared: true });
});
