// Connecting waits until the page has been looked at.
//
// Every page visit used to open a socket to every configured relay the moment the script ran —
// before the reader had decided to stay, and in background tabs nobody had glanced at yet. Most
// visits are glances, so most of that traffic bought nothing.
//
// Three guarantees, and the third is the one a future refactor is most likely to break: somebody
// who opens the panel must not be made to sit through the wait.
//
//   node tests/browser-lazyconnect.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9529);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8084);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8456);

const { normalizeUrl, toBech32, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Lazy connect QA page' });

const PAGE = normalizeUrl(site.url);
const ME = newKey(), AUTHOR = newKey();
relay.stored.push(await sign(AUTHOR, {
    kind: 1111, created_at: Math.floor(Date.now() / 1000) - 300,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'A comment waiting to be loaded.',
}));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'nclazy-',
    onClose: () => { site.close(); relay.close(); },
});

// Counted at the relay, so the extension carries no measurement code of its own.
let sockets = 0;
relay.onTraffic = e => { if (e.type === 'open') sockets++; };

await goto(site.url);
await wait(3500);
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);

console.log('=== a visit that does not stay ===');
sockets = 0;
await goto(site.url);
await wait(1200);            // shorter than the settle
const during = sockets;
await goto('about:blank');
await wait(4000);
ok('nothing is connected in the first second', during === 0, during);
ok('and leaving costs nothing at all', sockets === 0, sockets);

console.log('\n=== a visit that stays ===');
sockets = 0;
await goto(site.url);
await wait(9000);
ok('it connects once the page has been read for a moment', sockets > 0, sockets);
const loaded = await js(`${ROOT} return s.getElementById('list').querySelectorAll('.c').length;`);
ok('and the thread loads as before', loaded >= 1, loaded);

console.log('\n=== somebody who asks for it does not wait ===');
// The guarantee that matters most: opening the panel skips the delay. A reader who clicks the
// button has already decided; making them watch a timer would trade one annoyance for another.
sockets = 0;
await goto(site.url);
await wait(400);
const beforeOpen = sockets;
await js(`${ROOT} return !!s;`);
await js(`${ROOT} const b = s.getElementById('nc-btn'); if (b) b.click(); return 1;`);
await wait(2000);
ok('nothing had connected yet at that point', beforeOpen === 0, beforeOpen);
ok('opening the panel connects straight away', sockets > 0, sockets);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} lazy connect: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
