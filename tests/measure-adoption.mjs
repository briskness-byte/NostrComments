// How many people have actually said something with this extension.
//
// Installs are not use. The stores report downloads and daily users; neither can tell whether
// anybody has ever posted. Since v23 every comment carries NIP-89's client tag, so the question is
// answerable from the network itself: fetch comments and count distinct keys.
//
// Relays cannot filter on it — NIP-01 only indexes single-letter tags, and `client` is seven — so
// this pulls comments and filters locally. That is fine while the corpus is small, and the day it
// stops being fine is a good day.
//
//   node tests/measure-adoption.mjs
//
// Nothing here is a test. It talks to the public network and prints numbers.
// The extension publishes to its defaults and to EXTRA_PUBLISH_RELAYS, so the quiet ones among those
// (purplerelay, bitcoiner.social, nostr.mom) hold every comment without the bot traffic around it.
// purplerelay held 211 web comments in Oct 2026, mostly ours; nos.lol received ~600 a day.
const RELAYS = ['wss://purplerelay.com', 'wss://nostr.bitcoiner.social', 'wss://nostr.mom',
                'wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.damus.io', 'wss://nostr.oxtr.dev',
                'wss://relay.snort.social', 'wss://relay.nostr.net'];
const COMMENT_KIND = 1111;
const LIMIT = 500;
const MAX_PAGES = 10;

const q = (r, filter, ms = 15000) => new Promise(res => {
    const out = []; let ws, done = false;
    const finish = () => { if (done) return; done = true; try { ws && ws.close(); } catch {} res(out); };
    try { ws = new WebSocket(r); } catch { return res(out); }
    const t = setTimeout(finish, ms);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'ad', filter]));
    ws.onmessage = m => {
        let p; try { p = JSON.parse(m.data); } catch { return; }
        if (p[0] === 'EVENT') out.push(p[2]);
        else if (p[0] === 'EOSE' || p[0] === 'CLOSED') { clearTimeout(t); finish(); }
    };
    ws.onerror = () => { clearTimeout(t); finish(); };
    ws.onclose = () => { clearTimeout(t); finish(); };
});

// Only comments on web pages (K=web). Without that filter the newest LIMIT comments are mostly
// replies to ordinary Nostr notes, and by Oct 2026 they had pushed every one of ours out: the
// script reported 0 while the relays held 29. Relays also cap a single REQ (relay.nostr.net at 100),
// so page back with `until` until a relay runs dry. The busy ones never do — bots post hundreds a
// day — hence MAX_PAGES: they only contribute recent weeks, the quiet ones above the full history.
const all = new Map();
for (const r of RELAYS) {
    let n = 0, until;
    for (let page = 0; page < MAX_PAGES; page++) {
        const evs = await q(r, { kinds: [COMMENT_KIND], '#K': ['web'], limit: LIMIT, ...(until ? { until } : {}) });
        for (const e of evs) all.set(e.id, e);
        n += evs.length;
        if (!evs.length) break;
        until = evs.reduce((m, e) => Math.min(m, e.created_at), Infinity) - 1;
    }
    console.log(`${r.replace('wss://', '').padEnd(20)} ${String(n).padStart(4)} web comments`);
}

const evs = [...all.values()];
const client = e => (e.tags.find(t => t[0] === 'client') || [])[1] || '';
// The browser suites publish from pages on loopback. They are meant to reach only their own relay, but
// one that forgot to reload posted 56 comments to real relays on 13 Sep 2026 — each with this client
// tag and a fresh key, so they look exactly like 14 new users. They are not.
const pageOf = e => (e.tags.find(t => t[0] === 'I') || [])[1] || '';
const testPage = e => /^https?:\/\/(127\.0\.0\.1|localhost|[^/:]*\.nctest)([:/]|$)/i.test(pageOf(e));
const tagged = evs.filter(e => /nostrcomments/i.test(client(e)));
const ours = tagged.filter(e => !testPage(e));
const keys = new Set(ours.map(e => e.pubkey));
const pages = new Set(ours.map(e => (e.tags.find(t => t[0] === 'I') || [])[1]).filter(Boolean));

console.log(`\nweb comments seen          : ${evs.length}`);
console.log(`written with NostrComments : ${ours.length}`);
console.log(`  (test pages left out)     : ${tagged.length - ours.length}`);
console.log(`by distinct keys           : ${keys.size}`);
console.log(`across distinct pages      : ${pages.size}`);

if (ours.length) {
    const at = e => new Date(e.created_at * 1000).toISOString().slice(0, 10);
    const sorted = ours.sort((a, b) => a.created_at - b.created_at);
    console.log(`first                      : ${at(sorted[0])}`);
    console.log(`most recent                : ${at(sorted[sorted.length - 1])}`);

    // Growth is the number of keys that post for the first time, per month. A key counts in the
    // month of its first comment only, so one busy commenter does not look like a crowd.
    const firstSeen = new Map();
    for (const e of sorted) if (!firstSeen.has(e.pubkey)) firstSeen.set(e.pubkey, e.created_at);
    const month = s => new Date(s * 1000).toISOString().slice(0, 7);
    const rows = {};
    for (const e of sorted) (rows[month(e.created_at)] ||= { comments: 0, keys: new Set(), fresh: 0 }).comments++;
    for (const e of sorted) rows[month(e.created_at)].keys.add(e.pubkey);
    for (const s of firstSeen.values()) rows[month(s)].fresh++;
    console.log('\nmonth     comments  keys  new keys');
    for (const [m, r] of Object.entries(rows))
        console.log(`${m}  ${String(r.comments).padStart(8)}  ${String(r.keys.size).padStart(4)}  ${String(r.fresh).padStart(8)}`);
}

// Worth knowing what else is out there: the tag says which client, so this is free.
const byClient = {};
for (const e of evs) { const c = client(e) || '(none)'; byClient[c] = (byClient[c] || 0) + 1; }
console.log('\nall web comments by client tag:');
for (const [c, n] of Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 8))
    console.log(`  ${String(n).padStart(4)}  ${c}`);

// The number that matters is the second one, and only over time. Re-run it monthly; a single
// reading says nothing about whether anybody arrived.
