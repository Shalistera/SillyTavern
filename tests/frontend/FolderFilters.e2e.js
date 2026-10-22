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
        const st = await import('/script.js');
        const tagsModule = await import('/scripts/tags.js');
        const { groups } = await import('/scripts/group-chats.js');
        const { FILTER_TYPES } = await import('/scripts/filters.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.bogus_folders = true;
        const characters = Array.from({ length: 5 }, (_, id) => ({ name: `Character ${id}`, avatar: `folder-char-${id}.png` }));
        const groupData = [{ id: 42, name: 'Numeric group' }, { id: '0042', name: 'String group' }];
        const folders = [
            { id: 'a', name: 'Open', folder_type: 'OPEN' },
            { id: 'b', name: 'Closed B', folder_type: 'CLOSED' },
            { id: 'c', name: 'Closed C', folder_type: 'CLOSED' },
            { id: 'empty', name: 'Empty', folder_type: 'CLOSED' },
        ];
        st.characters.splice(0, st.characters.length, ...characters);
        groups.splice(0, groups.length, ...groupData);
        tagsModule.tags.splice(0, tagsModule.tags.length, ...folders);
        for (const key of Object.keys(tagsModule.tag_map)) delete tagsModule.tag_map[key];
        Object.assign(tagsModule.tag_map, {
            'folder-char-0.png': ['a'],
            'folder-char-1.png': ['a', 'b'],
            'folder-char-2.png': ['b', 'c'],
            'folder-char-4.png': {},
            42: ['a', 'c'],
            '0042': ['a'],
        });
        const entities = [...characters.map(st.characterToEntity), ...groupData.map(st.groupToEntity), ...folders.map(st.tagToEntity)];
        for (const folder of entities.filter(entity => entity.type === 'tag' && entity.id !== 'empty')) folder.entities = [entities[0]];
        const setTags = (selected = [], excluded = []) => st.entitiesFilter.setFilterData(FILTER_TYPES.TAG, { selected, excluded }, true);
        const keys = list => list.map(entity => `${entity.type}:${entity.id}`);
        setTags();
        st.entitiesFilter.setFilterData(FILTER_TYPES.SEARCH, '', true);
        window.folderFilterFixture = { st, tagsModule, FILTER_TYPES, entities, setTags, keys };
    });
});

test('global folder visibility preserves selected, excluded, hidden and empty-folder rules', async ({ page }) => {
    const result = await page.evaluate(() => {
        const { st, tagsModule, FILTER_TYPES, entities, setTags, keys } = window.folderFilterFixture;
        const filter = options => keys(tagsModule.filterByTagState(entities, { globalDisplayFilters: true, ...options }));
        const initial = filter();
        setTags(['b']);
        const selected = filter();
        setTags([], ['c']);
        const excluded = filter();
        setTags();
        const showHidden = filter({ filterHidden: false });
        st.entitiesFilter.setFilterData(FILTER_TYPES.SEARCH, 'searching', true);
        return { initial, selected, excluded, showHidden, searching: filter() };
    });
    expect(result.initial).toEqual(['character:0', 'character:3', 'character:4', 'group:0042', 'tag:a', 'tag:b', 'tag:c']);
    expect(result.selected).toEqual(['character:0', 'character:1', 'character:3', 'character:4', 'group:0042', 'tag:a', 'tag:c']);
    expect(result.excluded).toEqual(['character:0', 'character:3', 'character:4', 'group:42', 'group:0042', 'tag:a', 'tag:b']);
    expect(result.showHidden).toEqual(['character:0', 'character:1', 'character:2', 'character:3', 'character:4', 'group:42', 'group:0042', 'tag:a', 'tag:b', 'tag:c']);
    expect(result.searching).toEqual([...result.initial, 'tag:empty']);
});

test('folder sublists distinguish open and closed folders and refresh after tag edits', async ({ page }) => {
    const result = await page.evaluate(() => {
        const { tagsModule, entities, setTags, keys } = window.folderFilterFixture;
        const filter = (id, options = {}) => keys(tagsModule.filterByTagState(entities, { subForEntity: entities.find(entity => entity.type === 'tag' && entity.id === id), ...options }));
        const initial = filter('a');
        const closed = filter('b');
        const showHidden = filter('a', { filterHidden: false });
        setTags(['b']);
        const selected = filter('a');
        setTags();
        tagsModule.tag_map['folder-char-1.png'] = ['a'];
        const afterRetag = filter('a');
        entities.find(entity => entity.type === 'tag' && entity.id === 'c').item.folder_type = 'OPEN';
        const afterFolderType = filter('a');
        delete tagsModule.tag_map['0042'];
        const afterDelete = filter('a');
        return { initial, closed, showHidden, selected, afterRetag, afterFolderType, afterDelete };
    });
    expect(result.initial).toEqual(['character:0', 'group:0042']);
    expect(result.closed).toEqual(['character:1', 'character:2']);
    expect(result.showHidden).toEqual(['character:0', 'character:1', 'group:42', 'group:0042']);
    expect(result.selected).toEqual(['character:0', 'character:1', 'group:0042']);
    expect(result.afterRetag).toEqual(result.selected);
    expect(result.afterFolderType).toEqual(result.showHidden);
    expect(result.afterDelete).toEqual(['character:0', 'character:1', 'group:42']);
});

test('full character and group list retains folder members and hidden counts', async ({ page }) => {
    const result = await page.evaluate(() => {
        const { st, keys } = window.folderFilterFixture;
        const entities = st.getEntitiesList({ doFilter: true, doSort: false });
        return {
            visible: keys(entities),
            folders: entities.filter(entity => entity.type === 'tag').map(entity => ({ id: entity.id, members: keys(entity.entities), hidden: entity.hidden })),
        };
    });
    expect(result.visible).toEqual(['character:0', 'character:3', 'character:4', 'group:0042', 'tag:b', 'tag:c', 'tag:a']);
    expect(result.folders).toEqual([
        { id: 'b', members: ['character:1', 'character:2'], hidden: 0 },
        { id: 'c', members: ['character:2', 'group:42'], hidden: 0 },
        { id: 'a', members: ['character:0', 'group:0042'], hidden: 2 },
    ]);
});
