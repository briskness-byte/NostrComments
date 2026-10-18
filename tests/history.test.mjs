// The "Your history" page: the pages where the panel was opened, searchable, sortable, clearable.
//
// What matters most here is what the page does not do. It is an extension page so that no web page
// can read the list, it makes no network request at all, and it never turns stored text into HTML.
// Those are checked on the shipped files; the list logic is checked by running it.
import fs from 'fs';

const dirs = { chrome: 'NostrComments-Chrome', firefox: 'NostrComments-FireFox' };
const read = p => { try { return fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8'); } catch (e) { return null; } };

function load(src) {
    const end = src.indexOf('\nif (typeof document');
    if (end < 0) return null;
    return new Function('browser', 'chrome', `${src.slice(0, end)}\nreturn { safeHttpUrl, historyRows, filterRows, readerLink };`)(undefined, {});
}

export async function run() {
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };

    const js = { chrome: read(`${dirs.chrome}/nc-history.js`), firefox: read(`${dirs.firefox}/nc-history.js`) };
    const html = { chrome: read(`${dirs.chrome}/history.html`), firefox: read(`${dirs.firefox}/history.html`) };
    ok('both builds have nc-history.js and history.html', js.chrome && js.firefox && html.chrome && html.firefox);
    ok('and they are identical across builds', js.chrome === js.firefox && html.chrome === html.firefox);
    if (!js.firefox) return { name: 'history page', pass, fail };

    const f = load(js.firefox);
    ok('the list functions can be read out of nc-history.js', !!f);
    if (f) {
        const { historyRows, filterRows, readerLink, safeHttpUrl } = f;
        const stored = {
            'https://www.nature.com/articles/d41586-026-02763-3': 1757664000,
            'https://example.org/old': 1700000000,
            'https://news.example.com/story?id=7': 1760000000,
            'javascript:alert(1)': 1760000001,
            'not a url': 1760000002,
            'https://example.org/bad-time': 'yesterday',
            'https://example.org/zero': 0,
        };
        const rows = historyRows(stored);
        ok('rows come from the stored map', rows.length === 3, rows.map(r => r.url));
        ok('a javascript: address is never a row', !rows.some(r => /^javascript:/i.test(r.url)));
        ok('malformed addresses and times are skipped', !rows.some(r => /bad-time|zero|not a url/.test(r.url)));
        ok('nothing stored, nothing shown', historyRows(undefined).length === 0 && historyRows(null).length === 0 && historyRows('x').length === 0);

        const newest = filterRows(rows, '', 'newest');
        ok('newest first by default', newest[0].url.includes('news.example.com') && newest[2].url.includes('/old'), newest.map(r => r.url));
        const oldest = filterRows(rows, '', 'oldest');
        ok('oldest first on request', oldest[0].url.includes('/old'), oldest.map(r => r.url));
        ok('search matches part of the address', filterRows(rows, 'nature', 'newest').length === 1);
        ok('search ignores case and spaces around it', filterRows(rows, '  NATURE ', 'newest').length === 1);
        ok('a search with no match gives nothing', filterRows(rows, 'no-such-site', 'newest').length === 0);
        ok('filtering does not reorder the stored rows', rows[0].url === historyRows(stored)[0].url);

        ok('the reader link encodes the address', readerLink('https://news.example.com/story?id=7') === 'https://briskness-byte.github.io/thread/?url=' + encodeURIComponent('https://news.example.com/story?id=7'));
        ok('and only for http(s)', readerLink('javascript:alert(1)') === null && safeHttpUrl('data:text/html,x') === null);

        // Same rule as the popup's readerLink, so both lead to the same thread.
        const popup = read(`${dirs.firefox}/popup.js`) || '';
        const a = popup.indexOf('function readerLink('), b = popup.indexOf('\n}\n', a);
        const popupReader = a >= 0 && b > a ? (0, eval)(`(${popup.slice(a, b + 2)})`) : null;
        ok('the popup and the history page build the same reader link',
           popupReader && ['https://a.example/x?y=1', 'about:addons', ''].every(u => popupReader(u) === readerLink(u)));
    }

    for (const [name, dir] of Object.entries(dirs)) {
        const src = js[name] || '';
        ok(`${name}: the history page makes no network request`, !/\bfetch\s*\(|WebSocket|XMLHttpRequest|sendBeacon|EventSource/.test(src));
        ok(`${name}: and never writes HTML`, !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
        ok(`${name}: links open without a referrer`, (src.match(/rel = 'noopener noreferrer'/g) || []).length >= 2);
        ok(`${name}: clearing takes two clicks`, /if \(!armed\)/.test(src) && src.includes("api.storage.local.remove('nostrcomments_lastseen')"));
        const h = html[name] || '';
        ok(`${name}: history.html loads its script from a file`, h.includes('<script src="nc-history.js"></script>'));
        ok(`${name}: and has no inline script`, !/<script>(?!\s*<\/script>)/.test(h) && !/\son[a-z]+=/i.test(h));
        const p = read(`${dir}/popup.html`) || '', pj = read(`${dir}/popup.js`) || '';
        ok(`${name}: the popup offers it`, p.includes('id="history"') && pj.includes("api.runtime.getURL('history.html')"));
        // Without this an open tab writes its old copy back after "Clear history".
        const c = read(`${dir}/content.js`) || '';
        ok(`${name}: open tabs follow a cleared list`, /const seenChange = changes\.nostrcomments_lastseen;/.test(c) && /_lastSeenMap = \(seenChange\.newValue/.test(c));
        const mf = JSON.parse(read(`${dir}/manifest.json`) || '{}');
        ok(`${name}: no new permission for it`, JSON.stringify(mf.permissions) === JSON.stringify(['storage']), mf.permissions);
    }

    const build = read('build.sh') || '';
    // A file named history.js in a zip trips Sanesecurity's Foxhole rule (18 Oct 2026); keep the prefix.
    ok('no file in the package is called history.js', !/PACKED=[^\n]*(^|[\s"])history\.js/.test(build));
    ok('the build packs history.html and nc-history.js', /PACKED=.*history\.html/.test(build) && /PACKED=.*nc-history\.js/.test(build));
    const privacy = read('PRIVACY.md') || '';
    ok('PRIVACY.md says the list can be seen and cleared', /Your history/.test(privacy));

    return { name: 'history page', pass, fail };
}
