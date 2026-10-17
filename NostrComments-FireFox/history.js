// Your history: the pages where you opened the panel, from the list the extension already keeps
// for the "new" markers (nostrcomments_lastseen, capped at 300 by content.js).
//
// An extension page on purpose, not a tab in the panel. The panel sits in an open shadow root on
// whatever site is in front, so a list of the pages you have read would be readable by that site
// while the panel is open. No web page can reach this one.
//
// Deliberately offline. The pages you *commented* on would come from relays, and checking their
// signatures needs the verifier that lives inside content.js; showing unverified relay answers in a
// list that says "you were here" would let a relay plant links in it. That waits until the
// verifier is shared code.
const api = typeof browser !== 'undefined' ? browser : chrome;

// Only addresses a link can safely point at. Anything else in storage is skipped, not shown.
function safeHttpUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch (e) { return null; }
}

// The stored map ({ address: unix seconds }) as rows, dropping anything malformed.
function historyRows(lastSeen) {
    if (!lastSeen || typeof lastSeen !== 'object') return [];
    const rows = [];
    for (const [url, at] of Object.entries(lastSeen)) {
        const href = safeHttpUrl(url);
        if (!href || !Number.isFinite(at) || at <= 0) continue;
        rows.push({ url: href, at });
    }
    return rows;
}

// Search on the address, case-insensitive; then sort by date.
function filterRows(rows, query, order) {
    const q = String(query || '').trim().toLowerCase();
    const hit = q ? rows.filter(r => r.url.toLowerCase().includes(q)) : rows.slice();
    hit.sort((a, b) => order === 'oldest' ? a.at - b.at : b.at - a.at);
    return hit;
}

// The web reader shows a page's thread without the extension. Same rule as the popup's.
function readerLink(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        return 'https://briskness-byte.github.io/thread/?url=' + encodeURIComponent(u.href);
    } catch (e) { return null; }
}

if (typeof document !== 'undefined' && document.getElementById('list')) {
    const $ = id => document.getElementById(id);
    let rows = [];

    const draw = () => {
        const shown = filterRows(rows, $('q').value, $('order').value);
        const list = $('list');
        list.replaceChildren();
        $('count').textContent = rows.length
            ? (shown.length === rows.length ? `${rows.length} pages` : `${shown.length} of ${rows.length} pages`)
            : '';
        if (!shown.length) {
            const li = document.createElement('li');
            li.className = 'empty';
            li.textContent = rows.length ? 'No page matches that search.' : 'Nothing yet — pages appear here once you open the panel on them.';
            list.appendChild(li);
            return;
        }
        for (const r of shown) {
            const li = document.createElement('li');
            const when = document.createElement('div');
            when.className = 'when';
            when.textContent = new Date(r.at * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
            const page = document.createElement('a');
            page.className = 'page';
            page.href = r.url;
            page.target = '_blank';
            page.rel = 'noopener noreferrer';
            page.textContent = r.url.replace(/^https?:\/\//, '');
            li.append(when, page);
            const reader = readerLink(r.url);
            if (reader) {
                const a = document.createElement('a');
                a.className = 'reader';
                a.href = reader;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = 'Read the thread on the web';
                li.appendChild(a);
            }
            list.appendChild(li);
        }
    };

    const load = async () => {
        let d = {};
        try { d = await api.storage.local.get('nostrcomments_lastseen'); } catch (e) {}
        rows = historyRows(d.nostrcomments_lastseen);
        draw();
    };

    $('q').addEventListener('input', draw);
    $('order').addEventListener('change', draw);

    // Two steps, like Delete in the panel: this cannot be undone.
    let armed = false, disarm = null;
    $('clear').addEventListener('click', async () => {
        const b = $('clear');
        if (!armed) {
            armed = true;
            b.classList.add('armed');
            b.textContent = 'Clear all? Click again';
            disarm = setTimeout(() => { armed = false; b.classList.remove('armed'); b.textContent = 'Clear history'; }, 6000);
            return;
        }
        clearTimeout(disarm);
        armed = false;
        b.classList.remove('armed');
        b.textContent = 'Clear history';
        try { await api.storage.local.remove('nostrcomments_lastseen'); } catch (e) {}
        await load();
    });

    // Another tab marking a page as seen updates this list while it is open.
    try { api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.nostrcomments_lastseen) load(); }); } catch (e) {}

    load();
}
