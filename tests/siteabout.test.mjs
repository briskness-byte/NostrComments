// "About this site": which homepage thread a page offers above its own (13 Nov 2026).
//
// siteHome() decides it. A page offers its site's homepage; the homepage itself offers nothing (its
// own thread already is that); platforms offer nothing, because youtube.com's homepage says nothing
// about the video being watched; and only http(s) pages take part.
import fs from 'fs';
import { extensionCode } from './harness.mjs';

const FILES = { chrome: '../NostrComments-Chrome/content.js', firefox: '../NostrComments-FireFox/content.js' };

export async function run() {
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };
    const { normalizeUrl } = extensionCode();
    const blocks = {};
    for (const [name, rel] of Object.entries(FILES)) {
        const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
        const a = src.indexOf('// siteHome: start'), b = src.indexOf('// siteHome: end', a);
        blocks[name] = a >= 0 && b > a ? src.slice(a, b) : null;
        ok(`${name}: siteHome can be read out of content.js`, !!blocks[name]);
    }
    ok('both builds decide the same way', blocks.chrome === blocks.firefox);
    if (!blocks.chrome) return { name: 'about this site', pass, fail };
    const siteHome = new Function('normalizeUrl', `${blocks.chrome}\nreturn siteHome;`)(normalizeUrl);
    const home = p => siteHome(normalizeUrl(p));

    ok('a product page offers its shop\'s homepage', home('https://shop.example/product/42') === normalizeUrl('https://shop.example/'), home('https://shop.example/product/42'));
    ok('so does a checkout with a query string', home('https://shop.example/checkout?step=2') === normalizeUrl('https://shop.example/'));
    ok('the homepage itself offers nothing', home('https://shop.example/') === null);
    ok('www stays part of the address it is', home('https://www.shop.example/a') === normalizeUrl('https://www.shop.example/'));
    ok('a subdomain is its own site', home('https://alice.github.io/post') === normalizeUrl('https://alice.github.io/'));
    for (const p of ['https://www.youtube.com/watch?v=x', 'https://x.com/someone/status/1', 'https://github.com/a/b', 'https://en.wikipedia.org/wiki/Nostr',
                     'https://www.reddit.com/r/x', 'https://www.amazon.de/dp/123', 'https://news.google.com/a', 'https://someone.substack.com/p/x'])
        ok(`a platform offers nothing: ${new URL(p).hostname}`, home(p) === null, home(p));
    ok('a lookalike of a platform is not a platform', home('https://youtube.com.shop.example/a') === normalizeUrl('https://youtube.com.shop.example/'));
    ok('only http(s)', siteHome('file:///tmp/a.html') === null && siteHome('not a url') === null);
    return { name: 'about this site', pass, fail };
}
