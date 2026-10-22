import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.beforeEach(testSetup.awaitST);

test('growing and revised content matches full morphing, including mutable form controls', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { applyStreamFadeIn } = await import('/scripts/util/stream-fadein.js');
        const { morphdom } = await import('/lib.js');
        const expected = document.createElement('div');
        const actual = document.createElement('div');
        const snapshots = [];
        const inputs = [
            '<p id="stable">Completed paragraph 日本語 👩🏽‍💻</p><p>Growing</p>',
            '<p id="stable">Completed paragraph 日本語 👩🏽‍💻</p><p>Growing <strong>emphasis</strong></p>',
            '<p id="stable">Completed paragraph 日本語 👩🏽‍💻</p><pre><code>Do not split code\nline two</code></pre><p>Next</p>',
            '<ul><li>Rewritten beginning</li><li>Another item</li></ul><p id="stable">Completed paragraph 日本語 👩🏽‍💻</p>',
            '<div><input value="original"><input type="checkbox"><textarea>original</textarea><select><option>first</option><option>second</option></select></div><p>Tail</p>',
            '<div><input value="original"><input type="checkbox"><textarea>original</textarea><select><option>first</option><option>second</option></select></div><p>Tail grows</p>',
            '<div data-new="yes"><p>Replacement after forms</p></div>',
            '<section><span id="shared">keep</span></section><p>tail</p>',
            '<section><span id="shared">keep</span></section><p><span id="shared">new</span></p>',
            '<section></section><p><span id="shared">moved</span></p>',
        ];
        let stableNode;
        let stablePreserved = false;
        for (let index = 0; index < inputs.length; index++) {
            // Compatibility oracle: the previous full segmentation/morph path.
            const target = document.createElement('div');
            target.innerHTML = inputs[index];
            const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            for (const node of nodes) {
                if (node.parentElement.closest('pre, code') || /^\s*$/.test(node.data)) continue;
                const fragment = document.createDocumentFragment();
                for (const segment of new Intl.Segmenter('en-US', { granularity: 'word' }).segment(node.data)) {
                    const span = document.createElement('span');
                    span.className = 'text_segment';
                    span.innerText = segment.segment;
                    fragment.appendChild(span);
                }
                node.replaceWith(fragment);
            }
            morphdom(expected, target);
            applyStreamFadeIn(actual, inputs[index]);
            if (index === 0) stableNode = actual.querySelector('#stable');
            if (index === 1) stablePreserved = actual.querySelector('#stable') === stableNode;
            const formState = element => [...element.querySelectorAll('input, textarea, select')].map(node => ({ value: node.value, checked: node.checked, selectedIndex: node.selectedIndex }));
            snapshots.push({ actual: actual.outerHTML, expected: expected.outerHTML, actualForm: formState(actual), expectedForm: formState(expected) });
            if (index === 4) {
                for (const element of [expected, actual]) {
                    element.querySelector('input').value = 'user change';
                    element.querySelector('input[type="checkbox"]').checked = true;
                    element.querySelector('textarea').value = 'user change';
                    element.querySelector('select').selectedIndex = 1;
                }
            }
            // External DOM changes must still be reconciled on the next update.
            if (index === 1) {
                expected.querySelector('#stable').setAttribute('data-external', 'changed');
                actual.querySelector('#stable').setAttribute('data-external', 'changed');
            }
        }
        return { snapshots, stablePreserved };
    });
    expect(result.stablePreserved).toBe(true);
    for (const snapshot of result.snapshots) {
        expect(snapshot.actual).toBe(snapshot.expected);
        expect(snapshot.actualForm).toEqual(snapshot.expectedForm);
    }
});

test('cached segments preserve Unicode, whitespace and granularity without sharing mutable nodes', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { segmentTextInElement } = await import('/scripts/util/stream-fadein.js');
        const text = 'Cache comparison: 👨‍👩‍👧‍👦 e\u0301 日本語。\nSecond\tline < & >!';
        const snapshots = [];
        const originalSegment = Intl.Segmenter.prototype.segment;
        let calls = 0;
        Intl.Segmenter.prototype.segment = function (...args) {
            calls++;
            return originalSegment.apply(this, args);
        };
        try {
            for (const granularity of ['word', 'grapheme', 'sentence']) {
                const source = document.createElement('div');
                source.textContent = text;
                const first = document.createElement('div');
                const second = document.createElement('div');
                segmentTextInElement(first, source.innerHTML, granularity);
                const expected = first.innerHTML;
                const afterFirst = calls;
                first.firstElementChild.textContent = 'Mutated by an extension';
                first.firstElementChild.className = 'changed';
                segmentTextInElement(second, source.innerHTML, granularity);
                snapshots.push({ expected, actual: second.innerHTML, cached: calls === afterFirst });
            }
            const firstText = '<p>Old cache entry retained only within the bound.</p>';
            segmentTextInElement(document.createElement('div'), firstText);
            for (let index = 0; index < 130; index++) {
                segmentTextInElement(document.createElement('div'), `<p>Unique cache entry ${index}.</p>`);
            }
            const beforeEvicted = calls;
            segmentTextInElement(document.createElement('div'), firstText);
            return { snapshots, evicted: calls > beforeEvicted };
        } finally {
            Intl.Segmenter.prototype.segment = originalSegment;
        }
    });
    expect(result.evicted).toBe(true);
    for (const snapshot of result.snapshots) {
        expect(snapshot.actual).toBe(snapshot.expected);
        expect(snapshot.cached).toBe(true);
    }
});

test('fade updates still apply fresh formatter hooks and sanitization and support browsers without Segmenter', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { applyStreamFadeIn, segmentTextInElement } = await import('/scripts/util/stream-fadein.js');
        const { messageFormatting } = await import('/script.js');
        const { MessageFormatter } = await import('/scripts/message-formatter.js');
        const target = document.createElement('div');
        let hookRuns = 0;
        MessageFormatter.addHook(html => `${html}<span data-tick="${++hookRuns}">Tick ${hookRuns}</span><img src="x" onerror="window.unsafeFade=true">`);
        for (const text of ['Growing **answer**', 'Growing **answer** continues', 'Growing **answer** continues']) {
            applyStreamFadeIn(target, messageFormatting(text, 'Assistant', false, false, -1));
        }
        const final = { hookRuns, tick: target.querySelector('[data-tick]')?.getAttribute('data-tick'), unsafe: !!target.querySelector('[onerror]'), bold: target.querySelector('strong')?.textContent };
        const nativeSegmenter = Intl.Segmenter;
        try {
            Intl.Segmenter = undefined;
            const fallback = document.createElement('div');
            segmentTextInElement(fallback, '<p>Plain fallback <code>x &lt; y</code></p>');
            return { ...final, fallback: fallback.innerHTML };
        } finally {
            Intl.Segmenter = nativeSegmenter;
        }
    });
    expect(result).toEqual({ hookRuns: 3, tick: '3', unsafe: false, bold: 'answer', fallback: '<p>Plain fallback <code>x &lt; y</code></p>' });
});
