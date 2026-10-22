import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createWebpackCacheFixture, compileWebpackFixture } from './util/webpack-cache-fixture.mjs';

const configSource = await fs.readFile(new URL('../webpack.config.js', import.meta.url), 'utf8');

async function setup(t) {
    const fixture = await createWebpackCacheFixture(configSource);
    t.after(() => fixture.cleanup());
    return fixture;
}

test('unrelated commits retain the compiled library cache and identical output', async t => {
    const fixture = await setup(t);
    const firstConfig = await fixture.config();
    const first = await compileWebpackFixture(firstConfig);
    await fixture.write('revision', 'unrelated-performance-commit');
    await fixture.write('public/unrelated.js', 'export const unrelated = true;\n');
    const secondConfig = await fixture.config({ pruneCache: true });
    assert.equal(secondConfig.output.path, firstConfig.output.path);
    const second = await compileWebpackFixture(secondConfig);
    assert.equal(second.output, first.output);
    assert.ok(first.builtModules > 0);
    assert.equal(second.builtModules, 0, 'the real compiler should reuse all unchanged modules');
});

test('edits to an imported module rebuild it without a lockfile or entry change', async t => {
    const fixture = await setup(t);
    const initialConfig = await fixture.config();
    await compileWebpackFixture(initialConfig);
    await fixture.write('public/dependency.js', 'export const value = "edited dependency with a new length";\n');
    const nextConfig = await fixture.config();
    assert.equal(nextConfig.output.path, initialConfig.output.path);
    const updated = await compileWebpackFixture(nextConfig);
    assert.ok(updated.builtModules > 0);
    const url = pathToFileURL(path.join(nextConfig.output.path, nextConfig.output.filename));
    assert.equal((await import(url.href)).value, 'edited dependency with a new length');
});

test('entry, lockfile, package and build config changes each invalidate the output namespace', async t => {
    const fixture = await setup(t);
    let previous = await fixture.config();
    for (const [name, content] of [
        ['public/lib.js', 'export const changedEntry = true;\n'],
        ['package-lock.json', '{"lockfileVersion":3,"packages":{}}\n'],
        ['npm-shrinkwrap.json', '{"lockfileVersion":3,"packages":{}}\n'],
        ['yarn.lock', '# yarn lockfile v1\n'],
        ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
        ['package.json', '{"name":"webpack-cache-fixture","version":"1.0.1","type":"module"}\n'],
        ['webpack.config.js', configSource + '\n// updated build configuration\n'],
    ]) {
        await fixture.write(name, content);
        const next = await fixture.config();
        assert.notEqual(next.output.path, previous.output.path, name);
        previous = next;
    }
});

test('installations without an npm lockfile can still build and later detect one', async t => {
    const fixture = await setup(t);
    await fs.unlink(path.join(fixture.root, 'package-lock.json'));
    const withoutLock = await fixture.config();
    await compileWebpackFixture(withoutLock);
    await fixture.write('package-lock.json', '{"lockfileVersion":3}\n');
    assert.notEqual((await fixture.config()).output.path, withoutLock.output.path);
});

test('pruning removes outdated builds and preserves the current cache', async t => {
    const fixture = await setup(t);
    const initial = await fixture.config();
    await compileWebpackFixture(initial);
    await fixture.write('public/lib.js', 'export const updatedEntry = true;\n');
    const updated = await fixture.config({ pruneCache: true });
    assert.notEqual(updated.output.path, initial.output.path);
    await assert.rejects(fs.access(initial.output.path), { code: 'ENOENT' });
    await compileWebpackFixture(updated);
    await fixture.config({ pruneCache: true });
    await fs.access(updated.output.path);
});
