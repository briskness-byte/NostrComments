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
const RELAYS = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.damus.io',
                'wss://relay.snort.social', 'wss://nostr.mom', 'wss://relay.nostr.net'];
const COMMENT_KIND = 1111;
const LIMIT = 500;

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

const all = new Map();
for (const r of RELAYS) {
    const evs = await q(r, { kinds: [COMMENT_KIND], limit: LIMIT });
    for (const e of evs) all.set(e.id, e);
    console.log(`${r.replace('wss://', '').padEnd(20)} ${String(evs.length).padStart(4)} comments`);
}

const evs = [...all.values()];
const client = e => (e.tags.find(t => t[0] === 'client') || [])[1] || '';
const ours = evs.filter(e => /nostrcomments/i.test(client(e)));
const keys = new Set(ours.map(e => e.pubkey));
const pages = new Set(ours.map(e => (e.tags.find(t => t[0] === 'I') || [])[1]).filter(Boolean));

console.log(`\nkind ${COMMENT_KIND} events seen : ${evs.length}`);
console.log(`written with NostrComments : ${ours.length}`);
console.log(`by distinct keys           : ${keys.size}`);
console.log(`across distinct pages      : ${pages.size}`);

if (ours.length) {
    const at = e => new Date(e.created_at * 1000).toISOString().slice(0, 10);
    const sorted = ours.sort((a, b) => a.created_at - b.created_at);
    console.log(`first                      : ${at(sorted[0])}`);
    console.log(`most recent                : ${at(sorted[sorted.length - 1])}`);
}

// Worth knowing what else is out there: the tag says which client, so this is free.
const byClient = {};
for (const e of evs) { const c = client(e) || '(none)'; byClient[c] = (byClient[c] || 0) + 1; }
console.log('\nall kind 1111 by client tag:');
for (const [c, n] of Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 8))
    console.log(`  ${String(n).padStart(4)}  ${c}`);

// The number that matters is the second one, and only over time. Re-run it monthly; a single
// reading says nothing about whether anybody arrived.
