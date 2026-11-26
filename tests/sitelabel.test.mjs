// The site label on what is written (Nov 2026): a NIP-32 ["L","web-host"] + ["l",<host>,"web-host"]
// on every comment and reply, so "everything on example.com" can be asked of a relay exactly.
//
// siteLabelTags() decides it. What must hold: the host is lowercase and without a leading www., so
// both spellings of a site meet; any other subdomain stays its own site; the l tag carries the
// namespace mark NIP-32 asks for; only http(s) pages with a real host name get a label; and
// buildEvent writes it on both shapes of comment, under the same setting as the client tag.
import fs from 'fs';

const FILES = { chrome: '../NostrComments-Chrome/content.js', firefox: '../NostrComments-FireFox/content.js' };

export async function run() {
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };
    const srcs = {}, blocks = {};
    for (const [name, rel] of Object.entries(FILES)) {
        const src = srcs[name] = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
        const a = src.indexOf('// siteLabel: start'), b = src.indexOf('// siteLabel: end', a);
        blocks[name] = a >= 0 && b > a ? src.slice(a, b) : null;
        ok(`${name}: siteLabelTags can be read out of content.js`, !!blocks[name]);
    }
    ok('both builds label the same way', blocks.chrome === blocks.firefox);
    if (!blocks.chrome) return { name: 'site label', pass, fail };
    const siteLabelTags = new Function(`${blocks.chrome}\nreturn siteLabelTags;`)();
    const host = p => siteLabelTags(p).find(t => t[0] === 'l')?.[1];

    ok('a page is labelled with its host', JSON.stringify(siteLabelTags('https://shop.example/product/42'))
        === JSON.stringify([['L', 'web-host'], ['l', 'shop.example', 'web-host']]), siteLabelTags('https://shop.example/product/42'));
    ok('www and the bare name meet', host('https://www.shop.example/a') === 'shop.example' && host('http://shop.example/') === 'shop.example');
    ok('only a leading www. goes', host('https://www2.shop.example/') === 'www2.shop.example' && host('https://shop.www.example/') === 'shop.www.example');
    ok('another subdomain is its own site', host('https://alice.github.io/post') === 'alice.github.io');
    ok('lowercase, whatever the address said', host('https://Shop.EXAMPLE/Product') === 'shop.example');
    ok('a trailing dot is the same host', host('https://shop.example./a') === 'shop.example');
    ok('a non-ASCII name is labelled in the form relays index', host('https://bücher.example/') === 'xn--bcher-kva.example', host('https://bücher.example/'));
    ok('a port is not part of the site', host('https://shop.example:8443/a') === 'shop.example');
    for (const p of ['file:///tmp/a.html', 'about:blank', 'not a url', 'https://localhost/a', 'http://[::1]/a', ''])
        ok(`no label for ${JSON.stringify(p)}`, siteLabelTags(p).length === 0, siteLabelTags(p));

    for (const [name, src] of Object.entries(srcs)) {
        const a = src.indexOf('        function buildEvent(text) {'), b = src.indexOf('            return ev;', a);
        const body = a >= 0 && b > a ? src.slice(a, b) : '';
        ok(`${name}: both shapes of comment carry the label, with the client tag`,
           (body.match(/if \(labelClient\) tags\.push\(CLIENT_TAG, \.\.\.siteLabelTags\(pageUrl\)\);/g) || []).length === 2);
        ok(`${name}: and nothing else writes it unasked`, (src.match(/siteLabelTags\(/g) || []).length === 3);
    }
    return { name: 'site label', pass, fail };
}
