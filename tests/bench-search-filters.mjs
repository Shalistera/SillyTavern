// Compare the real browser FilterHelper and Fuse implementation using synthetic data.
// Example: node tests/bench-search-filters.mjs --baseline bebe62bda --rounds 7
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

const { values } = parseArgs({ options: {
    baseline: { type: 'string', default: 'bebe62bda' },
    rounds: { type: 'string', default: '7' },
    counts: { type: 'string', default: '1000,5000,10000' },
    help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
    console.log('Usage: ST_BASE_URL=http://127.0.0.1:18349 node tests/bench-search-filters.mjs [--baseline REF] [--rounds N] [--counts 1000,5000,10000]\n'
        + 'Alternates baseline/current filters in one browser; measures cold Fuse search and cached-result filtering separately.\n'
        + 'All fixtures are in memory, settings saves are intercepted, and no user data is changed.');
    process.exit(0);
}
const rounds = Number(values.rounds);
const counts = values.counts.split(',').map(Number);
assert.ok([rounds, ...counts].every(number => Number.isSafeInteger(number) && number > 0), 'Use positive integer rounds and counts.');
const gitOptions = { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' };
const baseline = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${values.baseline}^{commit}`], gitOptions).trim();
const source = execFileSync('git', ['show', `${baseline}:public/scripts/filters.js`], gitOptions);
const baseURL = process.env.ST_BASE_URL || 'http://127.0.0.1:18349';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ baseURL });
await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
await page.route('**/api/settings/get', async route => {
    const response = await route.fetch();
    const data = await response.json();
    const settings = JSON.parse(data.settings);
    settings.firstRun = false;
    data.settings = JSON.stringify(settings);
    await route.fulfill({ response, json: data });
});

try {
    await testSetup.awaitST({ page });
    await page.locator('#chat .mes[type="welcome_prompt"]').waitFor();
    const results = await page.evaluate(async ({ source, counts, rounds }) => {
        const current = await import('/scripts/filters.js');
        const power = await import('/scripts/power-user.js');
        const resolvedSource = source.replace(/from '\.\//g, `from '${location.origin}/scripts/`);
        const moduleURL = URL.createObjectURL(new Blob([resolvedSource], { type: 'text/javascript' }));
        const baseline = await import(moduleURL);
        URL.revokeObjectURL(moduleURL);
        const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const samples = [];
        const originalDebug = console.debug;
        console.debug = () => {};
        try {
            for (const count of counts) {
                for (const category of ['worldInfo', 'personas']) {
                    const data = Array.from({ length: count }, (_, id) => category === 'worldInfo'
                        ? { uid: id, key: ['forest', `location ${id}`], comment: `Forest clearing ${id}`, content: `Forest lore ${id}. A quiet road passes through a green valley.`, group: 'travel', keysecondary: [] }
                        : `benchmark-persona-${id}.png`);
                    if (category === 'personas') {
                        power.power_user.personas = Object.fromEntries(data.map((key, id) => [key, `Forest traveler ${id}`]));
                        power.power_user.persona_descriptions = Object.fromEntries(data.map((key, id) => [key, { description: `A traveler of the forest, number ${id}.` }]));
                    }
                    for (const term of ['forest', 'unlikelymissingterm']) {
                        const type = category === 'worldInfo' ? current.FILTER_TYPES.WORLD_INFO_SEARCH : current.FILTER_TYPES.PERSONA_SEARCH;
                        const method = category === 'worldInfo' ? 'wiSearchFilter' : 'personaSearchFilter';
                        const helpers = Object.fromEntries(Object.entries({ baseline, current }).map(([name, implementation]) => {
                            const helper = new implementation.FilterHelper(() => {});
                            helper.setFilterData(type, term, true);
                            return [name, helper];
                        }));
                        // Warm both versions before collecting alternated samples.
                        for (const helper of Object.values(helpers)) helper[method](data);
                        const timings = { baseline: { cold: [], cached: [] }, current: { cold: [], cached: [] } };
                        for (let round = 0; round < rounds; round++) {
                            const order = round % 2 ? ['current', 'baseline'] : ['baseline', 'current'];
                            for (const name of order) {
                                const helper = helpers[name];
                                for (const phase of ['cold', 'cached']) {
                                    helper.clearScoreCache();
                                    if (phase === 'cold') helper.clearFuzzySearchCaches();
                                    const start = performance.now();
                                    const result = helper[method](data);
                                    const durationMs = performance.now() - start;
                                    timings[name][phase].push(durationMs);
                                    const expected = term === 'forest' ? data : [];
                                    if (result.length !== expected.length || result.some((item, index) => item !== expected[index])) {
                                        throw new Error(`${name} ${category} results changed for ${term}`);
                                    }
                                }
                            }
                        }
                        const summary = Object.fromEntries(Object.entries(timings).map(([name, phases]) => [name,
                            Object.fromEntries(Object.entries(phases).map(([phase, values]) => [phase, { medianMs: median(values), samplesMs: values }])),
                        ]));
                        samples.push({ category, count, term, matching: term === 'forest' ? count : 0, summary });
                    }
                }
            }
        } finally {
            console.debug = originalDebug;
        }
        return samples;
    }, { source, counts, rounds });
    console.log(JSON.stringify({ baseline, baseURL, rounds, results,
        note: 'Cold includes actual Fuse indexing/search plus score caching and filtering. Cached reuses Fuse results and includes score caching plus filtering. Timings exclude DOM pagination and vary with machine load.',
    }, null, 2));
} finally {
    await browser.close();
}
