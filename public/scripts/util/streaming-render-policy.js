// Adapted from TauriTavern's browser-only streaming render policy:
// https://github.com/Darkatse/TauriTavern/blob/edf728b67337eb45c82bbe5a13151d901cd74f4a/src/scripts/tauri/perf/streaming-render-policy.js

const DEFAULT_STREAMING_FPS = 30;
const HIDDEN_MIN_INTERVAL_MS = 250;

/**
 * Normalize the configured preview FPS once before a generation starts.
 * @param {unknown} configuredFps User-configured streaming FPS
 * @returns {number} Finite, positive FPS
 */
export function normalizeStreamingFps(configuredFps) {
    const fps = Number(configuredFps);
    if (Number.isFinite(fps) && fps > 0) {
        return fps;
    }

    console.warn(`Invalid streaming FPS "${String(configuredFps)}"; using the default ${DEFAULT_STREAMING_FPS} FPS.`);
    return DEFAULT_STREAMING_FPS;
}

/**
 * Limit expensive previews in hidden tabs without throttling network chunks,
 * per-token events, or the final message flush.
 * @param {object} options Render policy inputs
 * @param {number} options.configuredFps Validated streaming FPS
 * @param {boolean} options.hidden Whether the document is hidden
 * @returns {number} Preview interval in milliseconds
 */
export function getStreamingRenderInterval({ configuredFps, hidden }) {
    const configuredInterval = 1000 / configuredFps;
    return hidden ? Math.max(configuredInterval, HIDDEN_MIN_INTERVAL_MS) : configuredInterval;
}
