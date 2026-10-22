import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

const templateNames = ['help', 'hotkeys', 'formatting', 'welcome', 'welcomePrompt', 'assistantNote'];
const messageNames = ['help', 'hotkeys', 'formatting', 'welcome', 'welcome_prompt', 'assistant_note'];
const templatePattern = /\/scripts\/templates\/(help|hotkeys|formatting|welcome|welcomePrompt|assistantNote)\.html$/;

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
});

test('startup requests independent templates together and preserves message contents and metadata', async ({ page }) => {
    const requests = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(templatePattern, async route => {
        requests.push(new URL(route.request().url()).pathname.split('/').at(-1).replace('.html', ''));
        await gate;
        await route.continue();
    });
    // No template may finish until all six have started. A serial loader cannot pass this gate.
    let initializationError;
    const initialized = testSetup.awaitST({ page }).catch(error => { initializationError = error; });
    try {
        await expect.poll(() => requests.length, { timeout: 15000 }).toBe(templateNames.length);
    } finally {
        release();
    }
    await initialized;
    expect(initializationError).toBeUndefined();
    expect([...requests].sort()).toEqual([...templateNames].sort());

    const result = await page.evaluate(async ({ templateNames, messageNames }) => {
        const app = await import('/script.js');
        const { renderTemplateAsync } = await import('/scripts/templates.js');
        const { initSystemMessages, system_messages, SAFETY_CHAT } = await import('/scripts/system-messages.js');
        const expected = await Promise.all(templateNames.map(name => renderTemplateAsync(name, name === 'welcome' ? { displayVersion: app.displayVersion } : {})));
        const contents = messageNames.map(name => system_messages[name].mes);
        const initial = JSON.stringify(system_messages);
        const originalMessages = system_messages;
        const originalSafety = SAFETY_CHAT;
        await initSystemMessages();
        return {
            expected,
            contents,
            keys: Object.keys(system_messages),
            metadata: messageNames.map(name => ({
                name: system_messages[name].name,
                avatar: system_messages[name].force_avatar,
                user: system_messages[name].is_user,
                system: system_messages[name].is_system,
                extra: system_messages[name].extra,
            })),
            name: app.systemUserName,
            avatar: app.system_avatar,
            sameMessages: originalMessages === system_messages && initial === JSON.stringify(system_messages),
            sameSafety: originalSafety === SAFETY_CHAT && SAFETY_CHAT.length === 1,
        };
    }, { templateNames, messageNames });

    expect(result.contents).toEqual(result.expected);
    expect(result.keys).toEqual(['help', 'slash_commands', 'hotkeys', 'formatting', 'macros', 'welcome', 'empty', 'generic', 'welcome_prompt', 'assistant_note']);
    expect(result.sameMessages).toBe(true);
    expect(result.sameSafety).toBe(true);
    for (let index = 0; index < result.metadata.length; index++) {
        expect(result.metadata[index]).toEqual({
            name: result.name,
            avatar: result.avatar,
            user: false,
            system: true,
            extra: index < 3 ? { swipeable: false } : index === 3 ? { swipeable: false, uses_system_ui: true } : { swipeable: false, uses_system_ui: true, isSmallSys: true },
        });
    }
    expect(requests).toHaveLength(templateNames.length);
});

test('one unavailable startup template does not discard other messages and remains retryable', async ({ page }) => {
    let requests = 0;
    await page.route('**/scripts/templates/help.html', route => {
        requests++;
        return requests === 1 ? route.fulfill({ status: 503, body: 'Temporarily unavailable' }) : route.continue();
    });
    await testSetup.awaitST({ page });
    const result = await page.evaluate(async () => {
        const { initSystemMessages, system_messages, SAFETY_CHAT } = await import('/scripts/system-messages.js');
        const firstHelp = system_messages.help.mes;
        const welcome = system_messages.welcome.mes;
        const hotkeys = system_messages.hotkeys.mes;
        await initSystemMessages();
        return {
            firstHelp,
            help: system_messages.help.mes,
            welcome,
            hotkeys,
            unchanged: welcome === system_messages.welcome.mes && hotkeys === system_messages.hotkeys.mes,
            safetyCount: SAFETY_CHAT.length,
        };
    });
    expect(result.firstHelp).toBeUndefined();
    expect(result.help).toBeTruthy();
    expect(result.welcome).toBeTruthy();
    expect(result.hotkeys).toBeTruthy();
    expect(result.unchanged).toBe(true);
    expect(result.safetyCount).toBe(1);
    expect(requests).toBe(2);
});
