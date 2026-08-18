// Sharing your own comment to your feed.
//
// A comment here is a kind 1111 scoped to a page address. That is the right shape — it keeps
// comments out of the timelines of everyone who follows you, which is the problem NIP-22 exists to
// solve — but it also means the only people who can ever see it are those who have this extension
// and open that page. For a project with a few dozen keys in it, that is a sealed room.
//
// So sharing is a second, separate event: an ordinary note carrying the comment and a link back to
// the page. Nothing is broadcast unless somebody asks for it, once, per comment.
//
// The assertion that pins the design is the last one. The panel reads kind 1 with an r tag as a
// legacy comment, so tagging the share with the page would make it appear a second time inside the
// very thread it was shared from. The address goes in the text instead.
//
//   node tests/browser-share.mjs
//   NC_BROWSER=firefox node tests/browser-share.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9585);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8145);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8505);

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const published = [];
const relay = await startRelay({ port: RELAY_PORT, onEvent: (ev, api) => { published.push(ev); api.accept(); } });
const { stored } = relay;
const site = await startSite({ port: SITE_PORT, heading: 'Share QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);

const ME = newKey(), MY_PUB = _secp.pubKey(ME);
const THEM = newKey();
const MINE = 'A comment of my own, worth putting in front of people.';

stored.push(await sign(ME, {
    kind: 1111, created_at: now - 300,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: MINE,
}));
stored.push(await sign(THEM, {
    kind: 1111, created_at: now - 200,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'Somebody else wrote this one.',
}));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncshare-',
    onClose: () => { site.close(); relay.close(); },
});

console.log(`\nrelay: ${relay.url}\npage:  ${PAGE}\n`);
await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);
await goto(site.url);
await wait(3500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);

let cards = 0;
for (let i = 0; i < 25; i++) {
    cards = await js(`${ROOT} return s.getElementById('list').querySelectorAll('.c').length;`);
    if (cards >= 2) break;
    await wait(600);
}
ok('both comments are on screen', cards === 2, cards);
if (!cards) { console.log('\nNothing rendered; aborting.'); await finish(1); }

console.log('\n=== only your own comment offers it ===');
const where = JSON.parse(await js(`${ROOT}
  return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')]
    .map(c => ({ own: c.classList.contains('own'), share: !!c.querySelector('.share-btn') })));`));
ok('your own comment has a share button', where.some(c => c.own && c.share), where);
ok('somebody else\'s does not', !where.some(c => !c.own && c.share), where);

console.log('\n=== one click arms, it does not post ===');
published.length = 0;
await js(`${ROOT} s.getElementById('list').querySelector('.share-btn').click(); return 1;`);
await wait(900);
const armed = await js(`${ROOT} const b = s.getElementById('list').querySelector('.share-btn'); return JSON.stringify({ armed: b.classList.contains('armed'), text: b.textContent });`);
ok('the button arms itself', JSON.parse(armed).armed === true, armed);
ok('and asks before doing anything', /feed\?/i.test(JSON.parse(armed).text), armed);
// The whole point of two steps: a stray click must not broadcast to everyone following you.
ok('nothing was published yet', published.length === 0, published.map(e => e.kind));

console.log('\n=== the second click posts a note ===');
await js(`${ROOT} s.getElementById('list').querySelector('.share-btn').click(); return 1;`);
await wait(2500);
const notes = published.filter(e => e.kind === 1);
ok('exactly one note was published', notes.length === 1, published.map(e => e.kind));
if (notes.length !== 1) { console.log('\nNo note to inspect; aborting.'); await finish(1); }

const n = notes[0];
ok('it is signed by you', n.pubkey === MY_PUB, n.pubkey);
ok('it carries the comment', n.content.includes(MINE), n.content);
ok('and links back to the page', n.content.includes(PAGE), n.content);
ok('it names the client that wrote it', (n.tags || []).some(t => t[0] === 'client' && t[1] === 'NostrComments'), n.tags);

// The one that keeps the design honest. An r tag here would be read by the panel as a legacy
// comment on this page, so the share would appear a second time in the thread it came from.
ok('it carries no r tag, so it is not a comment on this page',
   !(n.tags || []).some(t => t[0] === 'r'), n.tags);
ok('nor an I tag', !(n.tags || []).some(t => t[0] === 'I'), n.tags);

console.log('\n=== and it does not come back as a comment ===');
await wait(2500);
const after = await js(`${ROOT} return s.getElementById('list').querySelectorAll('.c').length;`);
ok('the thread still holds two comments, not three', after === 2, after);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} share: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
