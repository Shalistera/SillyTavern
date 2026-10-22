import assert from 'node:assert/strict';
import test from 'node:test';
import showdown from 'showdown';
import { addShowdownPatch } from '../public/scripts/util/showdown-patch.js';

// Preserve the previous parser as a compatibility oracle, including its unusual
// first-occurrence and String.replace replacement-string behavior.
function originalUnhash(text, options, globals) {
    text = globals.converter._dispatch('unhashHTMLSpans.before', text, options, globals);
    for (let i = 0; i < globals.gHtmlSpans.length; i++) {
        let repText = globals.gHtmlSpans[i];
        let limit = 0;
        while (/¨C(\d+)C/.test(repText)) {
            const num = RegExp.$1;
            repText = repText.replace('¨C' + num + 'C', globals.gHtmlSpans[num]);
            if (limit === 10000) {
                console.error('maximum nesting of 10000 spans reached!!!');
                break;
            }
            limit++;
        }
        text = text.replace('¨C' + i + 'C', repText);
    }
    return globals.converter._dispatch('unhashHTMLSpans.after', text, options, globals);
}

let optimizedUnhash;
addShowdownPatch({ subParser: (_name, callback) => { optimizedUnhash = callback; } });

function run(parser, text, spans, dispatch = (_event, value) => value) {
    const calls = [];
    const globals = {
        gHtmlSpans: Object.assign(spans.slice(), spans),
        converter: { _dispatch(event, value, options, state) {
            calls.push({ event, text: value, options });
            return dispatch(event, value, options, state, parser);
        } },
    };
    const html = parser(text, { testOption: true }, globals);
    return { html, calls };
}

test('span expansion matches ordered replacement for nested, duplicated and literal tokens', () => {
    const cases = [
        ['before ¨C0C after ¨C1C', ['<q>dialogue</q>', '<code>x &lt; y</code>']],
        ['¨C0C ¨C0C ¨C1C', ['<i>first</i>', '<b>second</b>']],
        ['¨C00C ¨C01C ¨C99C ¨C-1C ¨C0C ¨C90071992547409930C', ['<q>valid</q>']],
        ['¨C2C ¨C1C ¨C0C', ['<em>inner</em>', '<b>¨C0C + ¨C0C</b>', '<a>¨C1C</a>']],
        ['¨C0C', ['<q>Missing ¨C99C reference</q>']],
        ['¨C0C', ['<q>Leading zero ¨C01C</q>', '<b>other</b>']],
        ['plain ¨C0C', []],
        ['¨C0C / ¨C1C / ¨C2C', [undefined, null, 42]],
        ['¨C0C1C', ['¨C', '<em>assembled token</em>']],
        ['¨C¨C0C', ['1C', '<em>assembled token</em>']],
        ['before ¨C0C middle ¨C1C after', ['<q>$&</q>', '<b>$$</b>']],
        ['before ¨C0C middle ¨C1C after', ['<q>$`</q>', "<b>$'</b>"]],
        ['¨C1C', ['<q>$&</q>', '<b>¨C0C</b>']],
        ['¨C0C ¨C1C', ['<q>$1 and $0 stay literal</q>', '<b>cost $5</b>']],
        ['¨C0C', Object.assign(['<q>¨C01C</q>'], { '01': '$$&' })],
        ['¨C0C', Object.assign(['<q>¨C01C</q>'], { '01': "$$'" })],
        ['¨C0C', Object.assign(['<q>¨C01C</q>'], { '01': '$$`' })],
    ];
    for (const [text, spans] of cases) {
        assert.deepEqual(run(optimizedUnhash, text, spans), run(originalUnhash, text, spans), text);
    }
});

test('extension dispatch may rewrite text and spans and invoke the parser reentrantly', () => {
    function dispatch(event, text, _options, globals, parser) {
        if (event.endsWith('.before')) {
            const nested = run(parser, '¨C0C', ['<em>nested dispatch</em>']).html;
            globals.gHtmlSpans[0] = `<q>${nested}</q>`;
            globals.gHtmlSpans.push('<strong>added by listener</strong>');
            return text + ' ¨C1C';
        }
        return text + '<!-- after -->';
    }
    assert.deepEqual(run(optimizedUnhash, '¨C0C', ['<q>original</q>'], dispatch), run(originalUnhash, '¨C0C', ['<q>original</q>'], dispatch));
    const replaceSpanTable = (event, text, _options, globals) => {
        if (event.endsWith('.before')) globals.gHtmlSpans = { 0: '<q>array-like table</q>', length: 1 };
        return text;
    };
    assert.deepEqual(run(optimizedUnhash, '¨C0C', [], replaceSpanTable), run(originalUnhash, '¨C0C', [], replaceSpanTable));
});

test('cyclic references retain the previous nesting limit and diagnostic', () => {
    const previousError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
        const expected = run(originalUnhash, '¨C0C', ['¨C0C']);
        const beforeOptimized = errors.slice();
        errors.length = 0;
        assert.deepEqual(run(optimizedUnhash, '¨C0C', ['¨C0C']), expected);
        assert.deepEqual(errors, beforeOptimized);
        assert.equal(errors.length, 1);
    } finally {
        console.error = previousError;
    }
});

test('deterministic nested span combinations match the previous parser exactly', () => {
    let seed = 12345;
    const random = max => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % max;
    };
    for (let iteration = 0; iteration < 250; iteration++) {
        const spans = ['<code>start &lt; end</code>'];
        for (let index = 1; index < 8; index++) {
            const inner = random(2) ? `¨C${random(index)}C` : `literal ${iteration}-${index}`;
            spans.push(`<span data-index="${index}">${inner}</span>`);
        }
        const text = Array.from({ length: 15 }, () => `¨C${random(12)}C`).join(' / ');
        assert.equal(run(optimizedUnhash, text, spans).html, run(originalUnhash, text, spans).html);
    }
});

test('actual Showdown output stays identical across growing Markdown and inline HTML', () => {
    const fragments = [
        '# Heading\n\n', '**Bold** _emphasis_ ~~strike~~ and `code`\n\n',
        '<q>"Dialogue with $5 and $& symbols"</q>\n\n',
        '<span title="quoted attribute">Outer <em>inner</em></span>\n\n',
        '| column | another |\n| --- | --- |\n| <b>A</b> | B |\n\n',
        '- first\n- <code>second</code>\n\n',
        '```js\nconst token = "¨C0C";\n```\n\n',
        '日本語 👩🏽‍💻 &amp; <https://example.com>\n\n',
        '<!-- comment --> <br> text <img src="x" alt="picture">\n\n',
    ];
    const converter = new showdown.Converter({ tables: true, strikethrough: true, simpleLineBreaks: true });
    try {
        let text = '';
        for (let index = 0; index < 45; index++) {
            text += fragments[index % fragments.length];
            showdown.subParser('unhashHTMLSpans', originalUnhash);
            const expected = converter.makeHtml(text);
            showdown.subParser('unhashHTMLSpans', optimizedUnhash);
            assert.equal(converter.makeHtml(text), expected, `prefix ${index}`);
        }
    } finally {
        addShowdownPatch(showdown);
    }
});
