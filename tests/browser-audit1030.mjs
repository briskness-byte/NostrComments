// Fixes from the security audit of 30 October 2026 (docs/SECURITY-AUDIT-2026-10-30.md).
//
// N1/N2: a thread filled with hundreds of different quotes and mentions must not flood the reader's
// relays. Quotes are looked up one batch at a time and capped per page (600 quotes used to be 30
// lookups at once); profile requests — for commenters and mentioned names alike — are batched, where
// a thread of 150 strangers used to make over 300 of them.
//
// N3/N4: nothing that says something about the reader stays on the page once the panel is shut —
// the backup bar (the reader just posted with a key made here) and the count from their mute list.
// The bar comes back when the panel is opened again, if it was not answered.
//
//   node tests/browser-audit1030.mjs
//   NC_BROWSER=firefox node tests/browser-audit1030.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, seedStorage, ROOT, EXT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9698);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8698);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8699);

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();
const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Audit 30 Oct QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);
const ME = newKey();
const randHex = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');

// 150 comments, each quoting four different notes nobody holds and mentioning a different stranger.
for (let i = 0; i < 150; i++) {
    relay.stored.push(await sign(newKey(), { kind: 1111, created_at: now - 1000 + i,
        tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
        content: `Comment ${i} quoting nostr:${toBech32('note', randHex())} nostr:${toBech32('note', randHex())} nostr:${toBech32('note', randHex())} nostr:${toBech32('note', randHex())} and asking nostr:${toBech32('npub', randHex())}` }));
}
// And one comment, the newest, stuffed with 400 different quotes: the thread shows 20 comments at a
// time, so a flood has to come from inside a single comment.
relay.stored.push(await sign(newKey(), { kind: 1111, created_at: now - 10,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'Quote bomb:\n' + Array.from({ length: 400 }, () => 'nostr:' + toBech32('note', randHex())).join('\n') }));
// The reader's own mute list, so Settings has a count to show.
relay.stored.push(await sign(ME, { kind: 10000, created_at: now - 50, content: '', tags: [['p', randHex()], ['word', 'zzyzx']] }));

// Messages from the extension to the relay. Counted rather than sockets: with the background socket
// (the default) every lookup shares one connection, so a flood shows up as requests, not connections.
let opens = 0;
relay.onTraffic = t => { if (t.type === 'in') opens++; };

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncaud-', windowSize: '1000,1700', extPath: process.env.NC_EXT || EXT,
    onClose: () => { site.close(); relay.close(); },
});
await goto(site.url);
await wait(2500);
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);
// A key made here and never backed up, which is when the bar is offered.
await js(seedStorage({ nostrcomments_keybackup: false, nostrcomments_pwoffered: true }));
await wait(800);

console.log('\n=== N2: a thread full of mentions does not open a socket per name ===');
opens = 0;
await goto(site.url);
await wait(8000);   // the thread loads and is drawn while the panel is shut
const closedOpens = opens;
ok('loading a thread with 150 different mentions sends only a handful of requests', closedOpens <= 30, closedOpens);

console.log('\n=== N1: opening the panel does not open a socket per redraw for quotes ===');
opens = 0;
await nclick("s.getElementById('nc-btn')");
await wait(15000);
ok('a comment with 400 different quotes does not become 20 lookups at once: a few batches, capped', opens <= 30, opens);
const links = await js(`${ROOT} return s.querySelectorAll('#list a.nc-quote').length;`);
ok('the quotes are still shown, as short links', links >= 20, links);

console.log('\n=== N3: the backup bar is not left on the page ===');
await js(`${ROOT} const i = s.getElementById('input'); i.value = 'My first comment here.'; i.dispatchEvent(new Event('input', {bubbles:true})); return 1;`);
await nclick("s.getElementById('send')");
await wait(4000);
const bar = () => js(`${ROOT} return getComputedStyle(s.getElementById('backup-bar')).display;`);
ok('after a first comment the bar is offered', (await bar()) === 'flex', await bar());
await js(`${ROOT} s.getElementById('c').click(); return 1;`);   // the panel's close button
await wait(800);
ok('closing the panel takes it off the page', (await bar()) === 'none', await bar());
await nclick("s.getElementById('nc-btn')");
await wait(1200);
ok('opening it again brings it back, still unanswered', (await bar()) === 'flex', await bar());

console.log('\n=== N4: the count from the mute list is not left on the page ===');
await js(`${ROOT} if (s.getElementById('settings').style.display !== 'block') s.getElementById('gear-btn').click(); return 1;`);
await wait(2500);
const noteOpen = await js(`${ROOT} return s.getElementById('listmutes-note').textContent;`);
ok('with Settings open it says how many come from the mute list', /1 person/.test(noteOpen || ''), noteOpen);
await js(`${ROOT} s.getElementById('c').click(); return 1;`);
await wait(800);
const noteShut = await js(`${ROOT} return s.getElementById('listmutes-note').textContent;`);
ok('closing the panel clears it', noteShut === '', noteShut);

await finish(state.fail ? 1 : 0);
