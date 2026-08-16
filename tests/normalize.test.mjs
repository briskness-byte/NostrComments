// Verifies normalizeUrl(): tracking params are stripped, meaningful query params are kept
// (so distinct pages get distinct threads), remaining params are sorted for order-independence,
// and only hash-router fragments are preserved.
import fs from 'fs';

const SRC = new URL('../NostrComments-Chrome/content.js', import.meta.url);

export async function run() {
    const src = fs.readFileSync(SRC, 'utf8');
    const t0 = src.indexOf('const _TRACKING');
    const t1 = src.indexOf('let pageUrl =', t0);
    const snippet = src.slice(t0, t1);
    const normalizeUrl = eval(snippet + '; normalizeUrl');

    let p = 0, f = 0;
    const ok = (n, c) => { c ? p++ : f++; if (!c) console.log('  ✗ FAIL ' + n); };

    // Regression guard: spreading a URLSearchParams iterator ([...p.keys()]) throws in Firefox
    // content scripts and aborts init. Must use forEach instead.
    ok('does not spread a URLSearchParams iterator (Firefox-safe)',
        !/\[\s*\.\.\.\s*[\w.]*\.(?:keys|values|entries)\(\)\s*\]/.test(snippet) &&
        !/\[\s*\.\.\.\s*u\.searchParams\b/.test(snippet));

    const cases = [
        ['https://youtube.com/watch?v=AAA', 'https://youtube.com/watch?v=AAA'],
        ['https://youtube.com/watch?v=AAA&si=track', 'https://youtube.com/watch?v=AAA'],
        ['https://youtube.com/watch?v=BBB', 'https://youtube.com/watch?v=BBB'],       // distinct video, distinct thread
        ['https://ex.com/a?utm_source=x&utm_medium=y&id=42', 'https://ex.com/a?id=42'],
        ['https://ex.com/a?id=42&fbclid=abc&gclid=z', 'https://ex.com/a?id=42'],
        ['https://ex.com/a?b=2&a=1', 'https://ex.com/a?a=1&b=2'],                       // sorted
        ['https://ex.com/a#section', 'https://ex.com/a'],                              // plain anchor dropped
        ['https://ex.com/a#/route/5', 'https://ex.com/a#/route/5'],                    // hash route kept
        ['https://ex.com/a#!/old/route', 'https://ex.com/a#!/old/route'],             // hashbang route kept
        ['https://ex.com/p?utm_campaign=x', 'https://ex.com/p'],                       // all-tracking -> none
        ['https://ex.com/path/', 'https://ex.com/path/'],                             // trailing slash preserved
        ['https://ex.com/x?only=utm_lookalike', 'https://ex.com/x?only=utm_lookalike'],// value not stripped, only keys
    ];
    for (const [inp, exp] of cases) {
        const got = normalizeUrl(inp);
        ok(`${inp} -> ${exp}`, got === exp);
        if (got !== exp) console.log(`        got: ${got}`);
    }

    return { name: 'normalizeUrl', pass: p, fail: f };
}
