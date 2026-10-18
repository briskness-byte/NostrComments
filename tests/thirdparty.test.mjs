// Third-party text in the panel: quoteThirdParty(), and that it is used where a Lightning provider
// or a relay explains itself (audit of 17 Oct 2026). A Lightning provider is chosen by whoever is
// being zapped, so its error text must be quoted and attributed, never spoken in the panel's voice.
import fs from 'fs';

const FILES = { chrome: '../NostrComments-Chrome/content.js', firefox: '../NostrComments-FireFox/content.js' };

export async function run() {
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };

    for (const [name, rel] of Object.entries(FILES)) {
        const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
        const a = src.indexOf('        function quoteThirdParty('), b = src.indexOf('        function clearMsg', a);
        ok(`${name}: quoteThirdParty() can be read out of content.js`, a >= 0 && b > a);
        if (a < 0 || b < 0) continue;
        const q = new Function(`${src.slice(a, b)}\nreturn quoteThirdParty;`)();

        ok(`${name}: a bidi override is removed`, !/[‪-‮⁦-⁩]/.test(q('pay‮selif')));
        ok(`${name}: control characters and line breaks become spaces`, q('a\nb\u0000c\td') === 'a b c d', q('a\nb\u0000c\td'));
        ok(`${name}: long text is cut short`, q('x'.repeat(500)).length === 120 && q('x'.repeat(500)).endsWith('…'));
        ok(`${name}: nothing gives an empty string`, q(undefined) === '' && q(null) === '');

        // Every place a Lightning provider's reason reaches the panel goes through it, quoted.
        const reasons = src.match(/showMsg\([^\n]*\.reason[^\n]*\)/g) || [];
        ok(`${name}: the Lightning provider's reasons are found`, reasons.length >= 2, reasons.length);
        ok(`${name}: each one is quoted and attributed`, reasons.every(l => /quoteThirdParty\(/.test(l) && /Lightning provider/.test(l)), reasons);
        ok(`${name}: and a relay's own words are quoted too`, /return `it said “\$\{quoteThirdParty\(r\)\}”`;/.test(src));
        // CodeQL review of 18 Oct 2026: the subscription and publish messages quoted a relay raw.
        const relayMsgs = src.match(/showMsg\([^\n]*A relay (closed the subscription|refused the identification|rejected it)[^\n]*\)/g) || [];
        ok(`${name}: the three relay explanations are found`, relayMsgs.length === 3, relayMsgs.length);
        ok(`${name}: and each quotes the relay through quoteThirdParty`, relayMsgs.every(l => /quoteThirdParty\(info\)/.test(l)), relayMsgs);

        // Links in comments: every href and window.open in renderMarkdown takes safeLink()'s answer,
        // never the raw text — explicit rather than resting on the pattern alone.
        const r0 = src.indexOf('        function renderMarkdown('), r1 = src.indexOf('            return frag;', r0);
        const md = r0 >= 0 && r1 > r0 ? src.slice(r0, r1) : '';
        ok(`${name}: renderMarkdown can be found`, md.length > 0);
        ok(`${name}: its links come from safeLink()`, (md.match(/safeLink\(/g) || []).length >= 2, (md.match(/safeLink\(/g) || []).length);
        ok(`${name}: no link or window takes the raw text`, !/a\.href = (url|m\[5\])|window\.open\(url/.test(md));
    }
    return { name: 'third-party text', pass, fail };
}
