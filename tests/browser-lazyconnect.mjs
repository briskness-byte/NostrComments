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
//
// Subscriptions for this page, not new connections. Counting connections was right while every
// tab opened its own socket; since 23.2.0 the background script keeps one socket per relay and
// holds it for 30 seconds after the last handle lets go, so a revisit reuses it and the relay sees
// no new connection at all. That made this suite report "never connected" for an extension that
// was talking to the relay perfectly well. What the test actually means to watch is whether the
// extension has asked this relay about this page, which is what a subscription is.
const pageSubs = () => [...relay.conns].reduce((n, c) =>
    n + [...c.subs.values()].filter(fs => fs.some(f => JSON.stringify(f).includes(PAGE))).length, 0);

await goto(site.url);
await wait(3500);
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);

console.log('=== a visit that does not stay ===');
await goto(site.url);
await wait(1200);            // shorter than the settle
const during = pageSubs();
await goto('about:blank');
await wait(4000);
ok('nothing is asked about the page in the first second', during === 0, during);
ok('and leaving costs nothing at all', pageSubs() === 0, pageSubs());

console.log('\n=== a visit that stays ===');
await goto(site.url);
await wait(9000);
ok('it asks once the page has been read for a moment', pageSubs() > 0, pageSubs());
const loaded = await js(`${ROOT} return s.getElementById('list').querySelectorAll('.c').length;`);
ok('and the thread loads as before', loaded >= 1, loaded);

console.log('\n=== somebody who asks for it does not wait ===');
// The guarantee that matters most: opening the panel skips the delay. A reader who clicks the
// button has already decided; making them watch a timer would trade one annoyance for another.
await goto(site.url);
await wait(400);
const beforeOpen = pageSubs();
await js(`${ROOT} return !!s;`);
await js(`${ROOT} const b = s.getElementById('nc-btn'); if (b) b.click(); return 1;`);
await wait(2000);
ok('nothing had been asked yet at that point', beforeOpen === 0, beforeOpen);
ok('opening the panel asks straight away', pageSubs() > 0, pageSubs());

console.log(`\n${state.fail === 0 ? '✓' : '✗'} lazy connect: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
