import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.beforeEach(async ({ page }) => {
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
});

test('legacy plain text preserves environment setup without executing absent macros', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { evaluateMacros, MacrosParser } = await import('/scripts/macros.js');
        const { chat_metadata } = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.experimental_macro_engine = false;
        power_user.prefer_character_prompt = true;
        let reads = 0;
        let registrations = 0;
        let executions = 0;
        let postProcesses = 0;
        const registered = () => { executions++; return 'must not execute'; };
        MacrosParser.registerMacro('plaintextProbe', registered);
        const env = {};
        Object.defineProperty(env, 'charPrompt', { enumerable: true, get() { reads++; return 'character prompt'; } });
        Object.defineProperty(env, 'plaintextProbe', { enumerable: true, set(value) { if (value === registered) registrations++; } });
        delete chat_metadata.chat_id_hash;
        chat_metadata.main_chat = 'macro-plain-text-regression';
        const inputs = ['ordinary text', '<em>formatted text</em>', '<USERLAND> literal', '<user > literal', '{single} braces', '\\{escaped\\}', '日本語 👩🏽‍💻'];
        const outputs = inputs.map(input => evaluateMacros(input, env, value => { postProcesses++; return value; }));
        MacrosParser.unregisterMacro('plaintextProbe');
        return { inputs, outputs, reads, registrations, executions, postProcesses, hashInitialized: typeof chat_metadata.chat_id_hash === 'number' };
    });
    expect(result.outputs).toEqual(result.inputs);
    expect(result).toMatchObject({ reads: 14, registrations: 7, executions: 0, postProcesses: 0, hashInitialized: true });
});

test('legacy markers still introduce macros and preserve replacement side effects and ordering', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { evaluateMacros, MacrosParser } = await import('/scripts/macros.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.experimental_macro_engine = false;
        const calls = [];
        MacrosParser.registerMacro('plaintextDynamic', () => { calls.push('macro'); return 'resolved'; });
        const env = {
            user: () => { calls.push('user'); return '{{plaintextDynamic}}'; },
            char: 'character', group: 'group',
        };
        const output = evaluateMacros('<uSeR> <BOT> <CHAR> <GROUP> <CHARIFNOTGROUP>', env, value => {
            calls.push(`post:${value}`);
            return value;
        });
        MacrosParser.unregisterMacro('plaintextDynamic');
        return { output, calls };
    });
    expect(result).toEqual({
        output: 'resolved character character group group',
        calls: ['user', 'post:{{plaintextDynamic}}', 'post:character', 'post:character', 'post:group', 'post:group', 'macro', 'post:resolved'],
    });
});

test('new engine runs environment providers and both processor stages for plain text', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { substituteParams } = await import('/script.js');
        const { macros } = await import('/scripts/macros/macro-system.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.experimental_macro_engine = true;
        const calls = [];
        macros.envBuilder.registerProvider(env => { calls.push('provider'); env.testProbe = 'provider value'; });
        const before = (text, env) => {
            calls.push(['before', Object.isFrozen(env), env.testProbe]);
            return text + '|before';
        };
        const after = (text, env) => {
            calls.push(['after', Object.isFrozen(env), env.testProbe]);
            return text + '|after {{unused}}';
        };
        macros.engine.addPreProcessor(before);
        macros.engine.addPostProcessor(after);
        try {
            const output = substituteParams('ordinary text', { dynamicMacros: { unused: () => { calls.push('unexpected macro'); return 'bad'; } } });
            return { output, calls };
        } finally {
            macros.engine.removePreProcessor(before);
            macros.engine.removePostProcessor(after);
        }
    });
    expect(result).toEqual({
        output: 'ordinary text|before|after {{unused}}',
        calls: ['provider', ['before', true, 'provider value'], ['after', true, 'provider value']],
    });
});

test('new engine still parses macros introduced by processors and cleans escaped plain text', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { substituteParams } = await import('/script.js');
        const { macros } = await import('/scripts/macros/macro-system.js');
        const { ELSE_MARKER } = await import('/scripts/macros/definitions/core-macros.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.experimental_macro_engine = true;
        let executions = 0;
        const before = text => text === 'inject here' ? '{{probe}}' : text;
        macros.engine.addPreProcessor(before);
        try {
            const injected = substituteParams('inject here', { dynamicMacros: { probe: () => { executions++; return 'injected macro'; } } });
            const escaped = substituteParams('escaped \\{\\{probe\\}\\}' + ELSE_MARKER);
            const legacy = substituteParams('<USER>', { name1Override: 'user name' });
            const unknown = substituteParams('literal {{unknownMacroForPlainTextTest}}');
            return { injected, escaped, legacy, unknown, executions };
        } finally {
            macros.engine.removePreProcessor(before);
        }
    });
    expect(result).toEqual({ injected: 'injected macro', escaped: 'escaped {{probe}}', legacy: 'user name', unknown: 'literal {{unknownMacroForPlainTextTest}}', executions: 1 });
});

test('an empty preprocessor result retains the existing invalid-parse fallback', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { substituteParams } = await import('/script.js');
        const { macros } = await import('/scripts/macros/macro-system.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.experimental_macro_engine = true;
        let posts = 0;
        const before = () => '';
        const after = text => { posts++; return text + 'processed'; };
        macros.engine.addPreProcessor(before);
        macros.engine.addPostProcessor(after);
        try {
            return { output: substituteParams('original input'), posts };
        } finally {
            macros.engine.removePreProcessor(before);
            macros.engine.removePostProcessor(after);
        }
    });
    expect(result).toEqual({ output: 'original input', posts: 0 });
});
