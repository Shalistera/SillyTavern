// Per-chat persistence inspired by TauriTavern's bootstrap optimization:
// https://github.com/Darkatse/TauriTavern/blob/edf728b67337eb45c82bbe5a13151d901cd74f4a/docs/CurrentState/BootstrapOptimization.md
// Storage ordering and leases keep synchronous callers, navigation, and resets safe.
export const TOKEN_CACHE_PREFIX = 'tokenCache:chat:';

/** A bounded, lazily loaded cache of recomputable token counts. */
export class ChatTokenCache {
    #store;
    #states = new Map();
    #dirty = new Set();
    #tail = Promise.resolve();
    #limit;
    #onError;

    constructor(store, { limit = 4, onError = console.warn } = {}) {
        this.#store = store;
        this.#limit = limit;
        this.#onError = onError;
    }

    #enqueue(operation) {
        const promise = this.#tail.then(operation);
        this.#tail = promise.catch(() => {});
        return promise;
    }

    /** Hold a bucket until release(), including while a tokenizer request is pending. */
    acquire(chatId) {
        const id = String(chatId);
        let state = this.#states.get(id);
        if (!state) {
            state = { id, values: Object.create(null), users: 0, valid: true, loaded: false, version: 0, savedVersion: 0, evicting: false, ready: null };
            this.#states.set(id, state);
            state.ready = this.#enqueue(async () => {
                if (!state.valid) return;
                try {
                    const saved = await this.#store.getItem(TOKEN_CACHE_PREFIX + id);
                    if (state.valid && saved && typeof saved === 'object' && !Array.isArray(saved)) {
                        for (const [key, value] of Object.entries(saved)) {
                            // A synchronous caller can compute a count before IndexedDB finishes.
                            if (typeof value === 'number' && !Object.hasOwn(state.values, key)) state.values[key] = value;
                        }
                    }
                } catch (error) {
                    this.#onError('Unable to load token cache', error);
                } finally {
                    state.loaded = true;
                    this.#prune();
                }
            });
        }
        this.#states.delete(id);
        this.#states.set(id, state);
        state.users++;
        return state;
    }

    release(state) {
        state.users--;
        this.#prune();
    }

    set(state, key, value) {
        if (!state.valid) return;
        state.values[key] = value;
        state.version++;
        this.#dirty.add(state);
    }

    #saveState(state) {
        return this.#enqueue(async () => {
            if (!state.valid || state.version === state.savedVersion) return;
            const version = state.version;
            const snapshot = { ...state.values };
            await this.#store.setItem(TOKEN_CACHE_PREFIX + state.id, snapshot);
            state.savedVersion = version;
            if (state.version === version) this.#dirty.delete(state);
        });
    }

    /** Save only changed buckets. Writes made during a save remain dirty. */
    async save() {
        await Promise.all([...this.#dirty].map(state => this.#saveState(state).catch(error => this.#onError('Unable to save token cache', error))));
        this.#prune();
    }

    #prune() {
        let excess = this.#states.size - this.#limit;
        for (const state of this.#states.values()) {
            if (excess <= 0) break;
            if (state.users || !state.loaded || state.evicting) continue;
            excess--;
            state.evicting = true;
            // Keep the same bucket discoverable until its write completes: A/B/A
            // navigation must never create two writers for the same storage key.
            let failed = false;
            this.#saveState(state).catch(error => {
                failed = true;
                this.#onError('Unable to save evicted token cache', error);
            }).finally(() => {
                state.evicting = false;
                if (!state.users && this.#states.get(state.id) === state && this.#states.size > this.#limit
                    && (failed || state.version === state.savedVersion)) {
                    state.valid = false;
                    this.#states.delete(state.id);
                    this.#dirty.delete(state);
                }
                this.#prune();
            });
        }
    }

    /** Invalidate consumers immediately, then remove storage after older writes. */
    async remove(chatId) {
        const id = String(chatId);
        const state = this.#states.get(id);
        if (state) {
            state.valid = false;
            this.#states.delete(id);
            this.#dirty.delete(state);
        }
        await this.#enqueue(() => this.#store.removeItem(TOKEN_CACHE_PREFIX + id));
    }

    async reset() {
        for (const state of this.#states.values()) state.valid = false;
        this.#states.clear();
        this.#dirty.clear();
        await this.#enqueue(async () => {
            const keys = await this.#store.keys();
            for (const key of keys) {
                if (key === 'tokenCache' || key.startsWith(TOKEN_CACHE_PREFIX)) await this.#store.removeItem(key);
            }
        });
    }

    /** The old monolithic cache is disposable; never deserialize it at startup. */
    async removeLegacyCache() {
        await this.#enqueue(() => this.#store.removeItem('tokenCache'));
    }
}
