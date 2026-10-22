import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { testSetup } from './frontend/frontent-test-utils.js';

const baseURL = process.env.ST_BASE_URL || 'http://127.0.0.1:18349';
const baseline = process.env.ST_MACRO_BASELINE || 'bebe62bda';
const checkOnly = process.env.ST_MACRO_CHECK_ONLY === '1';
const sources = ['scripts/macros.js', 'scripts/macros/engine/MacroEngine.js'].map(file => [file, execFileSync('git', ['show', `${baseline}:public/${file}`], { encoding: 'utf8' })]);
const browser = await chromium.launch();
const results = [];
try {
    for (const implementation of (checkOnly ? ['baseline', 'current'] : ['baseline', 'current', 'current', 'baseline'])) {
        const page = await browser.newPage({ baseURL });
        if (implementation === 'baseline') {
            for (const [file, body] of sources) {
                await page.route(`**/${file}`, route => route.fulfill({ contentType: 'application/javascript', body }));
            }
        }
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
        const result = await page.evaluate(async ({ checkOnly }) => {
            const st = await import('/script.js');
            const { evaluateMacros, MacrosParser } = await import('/scripts/macros.js');
            const { macros } = await import('/scripts/macros/macro-system.js');
            const { power_user } = await import('/scripts/power-user.js');
            const { runRegexScript } = await import('/scripts/extensions/regex/engine.js');
            const rows = [];
            const measure = (name, iterations, callback) => {
                if (checkOnly) return;
                for (let index = 0; index < 20; index++) callback();
                const start = performance.now();
                for (let index = 0; index < iterations; index++) callback();
                rows.push({ name, iterations, ms: +(performance.now() - start).toFixed(2) });
            };
            const env = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`macro${index}`, 'example']));
            for (const size of [32, 4096, 32768, 131072]) {
                const text = 'The traveler walked through the quiet forest. '.repeat(Math.ceil(size / 45)).slice(0, size);
                const count = size >= 32768 ? 100 : 1000;
                power_user.experimental_macro_engine = false;
                measure(`legacy-evaluate-${size}`, count, () => evaluateMacros(text, env, value => value));
                measure(`legacy-substitute-${size}`, count, () => st.substituteParams(text));
                power_user.experimental_macro_engine = true;
                measure(`engine-substitute-${size}`, count, () => st.substituteParams(text));
            }
            for (const experimental of [false, true]) {
                power_user.experimental_macro_engine = experimental;
                const regex = { findRegex: '/(word)/g', replaceString: '<em>$1</em>', trimStrings: [], substituteRegex: 0 };
                measure(`regex-1000-matches-engine-${experimental}`, 10, () => runRegexScript(regex, 'word '.repeat(1000)));
            }

            // Differential checks use deterministic macro values and preserve every hook.
            st.chat_metadata.main_chat = 'macro-performance-differential';
            delete st.chat_metadata.chat_id_hash;
            const inputs = [
                '', 'plain text', '{', '}', '{single}', 'trailing {', '\\{escaped\\}',
                '日本語 👩🏽‍💻', '\ud800', 'line\r\nsecond\tline', '<em>ordinary HTML</em>',
                '<USERLAND>', '<user >', '<USER>', '<BOT> <CHAR> <GROUP> <CHARIFNOTGROUP>',
                '{{probe}}', '{{unknownPlainTextMacro}}', '{{', '{{probe', '{{{probe}}}',
                '{{setvar::perfcheck::2}}{{incvar::perfcheck}}{{getvar::perfcheck}}',
                '{{pick::first::second}}', '{{trim}}\ntext\n{{trim}}', '[insert]', '[empty]',
                '\\{\\{probe\\}\\}',
            ];
            let seed = 42;
            const alphabet = 'ab{}<>\\ 日本語\n';
            for (let iteration = 0; iteration < 100; iteration++) {
                let text = '';
                for (let index = 0; index < 40; index++) {
                    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                    text += alphabet[seed % alphabet.length];
                }
                inputs.push(text);
            }
            const compatibility = [];
            power_user.experimental_macro_engine = false;
            MacrosParser.registerMacro('probe', () => 'registered value');
            let posts = 0;
            for (const input of inputs) {
                compatibility.push(st.substituteParams(input, {
                    name1Override: '{{probe}}', name2Override: 'character', groupOverride: 'group',
                    postProcessFn: value => { posts++; return value; },
                }));
            }
            compatibility.push({ legacyPosts: posts, hashInitialized: typeof st.chat_metadata.chat_id_hash === 'number' });
            MacrosParser.unregisterMacro('probe');
            power_user.experimental_macro_engine = true;
            let providers = 0;
            let beforeCalls = 0;
            let afterCalls = 0;
            let macroCalls = 0;
            macros.envBuilder.registerProvider(() => { providers++; });
            const before = text => { beforeCalls++; return text === '[empty]' ? '' : text.replace('[insert]', '{{probe}}'); };
            const after = text => { afterCalls++; return text + '|post'; };
            macros.engine.addPreProcessor(before);
            macros.engine.addPostProcessor(after);
            try {
                for (const input of inputs) {
                    compatibility.push(st.substituteParams(input, {
                        name1Override: 'user', name2Override: 'character',
                        dynamicMacros: { probe: () => { macroCalls++; return 'dynamic value'; } },
                    }));
                }
            } finally {
                macros.engine.removePreProcessor(before);
                macros.engine.removePostProcessor(after);
            }
            compatibility.push({ providers, beforeCalls, afterCalls, macroCalls });
            return { rows, compatibility };
        }, { checkOnly });
        if (results.length > 0) assert.deepEqual(result.compatibility, results[0].compatibility, `${implementation} macro behavior changed`);
        results.push({ implementation, baseline, ...result });
        await page.close();
    }
    console.log(JSON.stringify(results.map(({ compatibility, ...result }) => ({ ...result, compatibilityChecks: compatibility.length })), null, 2));
} finally {
    await browser.close();
}
