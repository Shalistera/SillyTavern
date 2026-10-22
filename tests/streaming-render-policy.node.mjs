import assert from 'node:assert/strict';
import test from 'node:test';
import { getStreamingRenderInterval, normalizeStreamingFps } from '../public/scripts/util/streaming-render-policy.js';

test('hidden previews cap at four per second while preserving slower user settings', () => {
    for (const fps of [0.5, 2, 4, 5, 30, 60, 100]) {
        const configuredFps = normalizeStreamingFps(fps);
        const foreground = getStreamingRenderInterval({ configuredFps, hidden: false });
        const background = getStreamingRenderInterval({ configuredFps, hidden: true });
        assert.equal(foreground, 1000 / fps);
        assert.ok(background >= 250);
        assert.ok(background >= foreground);
        assert.equal(getStreamingRenderInterval({ configuredFps, hidden: false }), foreground, 'Returning to the foreground restores the user interval');
        if (fps <= 4) assert.equal(background, foreground);
    }
});

test('invalid stored FPS uses the normal default instead of a near-unbounded update rate', t => {
    const warnings = [];
    t.mock.method(console, 'warn', message => warnings.push(message));
    for (const value of [0, -5, NaN, Infinity, undefined, null, '', 'invalid']) {
        const fps = normalizeStreamingFps(value);
        assert.equal(fps, 30);
        assert.equal(getStreamingRenderInterval({ configuredFps: fps, hidden: false }), 1000 / 30);
    }
    assert.equal(warnings.length, 8);
    assert.equal(normalizeStreamingFps('15'), 15);
    assert.equal(warnings.length, 8);
});
