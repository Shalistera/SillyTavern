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
});

test('world info search preserves input order, duplicate references, object identity and scores', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { FilterHelper, FILTER_TYPES } = await import('/scripts/filters.js');
        const { fuzzySearchWorldInfo } = await import('/scripts/power-user.js');
        const helper = new FilterHelper(() => {});
        const weaker = { uid: 7, key: ['travel'], content: 'A forest lies at the end of the road.' };
        const sameUid = { uid: 7, key: ['desert'], content: 'Dry sand.' };
        const stronger = { uid: 8, key: ['forest'], content: '' };
        const data = [weaker, sameUid, stronger, weaker];
        const term = 'forest';
        helper.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, term, true);
        const matches = fuzzySearchWorldInfo(data, term, helper.fuzzySearchCaches);
        const expected = data.filter(entry => matches.find(match => match.item === entry));
        const actual = helper.wiSearchFilter(data);
        const expectedScores = new Map(matches.map(match => [match.item.uid, match.score]));
        return {
            indices: actual.map(entry => data.indexOf(entry)),
            sameOrderAndReferences: actual.length === expected.length && actual.every((entry, index) => entry === expected[index]),
            includesSameUid: actual.includes(sameUid),
            scores: [...expectedScores].map(([uid, score]) => helper.getScore(FILTER_TYPES.WORLD_INFO_SEARCH, uid) === score),
            searchOrderDiffers: matches[0].item === stronger,
        };
    });
    expect(result).toEqual({ indices: [0, 2, 0], sameOrderAndReferences: true, includesSameUid: false, scores: [true, true], searchOrderDiffers: true });
});

test('persona search preserves file keys, repeated entries and description matches', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { FilterHelper, FILTER_TYPES } = await import('/scripts/filters.js');
        const { fuzzySearchPersonas, power_user } = await import('/scripts/power-user.js');
        power_user.personas = { 'a.png': 'Traveler', 'b.png': 'Forest', 'c.png': 'Forest', 'd.png': 'Desert' };
        power_user.persona_descriptions = { 'a.png': { description: 'A traveler from the forest.' } };
        const data = ['a.png', 'd.png', 'c.png', 'b.png', 'a.png', 'missing.png'];
        const helper = new FilterHelper(() => {});
        helper.setFilterData(FILTER_TYPES.PERSONA_SEARCH, 'forest', true);
        const matches = fuzzySearchPersonas(data, 'forest', helper.fuzzySearchCaches);
        const expected = data.filter(name => matches.find(match => match.item.key === name));
        const actual = helper.personaSearchFilter(data);
        const expectedScores = new Map(matches.map(match => [match.item.key, match.score]));
        return {
            actual, expected,
            scores: [...expectedScores].map(([key, score]) => helper.getScore(FILTER_TYPES.PERSONA_SEARCH, key) === score),
        };
    });
    expect(result.actual).toEqual(['a.png', 'c.png', 'b.png', 'a.png']);
    expect(result.actual).toEqual(result.expected);
    expect(result.scores).toEqual([true, true, true]);
});

test('world info and persona searches refresh matches after edits and preserve extended query semantics', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { FilterHelper, FILTER_TYPES } = await import('/scripts/filters.js');
        const power = await import('/scripts/power-user.js');
        const entries = Array.from({ length: 300 }, (_, uid) => ({ uid, key: [uid % 3 ? 'forest' : 'desert'], comment: uid % 2 ? 'Travel' : 'Café', content: `Chapter ${uid}` }));
        const names = entries.map(entry => `persona-${entry.uid}.png`);
        power.power_user.personas = Object.fromEntries(entries.map((entry, index) => [names[index], entry.key[0]]));
        power.power_user.persona_descriptions = Object.fromEntries(entries.map((entry, index) => [names[index], { description: entry.comment }]));
        const assertions = [];
        for (const [data, type, search] of [
            [entries, FILTER_TYPES.WORLD_INFO_SEARCH, power.fuzzySearchWorldInfo],
            [names, FILTER_TYPES.PERSONA_SEARCH, power.fuzzySearchPersonas],
        ]) {
            const helper = new FilterHelper(() => {});
            for (const term of ['', 'forest', '^desert', 'forest | café', '!forest', 'unlikelymissingterm']) {
                helper.setFilterData(type, term, true);
                const actual = helper.applyFilters(data);
                const results = term ? search(data, term, helper.fuzzySearchCaches) : [];
                const expected = !term ? data : data.filter(item => results.find(match => (type === FILTER_TYPES.WORLD_INFO_SEARCH ? match.item : match.item.key) === item));
                assertions.push(actual.length === expected.length && actual.every((item, index) => item === expected[index]));
            }
        }
        const helper = new FilterHelper(() => {});
        helper.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, 'newkeyword', true);
        const beforeEdit = helper.applyFilters(entries);
        entries[0].key = ['newkeyword'];
        const afterEdit = helper.applyFilters(entries);
        entries[0] = { uid: 0, key: ['desert'] };
        const afterReplace = helper.applyFilters(entries);
        const personaHelper = new FilterHelper(() => {});
        personaHelper.setFilterData(FILTER_TYPES.PERSONA_SEARCH, 'newkeyword', true);
        const personaBeforeEdit = personaHelper.applyFilters(names);
        power.power_user.personas[names[0]] = 'newkeyword';
        const personaAfterEdit = personaHelper.applyFilters(names);
        delete power.power_user.personas[names[0]];
        const personaAfterDelete = personaHelper.applyFilters(names);
        return {
            assertions,
            editCounts: [beforeEdit.length, afterEdit.length, afterReplace.length],
            personaEditCounts: [personaBeforeEdit.length, personaAfterEdit.length, personaAfterDelete.length],
        };
    });
    expect(result.assertions).toEqual(Array(12).fill(true));
    expect(result.editCounts).toEqual([0, 1, 0]);
    expect(result.personaEditCounts).toEqual([0, 1, 0]);
});
