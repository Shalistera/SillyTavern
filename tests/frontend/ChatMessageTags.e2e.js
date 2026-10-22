import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.beforeEach(async ({ page }) => {
    await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        data.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: data });
    });
    await testSetup.awaitST({ page });
    await page.locator('#chat .mes[type="welcome_prompt"]').waitFor();
    await page.evaluate(async () => {
        const tagsModule = await import('/scripts/tags.js');
        tagsModule.tags.splice(0, tagsModule.tags.length,
            { id: 'tag-a', name: 'Café, friends' },
            { id: 'tag-b', name: 'Science_Fiction' },
        );
        for (const key of Object.keys(tagsModule.tag_map)) delete tagsModule.tag_map[key];
        tagsModule.tag_map['tags-a.png'] = ['tag-a', 'missing-tag'];
        tagsModule.tag_map['tags-b.png'] = ['tag-b'];
        const chat = document.getElementById('chat');
        chat.replaceChildren();
        const addMessage = (id, avatar = 'tags-a.png') => {
            const message = document.createElement('div');
            message.className = 'mes';
            message.setAttribute('mesid', String(id));
            message.setAttribute('data-char-tags', 'Stale tag');
            message.setAttribute('data-char-tag-stale', '');
            const image = document.createElement('img');
            image.setAttribute('src', `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`);
            const wrapper = document.createElement('div');
            wrapper.className = 'avatar';
            wrapper.append(image);
            message.append(wrapper);
            chat.append(message);
            return message;
        };
        const attributes = id => Object.fromEntries([...chat.querySelector(`.mes[mesid="${id}"]`).attributes]
            .filter(attribute => attribute.name.startsWith('data-char-tag'))
            .map(attribute => [attribute.name, attribute.value]));
        window.messageTagsFixture = { tagsModule, addMessage, attributes };
    });
});

test('message tags preserve avatar mappings, normalization and stale tag removal', async ({ page }) => {
    const result = await page.evaluate(() => {
        const { tagsModule, addMessage, attributes } = window.messageTagsFixture;
        addMessage(0);
        addMessage(1, 'tags-b.png');
        addMessage(2, 'no-tags.png');
        tagsModule.applyCharacterTagsToMessageDivs();
        const assigned = [0, 1, 2].map(attributes);
        tagsModule.tags.splice(0);
        tagsModule.applyCharacterTagsToMessageDivs();
        return { assigned, cleared: [0, 1, 2].map(attributes) };
    });
    expect(result.assigned).toEqual([
        { 'data-char-tags': 'Café  friends', 'data-char-tag-cafe-friends': '' },
        { 'data-char-tags': 'Science_Fiction', 'data-char-tag-science-fiction': '' },
        {},
    ]);
    expect(result.cleared).toEqual([{}, {}, {}]);
});

test('message ID filters include zero and leave other messages unchanged', async ({ page }) => {
    const result = await page.evaluate(() => {
        const { tagsModule, addMessage, attributes } = window.messageTagsFixture;
        [0, 1, 2].forEach(id => addMessage(id));
        tagsModule.applyCharacterTagsToMessageDivs({ mesIds: 0 });
        const single = [0, 1, 2].map(attributes);
        tagsModule.applyCharacterTagsToMessageDivs({ mesIds: [2, 2, 9999] });
        return { single, subset: [0, 1, 2].map(attributes) };
    });
    const applied = { 'data-char-tags': 'Café  friends', 'data-char-tag-cafe-friends': '' };
    const stale = { 'data-char-tags': 'Stale tag', 'data-char-tag-stale': '' };
    expect(result.single).toEqual([applied, stale, stale]);
    expect(result.subset).toEqual([applied, stale, applied]);
});

test('large message batches use a bounded selector and only update requested direct children', async ({ page }) => {
    const result = await page.evaluate(() => {
        const { tagsModule, addMessage } = window.messageTagsFixture;
        const chat = document.getElementById('chat');
        const fragment = document.createDocumentFragment();
        for (let id = 0; id < 1200; id++) fragment.append(addMessage(id));
        chat.append(fragment);
        const unrelated = document.createElement('div');
        unrelated.className = 'style-pins';
        unrelated.setAttribute('data-char-tags', 'Unrelated');
        unrelated.innerHTML = '<div class="mes" mesid="0" data-char-tags="Nested unrelated"></div>';
        chat.append(unrelated);
        const originalChildren = $.fn.children;
        const selectors = [];
        $.fn.children = function (selector) {
            selectors.push(selector);
            return originalChildren.call(this, selector);
        };
        try {
            tagsModule.applyCharacterTagsToMessageDivs({ mesIds: Array.from({ length: 1200 }, (_, id) => id) });
        } finally {
            $.fn.children = originalChildren;
        }
        return {
            selectors,
            updated: chat.querySelectorAll(':scope > .mes[data-char-tag-cafe-friends]').length,
            unrelated: unrelated.getAttribute('data-char-tags'),
            nested: unrelated.firstElementChild.getAttribute('data-char-tags'),
        };
    });
    expect(result.updated).toBe(1200);
    expect(result.unrelated).toBe('Unrelated');
    expect(result.nested).toBe('Nested unrelated');
    expect(result.selectors.every(selector => selector.length < 128)).toBe(true);
});
