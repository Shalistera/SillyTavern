import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceArrayContents } from '../public/scripts/util/array-contents.js';

for (const length of [150000, 300000]) test(`replacing ${length} messages preserves the canonical array and every message reference`, () => {
    const messages = Array.from({ length }, (_, id) => ({ mes: `Message ${id}` }));
    const target = [{ mes: 'previous chat' }];
    const original = target;
    target.extensionState = 'preserved';
    replaceArrayContents(target, messages);
    assert.equal(target, original);
    assert.equal(target.length, messages.length);
    assert.ok(target.every((message, index) => message === messages[index]));
    assert.equal(target.extensionState, 'preserved');
    replaceArrayContents(target, [messages[7]]);
    assert.equal(target.length, 1);
    assert.equal(target[0], messages[7]);
    assert.equal(Object.hasOwn(target, length - 1), false);
    replaceArrayContents(target, []);
    assert.equal(target.length, 0);
});

test('replacement retains spread semantics for sparse arrays, self-replacement and custom iterators', () => {
    const item = { mes: 'Shared identity' };
    for (const source of [[, item, , undefined], 'A😀B', new Set([item, 'second'])]) {
        const expected = ['old'];
        expected.splice(0, expected.length, ...source);
        const actual = ['old'];
        replaceArrayContents(actual, source);
        assert.deepEqual(actual, expected);
        assert.equal(Object.keys(actual).length, actual.length, 'Array holes become own undefined slots, as with argument spread');
    }
    const self = [item, 'same array'];
    replaceArrayContents(self, self);
    assert.deepEqual(self, [item, 'same array']);
    assert.equal(self[0], item);
    const custom = [item];
    custom[Symbol.iterator] = function* () { yield 'custom first'; yield item; };
    const actual = [];
    replaceArrayContents(actual, custom);
    assert.deepEqual(actual, ['custom first', item]);
    assert.equal(actual[1], item);
});

test('invalid or failing source iteration leaves the previous chat intact', () => {
    const previous = { mes: 'Previous chat' };
    for (const source of [null, undefined, {}, { length: 1, 0: 'array-like' }]) {
        const target = [previous];
        assert.throws(() => replaceArrayContents(target, source), TypeError);
        assert.deepEqual(target, [previous]);
        assert.equal(target[0], previous);
    }
    const failure = new Error('Failed to read the next message');
    const source = {
        *[Symbol.iterator]() {
            yield { mes: 'Partial replacement' };
            throw failure;
        },
    };
    const target = [previous];
    assert.throws(() => replaceArrayContents(target, source), error => error === failure);
    assert.deepEqual(target, [previous]);
});
