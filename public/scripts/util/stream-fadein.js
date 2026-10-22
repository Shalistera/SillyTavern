import { morphdom } from '../../lib.js';

// A bounded cache of detached templates avoids rebuilding the same word spans
// in completed paragraphs on every token. Callers only receive clones.
const segmentTemplates = new Map();
const segmenters = new Map();
const MAX_CACHED_SEGMENTS = 4096;
const MAX_CACHED_CHARACTERS = 65536;
const MAX_CACHED_TEMPLATES = 128;
let cachedSegments = 0;
let cachedCharacters = 0;

/**
 * @param {string} text Text node contents
 * @param {'word'|'grapheme'|'sentence'} granularity Segmentation granularity
 * @returns {DocumentFragment} Detached spans, owned by the caller
 */
function createTextSegments(text, granularity) {
    const key = `${granularity}:${text}`;
    const cached = segmentTemplates.get(key);
    if (cached) {
        segmentTemplates.delete(key);
        segmentTemplates.set(key, cached);
        return /** @type {DocumentFragment} */ (cached.fragment.cloneNode(true));
    }

    let segmenter = segmenters.get(granularity);
    if (!segmenter) {
        segmenter = new Intl.Segmenter('en-US', { granularity });
        segmenters.set(granularity, segmenter);
    }
    const fragment = document.createDocumentFragment();
    let segmentCount = 0;
    for (const segment of segmenter.segment(text)) {
        const span = document.createElement('span');
        span.innerText = segment.segment;
        span.className = 'text_segment';
        fragment.appendChild(span);
        segmentCount++;
    }

    // Large single text nodes still render normally without retaining another
    // copy. Bound both source strings and the much heavier DOM span templates.
    if (segmentCount > MAX_CACHED_SEGMENTS || text.length > MAX_CACHED_CHARACTERS) {
        return fragment;
    }
    while (segmentTemplates.size >= MAX_CACHED_TEMPLATES
        || cachedSegments + segmentCount > MAX_CACHED_SEGMENTS
        || cachedCharacters + text.length > MAX_CACHED_CHARACTERS) {
        const oldestKey = segmentTemplates.keys().next().value;
        const oldest = segmentTemplates.get(oldestKey);
        cachedSegments -= oldest.segmentCount;
        cachedCharacters -= oldest.textLength;
        segmentTemplates.delete(oldestKey);
    }
    segmentTemplates.set(key, { fragment, segmentCount, textLength: text.length });
    cachedSegments += segmentCount;
    cachedCharacters += text.length;
    return /** @type {DocumentFragment} */ (fragment.cloneNode(true));
}

/**
 * Creates a content writer scoped to one streaming handler.
 * Formatting still runs on every update; only identical DOM writes are skipped.
 * @returns {(element: HTMLElement, html: string, fade: boolean, force?: boolean) => boolean} Whether content was written
 */
export function createStreamingContentUpdater() {
    /** @type {HTMLElement|null} */
    let lastElement = null;
    let lastHtml;
    let lastFade;

    return (element, html, fade, force = false) => {
        if (!force && element === lastElement && html === lastHtml && fade === lastFade) {
            return false;
        }
        if (fade) {
            applyStreamFadeIn(element, html);
        } else {
            element.innerHTML = html;
        }
        lastElement = element;
        lastHtml = html;
        lastFade = fade;
        return true;
    };
}

/**
 * Check if the current browser supports native segmentation function.
 * @returns {boolean} True if the Segmenter is supported by the current browser.
 */
export function isSegmenterSupported() {
    return typeof Intl.Segmenter === 'function';
}

/**
 * Segment text in the given HTML content using Intl.Segmenter.
 * @param {HTMLElement} htmlElement Target HTML element
 * @param {string} htmlContent HTML content to segment
 * @param {'word'|'grapheme'|'sentence'} [granularity='word'] Text split granularity
 */
export function segmentTextInElement(htmlElement, htmlContent, granularity = 'word') {
    htmlElement.innerHTML = htmlContent;

    if (!isSegmenterSupported()) {
        return;
    }

    const textNodes = [];
    const walker = document.createTreeWalker(htmlElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const textNode = /** @type {Text} */ (walker.currentNode);

        // Skip ancestors of code/pre
        if (textNode.parentElement && textNode.parentElement.closest('pre, code')) {
            continue;
        }

        // Skip text nodes that are empty or only whitespace
        if (/^\s*$/.test(textNode.data)) {
            continue;
        }

        textNodes.push(textNode);
    }

    // Split every text node into segments using spans
    for (const textNode of textNodes) {
        textNode.replaceWith(createTextSegments(textNode.data, granularity));
    }
}

/**
 * Apply stream fade-in effect to the given message text element by morphing its content.
 * @param {HTMLElement} messageTextElement Message text element
 * @param {string} htmlContent New HTML content to apply
 */
export function applyStreamFadeIn(messageTextElement, htmlContent) {
    const targetElement = /** @type {HTMLElement} */ (messageTextElement.cloneNode());
    segmentTextInElement(targetElement, htmlContent);
    morphdom(messageTextElement, targetElement, {
        onBeforeElUpdated: (fromElement, toElement) => {
            // Most paragraphs are unchanged while the last one grows. Avoid
            // visiting every existing word span in those completed paragraphs.
            // Form controls also have mutable properties that isEqualNode does
            // not compare. Keyed descendants must be visited so morphdom removes
            // their IDs from its unmatched-node index before adding other nodes.
            if (fromElement.isEqualNode(toElement)
                && !fromElement.matches('input, textarea, select, option')
                && !fromElement.querySelector('input, textarea, select, option, [id]')) {
                return false;
            }
            return true;
        },
    });
}
