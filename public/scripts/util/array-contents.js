// Inspired by TauriTavern's canonical chat replacement (without its host-specific cold-swipe handling):
// https://github.com/Darkatse/TauriTavern/blob/edf728b67337eb45c82bbe5a13151d901cd74f4a/src/script.js#L606-L612

/**
 * Replace an array's contents without passing the whole history as function arguments.
 * Like splice(0, length, ...source), consume the iterator before changing the
 * target. This preserves self-replacement, dense undefined slots for holes,
 * custom iterators, and an unchanged target when reading the source throws.
 * @template T
 * @param {T[]} target Existing array whose identity must remain stable
 * @param {Iterable<T>} source Replacement values
 * @returns {void}
 */
export function replaceArrayContents(target, source) {
    const values = [...source];
    for (let index = 0; index < values.length; index++) {
        target[index] = values[index];
    }
    target.length = values.length;
}
