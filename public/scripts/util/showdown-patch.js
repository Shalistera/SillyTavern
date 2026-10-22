/** Original ordered expansion for unusual extension-provided spans. */
function replaceSpansSequentially(text, spans) {
    for (let index = 0; index < spans.length; index++) {
        let replacement = spans[index];
        let limit = 0;
        while (/¨C(\d+)C/.test(replacement)) {
            const nestedIndex = RegExp.$1;
            replacement = replacement.replace('¨C' + nestedIndex + 'C', spans[nestedIndex]);
            if (limit === 10000) {
                console.error('maximum nesting of 10000 spans reached!!!');
                break;
            }
            limit++;
        }
        text = text.replace('¨C' + index + 'C', replacement);
    }
    return text;
}

/**
 * Patches showdown to unrestrictedly unhash HTML spans.
 * @param {import('showdown')} showdown The showdown object to patch
 */
export function addShowdownPatch(showdown) {
    showdown.subParser('unhashHTMLSpans', function (text, options, globals) {
        'use strict';
        text = globals.converter._dispatch('unhashHTMLSpans.before', text, options, globals);
        const spans = globals.gHtmlSpans;
        const replacements = [];
        // Native hashed spans are complete HTML elements. Other values and
        // special String.replace substitutions need the original ordered path.
        // HTML boundaries prevent replacements creating tokens with neighbors.
        let canReplaceTogether = Array.isArray(spans);
        for (let index = 0; index < spans.length; index++) {
            const span = spans[index];
            if (typeof span !== 'string' || !span.startsWith('<') || !span.endsWith('>') || /\$[$&`']/.test(span)) {
                canReplaceTogether = false;
                break;
            }
        }
        if (canReplaceTogether) {
            for (let index = 0; index < spans.length; index++) {
                let replacement = spans[index];
                let limit = 0;
                while (/¨C(\d+)C/.test(replacement)) {
                    const nestedIndex = RegExp.$1;
                    replacement = replacement.replace('¨C' + nestedIndex + 'C', spans[nestedIndex]);
                    if (++limit > 10000) {
                        canReplaceTogether = false;
                        break;
                    }
                }
                if (!canReplaceTogether) break;
                // Extensions can attach non-index keys (for example "01") to
                // the span table. Their expansion may reintroduce special
                // replacement syntax, so validate the resolved value as well.
                if (!replacement.startsWith('<') || !replacement.endsWith('>') || /¨C\d+C|\$[$&`']/.test(replacement)) {
                    canReplaceTogether = false;
                    break;
                }
                replacements.push(replacement);
            }
        }
        if (canReplaceTogether) {
            // Scanning the entire reply once per span is quadratic for long
            // messages containing many inline tags (including quoted dialogue).
            // Replace only the first occurrence of each index, as before.
            const replaced = new Set();
            text = text.replace(/¨C(0|[1-9]\d*)C/g, (token, digits) => {
                const index = Number(digits);
                if (index >= replacements.length || replaced.has(index)) return token;
                replaced.add(index);
                return replacements[index];
            });
        } else {
            text = replaceSpansSequentially(text, spans);
        }

        text = globals.converter._dispatch('unhashHTMLSpans.after', text, options, globals);
        return text;
    });
}
