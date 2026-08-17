// Pictures that wait until they are asked for.
//
// A picture in a comment is fetched from wherever its author chose, which hands that server the
// reader's IP address, and nothing here is moderated — a thread can carry a picture nobody should
// have downloaded. Automatic loading makes both of those the reader's problem before they have seen
// anything, so there is a switch. It is on by default: a thread of grey boxes is a worse product,
// and the point is that the way out exists and is easy to find.
//
// One assertion carries this suite: with the switch off, the server hosting the picture must see
// nothing. Not "no <img> on screen" — a hidden <img>, a preload, a lazily-loaded one that fires
// anyway, all look fine on screen and still make the request. So the picture host counts hits, and
// the count is the test.
//
//   node tests/browser-pictures.mjs
//   NC_BROWSER=firefox node tests/browser-pictures.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import http from 'http';
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT, TESTHOST } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9580);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8140);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8500);
const IMG_PORT = RELAY_PORT + 1;

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let hits = [];
const imgHost = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG);
});
await new Promise(r => imgHost.listen(IMG_PORT, '127.0.0.1', r));
// A name, not 127.0.0.1: the extension refuses an address literal as a picture host.
const IMG = `http://${TESTHOST}:${IMG_PORT}`;

const relay = await startRelay({ port: RELAY_PORT });
const { stored } = relay;
const site = await startSite({ port: SITE_PORT, heading: 'Pictures QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);

const ME = newKey();
const THEM = newKey(), THEM_PUB = _secp.pubKey(THEM);

stored.push(await sign(THEM, {
    kind: 1111, created_at: now - 300,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: `Look at this ${IMG}/inline.png`,
}));
// The avatar is the other half, and the worse one: it is fetched on every page where its owner has
// commented, so one host collects a reading list rather than a single visit.
stored.push(await sign(THEM, {
    kind: 0, created_at: now - 400, tags: [],
    content: JSON.stringify({ name: 'Picture Poster', picture: `${IMG}/avatar.png` }),
}));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncpic-',
    onClose: () => { site.close(); relay.close(); imgHost.close(); },
});

const openPanel = async () => {
    await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
    await wait(2500);
};
const look = () => js(`${ROOT} return JSON.stringify({
    imgs: s.getElementById('list').querySelectorAll('img.nc-img').length,
    avatars: s.getElementById('list').querySelectorAll('img.avatar').length,
    holds: [...s.getElementById('list').querySelectorAll('.nc-hold')].map(b => b.textContent),
  });`);

console.log(`\nrelay: ${relay.url}\npage:  ${PAGE}\n`);
await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);

console.log('\n=== on by default ===');
hits = [];
await goto(site.url);
await wait(3500);
await openPanel();
let r = JSON.parse(await look());
ok('the picture in the comment is shown', r.imgs === 1, r);
ok('and the avatar is shown', r.avatars === 1, r);
ok('the host was asked for both', hits.length >= 2, hits);
ok('nothing is waiting behind a placeholder', r.holds.length === 0, r.holds);

console.log('\n=== switched off ===');
await js(`${ROOT} const t = s.getElementById('autoimg-toggle'); t.checked = false; t.dispatchEvent(new Event('change')); return 1;`);
await wait(800);
hits = [];
await goto(site.url);
await wait(4000);
await openPanel();
r = JSON.parse(await look());
// The assertion the whole suite exists for.
ok('the picture host is not contacted at all', hits.length === 0, hits);
ok('no picture element was created', r.imgs === 0, r);
ok('and no avatar either', r.avatars === 0, r);
ok('a placeholder stands in its place', r.holds.length === 1, r.holds);
// The host is what lets somebody decide whether to ask for it, so it has to be on screen.
ok('the placeholder names the host', (r.holds[0] || '').includes(TESTHOST), r.holds);
ok('and says what clicking does', /show picture/i.test(r.holds[0] || ''), r.holds);

console.log('\n=== asking for one ===');
await js(`${ROOT} s.getElementById('list').querySelector('.nc-hold').click(); return 1;`);
await wait(2000);
r = JSON.parse(await look());
ok('the picture is fetched once it is asked for', r.imgs === 1, r);
ok('exactly one request went out', hits.length === 1, hits);
ok('and the avatar is still held back', r.avatars === 0, r);

console.log('\n=== the setting survives a reload ===');
hits = [];
await goto(site.url);
await wait(4000);
await openPanel();
r = JSON.parse(await look());
ok('still held back after reloading', r.imgs === 0 && r.holds.length === 1, r);
ok('and still nothing was requested', hits.length === 0, hits);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} pictures: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
