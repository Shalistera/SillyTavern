// Compare folder filtering in the real application; all fixture data stays in browser memory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

const { values } = parseArgs({ options: {
    baseline: { type: 'string', default: 'bebe62bda' },
    rounds: { type: 'string', default: '7' },
    characters: { type: 'string', default: '5000' },
    folders: { type: 'string', default: '500' },
    help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
    console.log('Usage: ST_BASE_URL=http://127.0.0.1:18349 node tests/bench-folder-filters.mjs [--baseline REF] [--rounds N] [--characters N] [--folders N]\n'
        + 'One browser, two isolated pages, sequential alternating baseline/current runs.\n'
        + 'Measures the final folder visibility pass and the full getEntitiesList call, excluding DOM rendering.\n'
        + 'All fixtures are in memory and settings saves are intercepted.');
    process.exit(0);
}
const rounds = Number(values.rounds);
const characterCount = Number(values.characters);
const folderCount = Number(values.folders);
assert.ok([rounds, characterCount, folderCount].every(number => Number.isSafeInteger(number) && number > 0), 'Use positive integer counts.');
const gitOptions = { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' };
const baseline = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${values.baseline}^{commit}`], gitOptions).trim();
const source = execFileSync('git', ['show', `${baseline}:public/scripts/tags.js`], gitOptions);
const baseURL = process.env.ST_BASE_URL || 'http://127.0.0.1:18349';
const browser = await chromium.launch({ headless: true });
const pages = {};
const samples = { baseline: { global: [], fullList: [] }, current: { global: [], fullList: [] } };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
    for (const name of Object.keys(samples)) {
        const page = await browser.newPage({ baseURL });
        pages[name] = page;
        if (name === 'baseline') await page.route('**/scripts/tags.js', route => route.fulfill({ contentType: 'text/javascript', body: source }));
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
        await page.evaluate(async ({ characterCount, folderCount }) => {
            const st = await import('/script.js');
            const tagsModule = await import('/scripts/tags.js');
            const { groups } = await import('/scripts/group-chats.js');
            const { FILTER_TYPES } = await import('/scripts/filters.js');
            const { power_user } = await import('/scripts/power-user.js');
            power_user.bogus_folders = true;
            power_user.fuzzy_search = false;
            groups.splice(0);
            const folders = Array.from({ length: folderCount }, (_, id) => ({ id: `folder-${id}`, name: `Folder ${id}`, folder_type: id % 2 ? 'OPEN' : 'CLOSED', sort_order: id }));
            tagsModule.tags.splice(0, tagsModule.tags.length, ...folders);
            for (const key of Object.keys(tagsModule.tag_map)) delete tagsModule.tag_map[key];
            st.characters.splice(0, st.characters.length, ...Array.from({ length: characterCount }, (_, id) => {
                const avatar = `benchmark-${id}.png`;
                // Half of characters have no closed folder; those require a complete scan before this optimization.
                const folderId = id % 2 ? (2 * id + 1) % folderCount : id % folderCount;
                tagsModule.tag_map[avatar] = [`folder-${folderId}`, `folder-${(2 * id + 3) % folderCount}`, 'ordinary-tag'];
                return { name: `Character ${id}`, avatar, data: { name: `Character ${id}` } };
            }));
            st.entitiesFilter.setFilterData(FILTER_TYPES.TAG, { selected: [], excluded: [] }, true);
            st.entitiesFilter.setFilterData(FILTER_TYPES.SEARCH, '', true);
            const entities = st.getEntitiesList({ doFilter: false, doSort: false });
            const snapshot = result => result.map(entity => ({ type: entity.type, id: entity.id, hidden: entity.hidden, entities: entity.entities?.map(item => `${item.type}:${item.id}`), isUseless: entity.isUseless }));
            const measure = phase => {
                const start = performance.now();
                const result = phase === 'global'
                    ? tagsModule.filterByTagState(entities, { globalDisplayFilters: true })
                    : st.getEntitiesList({ doFilter: true, doSort: false });
                const durationMs = performance.now() - start;
                return { durationMs, result: snapshot(result) };
            };
            window.folderBenchmark = { measure };
            measure('global');
            measure('fullList');
        }, { characterCount, folderCount });
    }
    for (let round = 0; round < rounds; round++) {
        const order = round % 2 ? ['current', 'baseline'] : ['baseline', 'current'];
        const expected = {};
        for (const name of order) {
            for (const phase of ['global', 'fullList']) {
                const sample = await pages[name].evaluate(phase => window.folderBenchmark.measure(phase), phase);
                samples[name][phase].push(sample.durationMs);
                if (expected[phase]) assert.deepEqual(sample.result, expected[phase]);
                else expected[phase] = sample.result;
            }
        }
    }
    const summary = Object.fromEntries(Object.entries(samples).map(([name, phases]) => [name,
        Object.fromEntries(Object.entries(phases).map(([phase, values]) => [phase, { medianMs: median(values), samplesMs: values }])),
    ]));
    console.log(JSON.stringify({ baseline, characterCount, folderCount, rounds, summary,
        note: 'Results including folder membership, hidden counts and useless flags are checked equal after every run. Timings exclude DOM rendering and vary with machine load.',
    }, null, 2));
} finally {
    await browser.close();
}
