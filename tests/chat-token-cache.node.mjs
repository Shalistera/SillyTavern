import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatTokenCache, TOKEN_CACHE_PREFIX } from '../public/scripts/util/chat-token-cache.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function fixture(initial = {}, options = {}) {
    const data = new Map(Object.entries(initial));
    const calls = [];
    const errors = [];
    const store = {
        async getItem(key) { calls.push(['get', key]); return structuredClone(data.get(key)); },
        async setItem(key, value) { calls.push(['set', key, structuredClone(value)]); data.set(key, structuredClone(value)); },
        async removeItem(key) { calls.push(['remove', key]); data.delete(key); },
        async keys() { calls.push(['keys']); return [...data.keys()]; },
    };
    const cache = new ChatTokenCache(store, { ...options, onError: (...args) => errors.push(args) });
    return { data, calls, store, cache, errors };
}

test('loads only requested chats and saves only dirty buckets, preserving zero counts and unusual IDs', async () => {
    const { cache, calls, data } = fixture({ tokenCache: { giant: 'legacy' }, [TOKEN_CACHE_PREFIX + '__proto__']: { zero: 0, bad: 'not a count' } });
    assert.deepEqual(calls, []);
    const a = cache.acquire('__proto__');
    await a.ready;
    assert.equal(a.values.zero, 0);
    assert.equal(a.values.bad, undefined);
    await cache.save();
    assert.deepEqual(calls, [['get', TOKEN_CACHE_PREFIX + '__proto__']]);
    cache.set(a, 'x', 12);
    await cache.save();
    await cache.save();
    assert.deepEqual(data.get(TOKEN_CACHE_PREFIX + '__proto__'), { zero: 0, x: 12 });
    assert.equal(calls.filter(x => x[0] === 'set').length, 1);
    cache.release(a);
});

test('disk load merges without replacing counts computed synchronously while it was pending', async () => {
    const { cache, store } = fixture();
    const gate = deferred();
    store.getItem = () => gate.promise;
    const a = cache.acquire('a');
    cache.set(a, 'fresh', 9);
    gate.resolve({ fresh: 1, diskOnly: 3 });
    await a.ready;
    assert.deepEqual({ ...a.values }, { fresh: 9, diskOnly: 3 });
    cache.release(a);
});

test('mutations during a pending write remain dirty and are saved by the next flush', async () => {
    const { cache, store, data } = fixture();
    const a = cache.acquire('a');
    await a.ready;
    const started = deferred();
    const gate = deferred();
    const write = store.setItem;
    store.setItem = async (key, value) => { started.resolve(); await gate.promise; await write(key, value); };
    cache.set(a, 'first', 1);
    const saving = cache.save();
    await started.promise;
    cache.set(a, 'later', 2);
    gate.resolve();
    await saving;
    assert.deepEqual(data.get(TOKEN_CACHE_PREFIX + 'a'), { first: 1 });
    await cache.save();
    assert.deepEqual(data.get(TOKEN_CACHE_PREFIX + 'a'), { first: 1, later: 2 });
    cache.release(a);
});

test('leases preserve an in-flight chat across navigation, then evicted buckets reload from disk', async () => {
    const { cache, calls, data } = fixture({}, { limit: 1 });
    const a = cache.acquire('a');
    await a.ready;
    const b = cache.acquire('b');
    await b.ready;
    cache.set(b, 'b', 2);
    cache.release(b);
    await tick();
    cache.set(a, 'late', 1);
    await cache.save();
    cache.release(a);
    assert.deepEqual(data.get(TOKEN_CACHE_PREFIX + 'a'), { late: 1 });
    assert.deepEqual(data.get(TOKEN_CACHE_PREFIX + 'b'), { b: 2 });
    const b2 = cache.acquire('b');
    await b2.ready;
    assert.equal(b2.values.b, 2);
    assert.equal(calls.filter(x => x[0] === 'get' && x[1] === TOKEN_CACHE_PREFIX + 'b').length, 2);
    cache.release(b2);
});

test('A/B/A navigation during eviction reuses the writer and does not lose new counts', async () => {
    const { cache, store, data } = fixture({}, { limit: 1 });
    const a = cache.acquire('a');
    await a.ready;
    cache.set(a, 'old', 1);
    cache.release(a);
    const started = deferred();
    const gate = deferred();
    const write = store.setItem;
    store.setItem = async (key, value) => { started.resolve(); await gate.promise; await write(key, value); };
    const b = cache.acquire('b');
    await b.ready;
    cache.release(b);
    await started.promise;
    const again = cache.acquire('a');
    assert.equal(again, a);
    cache.set(again, 'new', 2);
    cache.release(again);
    gate.resolve();
    await tick();
    assert.deepEqual(data.get(TOKEN_CACHE_PREFIX + 'a'), { old: 1, new: 2 }, 'Eviction automatically flushes updates made during its first write');
});

for (const action of ['remove', 'reset']) {
    test(`${action} waits for older writes and rejects stale in-flight results without deleting other data`, async () => {
        const { cache, store, data } = fixture({ unrelated: { keep: true }, tokenCache: { legacy: true } });
        const a = cache.acquire('a');
        await a.ready;
        cache.set(a, 'old', 1);
        const started = deferred();
        const gate = deferred();
        const write = store.setItem;
        store.setItem = async (key, value) => { started.resolve(); await gate.promise; await write(key, value); };
        const saving = cache.save();
        await started.promise;
        const clearing = action === 'reset' ? cache.reset() : cache.remove('a');
        cache.set(a, 'stale', 7);
        const next = cache.acquire('a');
        gate.resolve();
        await Promise.all([saving, clearing, next.ready]);
        assert.deepEqual({ ...next.values }, {});
        assert.equal(data.has(TOKEN_CACHE_PREFIX + 'a'), false);
        assert.deepEqual(data.get('unrelated'), { keep: true });
        cache.set(next, 'new', 3);
        await cache.save();
        assert.deepEqual(data.get(TOKEN_CACHE_PREFIX + 'a'), { new: 3 });
        cache.release(a);
        cache.release(next);
    });
}

test('storage failures fall back to fresh counts and allow later saves and resets', async () => {
    const { cache, store, data, errors } = fixture();
    store.getItem = async () => { throw new Error('unavailable'); };
    const a = cache.acquire('a');
    await a.ready;
    cache.set(a, 'count', 4);
    const write = store.setItem;
    store.setItem = async () => { throw new Error('quota'); };
    await cache.save();
    store.setItem = write;
    await cache.save();
    assert.deepEqual(data.get(TOKEN_CACHE_PREFIX + 'a'), { count: 4 });
    assert.equal(errors.length, 2);
    await cache.reset();
    cache.release(a);
});

test('legacy cleanup removes the old blob without reading it or unrelated storage', async () => {
    const { cache, calls, data } = fixture({ tokenCache: { huge: true }, other: 1 });
    await cache.removeLegacyCache();
    assert.deepEqual(calls, [['remove', 'tokenCache']]);
    assert.deepEqual([...data.entries()], [['other', 1]]);
});


test('visiting many chats retains only the four most recent idle buckets', async () => {
    const { cache } = fixture();
    const states = [];
    for (let i = 0; i < 100; i++) {
        const state = cache.acquire(`chat-${i}`);
        await state.ready;
        cache.set(state, 'count', i);
        cache.release(state);
        states.push(state);
    }
    await tick();
    assert.equal(states.filter(state => state.valid).length, 4);
    for (let i = 96; i < 100; i++) {
        const recent = cache.acquire(`chat-${i}`);
        assert.equal(recent, states[i]);
        cache.release(recent);
    }
    const first = cache.acquire('chat-0');
    await first.ready;
    assert.notEqual(first, states[0]);
    assert.equal(first.values.count, 0);
    cache.release(first);
});

test('failed eviction writes release recomputable data instead of growing resident history forever', async () => {
    const { cache, store, errors } = fixture({}, { limit: 1 });
    store.setItem = async () => { throw new Error('quota'); };
    const states = [];
    for (let i = 0; i < 5; i++) {
        const state = cache.acquire(i);
        await state.ready;
        cache.set(state, 'count', i);
        cache.release(state);
        states.push(state);
    }
    await tick();
    assert.equal(states.filter(state => state.valid).length, 1);
    assert.ok(errors.length >= 4);
});
