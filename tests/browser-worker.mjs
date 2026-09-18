// The two transports, side by side, against one relay.
//
// Phase 2 of moving relay sockets out of the page. The point of the exercise is that everything
// above the transport is the same code either way — backoff, relay state, the refetch, the NIP-42
// exchange — so this suite runs the same scenario twice, once with sockets opened in the page and
// once with them opened in the background, and asserts the two agree on what came back.
//
// Agreeing is the whole claim. A worker path that loaded a thread but dropped a reply, or
// published to fewer relays, would look fine in isolation; it only shows up next to the path it
// has to replace.
//
// Then the case the rebuild is actually for: a page whose Content-Security-Policy forbids the
// relay. On Firefox the in-page transport cannot reach it — that is the bug, pinned by
// browser-csp.mjs — and the background transport must.
//
//   node tests/browser-worker.mjs
//   NC_BROWSER=firefox node tests/browser-worker.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import http from 'http';
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT, BROWSER } from './harness.mjs';

const CD_PORT    = Number(process.env.QA_PORT       || 9600);
const SITE_PORT  = Number(process.env.QA_SITE_PORT  || 8160);
const CSP_PORT   = Number(process.env.QA_CSP_PORT   || 8161);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8520);

const { normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site  = await startSite({ port: SITE_PORT, heading: 'Transport QA page' });

// Same shape x.com uses: the page names itself and nothing else.
const cspSite = http.createServer((_, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    res.end('<!doctype html><html><head><title>CSP QA</title></head><body style="font:16px sans-serif;padding:40px"><h1>Strict CSP page</h1><p>Article body text.</p></body></html>');
});
await new Promise(r => cspSite.listen(CSP_PORT, '127.0.0.1', r));
const CSP_URL = `http://127.0.0.1:${CSP_PORT}/`;

const MINE = newKey();
const AUTHOR = newKey();

// Two comments that exist on the relay before the browser starts, so "did the thread load" is a
// question about the transport rather than about anything the test just did.
const seed = async (url, text, agoSec) => relay.stored.push(await sign(AUTHOR, {
    kind: 1111, created_at: Math.floor(Date.now() / 1000) - agoSec,
    tags: [['I', url], ['K', 'web'], ['i', url], ['k', 'web']],
    content: text,
}));
const PAGE = normalizeUrl(site.url);
await seed(PAGE, 'First comment, seeded before the browser started.', 120);
await seed(PAGE, 'Second comment, so ordering has something to be wrong about.', 60);
await seed(normalizeUrl(CSP_URL), 'A comment that exists whether or not the page lets you see it.', 90);

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncwk-',
    onClose: () => { site.close(); cspSite.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}`, nsec: toBech32('nsec', MINE) }));
await wait(2500);

// --- reading the panel -------------------------------------------------------------------------
const thread = () => js(`${ROOT}
  s.getElementById('m').style.display='grid';
  s.getElementById('settings-close')?.click();
  // Leaf elements only. Taking every descendant returns each comment twice — once from the
  // element holding the text and once from every wrapper around it, and the wrapper's version
  // carries the npub and the vote buttons with it.
  return JSON.stringify([...s.getElementById('list').querySelectorAll('*')]
      .filter(e => e.children.length === 0)
      .map(e => e.textContent)
      .filter(t => /seeded before|ordering has something|lets you see it|posted from the/.test(t))
      .map(t => t.replace(/\\s+/g, ' ').trim())
      .filter((t, i, a) => a.indexOf(t) === i)
      .sort());`);

const post = async text => {
    await js(`${ROOT}
      s.getElementById('m').style.display='grid';
      s.getElementById('settings-close')?.click();
      const i = s.getElementById('input');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input', {bubbles:true}));
      return 1;`);
await nclick("s.getElementById('send')");
    await wait(4000);
};
const workerIsOn = () => js(`${ROOT}
  s.getElementById('m').style.display='grid';
  s.getElementById('gear-btn').click();
  const t = s.getElementById('worker-toggle');
  const v = t ? t.checked : null;
  s.getElementById('settings-close')?.click();
  return JSON.stringify(v);`);
const setWorker = want => js(`${ROOT}
  s.getElementById('m').style.display='grid';
  s.getElementById('gear-btn').click();
  const t = s.getElementById('worker-toggle');
  if (!t) return 'no toggle';
  if (t.checked !== ${want}) t.click();
  s.getElementById('settings-close')?.click();
  return String(t.checked);`);

// --- the toggle exists and is on -----------------------------------------------------------------
// On by default since browser-workerlife.mjs showed the worker surviving five idle minutes on both
// engines. The in-page transport is still there and still selectable, and run A needs it on purpose:
// the comparison is only worth anything if the two runs really are on different transports.
console.log('\n=== the transport is a choice, and it starts in the background ===');
ok('the setting is there, and on by default', (await workerIsOn()) === 'true', await workerIsOn());
ok('it can be turned off', (await setWorker(false)) === 'false');

// --- run A: sockets in the page --------------------------------------------------------------------
console.log('\n=== run A: sockets opened in the page ===');
// The setting takes hold on the next page load, so this reload is what puts run A in the page.
await goto(site.url);
await wait(4000);
const seenA = JSON.parse(await thread());
ok('the seeded thread loads', seenA.length === 2, seenA);

relay.published.length = 0;
await post('A comment posted from the in-page transport.');
const pubA = relay.published.filter(e => e.kind === 1111).map(e => e.content);
ok('a comment reaches the relay', pubA.length === 1, pubA);
const afterA = JSON.parse(await thread());
ok('and appears in the thread', afterA.length === 3, afterA);

// --- run B: sockets in the background -----------------------------------------------------------------
console.log('\n=== run B: the same thing, sockets opened in the background ===');
ok('the setting can be turned on', (await setWorker(true)) === 'true');
// It cannot take effect on a page that has already opened its sockets, which is what the setting
// says. This reload is the test of that claim as much as it is setup.
await goto(site.url);
await wait(4500);
ok('it survived the reload', (await workerIsOn()) === 'true', await workerIsOn());

const seenB = JSON.parse(await thread());
ok('the seeded thread loads over the background transport', seenB.length >= 2, seenB);

relay.published.length = 0;
await post('A comment posted from the background transport.');
const pubB = relay.published.filter(e => e.kind === 1111).map(e => e.content);
ok('a comment reaches the relay from there too', pubB.length === 1, pubB);

// --- the comparison, which is the point ------------------------------------------------------------------
console.log('\n=== the two agree ===');
const afterB = JSON.parse(await thread());
// Four now: two seeded plus one from each run. Both transports have to see all of them, including
// the one the other transport wrote.
ok('both transports end up showing the same thread', JSON.stringify(afterB) === JSON.stringify(afterA.concat(['A comment posted from the background transport.']).sort()),
   { inPage: afterA, background: afterB });
ok('and neither lost the other one\'s comment',
   afterB.some(t => /in-page transport/.test(t)) && afterB.some(t => /background transport/.test(t)), afterB);

// What went to the relay has to be indistinguishable: same kind, same tag shape. A transport that
// quietly changed the event would be a transport that invalidates its signature.
const lastA = relay.stored.find(e => /in-page transport/.test(e.content || ''));
const lastB = relay.stored.find(e => /background transport/.test(e.content || ''));
ok('both events reached the relay', !!lastA && !!lastB);
if (lastA && lastB) {
    ok('same kind', lastA.kind === lastB.kind, [lastA.kind, lastB.kind]);
    ok('same tag shape', JSON.stringify(lastA.tags.map(t => t[0])) === JSON.stringify(lastB.tags.map(t => t[0])),
       [lastA.tags.map(t => t[0]), lastB.tags.map(t => t[0])]);
    ok('both signed by the same key', lastA.pubkey === lastB.pubkey);
    // The signature is over the id, so a pipe that touched the event on the way through would
    // show up here and nowhere else.
    ok('both carry a full signature', /^[0-9a-f]{128}$/i.test(lastA.sig || '') && /^[0-9a-f]{128}$/i.test(lastB.sig || ''));
}

// --- the reason any of this exists ---------------------------------------------------------------------------
// A page that forbids the relay in its own CSP. On Firefox the in-page transport cannot get past
// it — that is the bug this rebuild is for. On Chromium a content script is exempt, so the
// assertion there is that the background transport did not break what already worked.
console.log('\n=== a site whose CSP forbids the relay ===');
await goto(CSP_URL);
await wait(5000);
const cspSeen = JSON.parse(await thread());
ok('the thread loads on a strict-CSP page over the background transport',
   cspSeen.some(t => /lets you see it/.test(t)), cspSeen);

if (BROWSER === 'firefox') {
    // The counter-proof, and the only one that matters: turn the transport back and the same page
    // must fail. Without this the assertion above would pass on a browser where the CSP never
    // blocked anything, and prove nothing about the fix.
    console.log('\n=== and the counter-proof: back in the page, the same site blocks it ===');
    await setWorker(false);
    await goto(CSP_URL);
    await wait(5000);
    const blocked = JSON.parse(await thread());
    ok('the in-page transport cannot reach the relay there', !blocked.some(t => /lets you see it/.test(t)), blocked);
} else {
    console.log('\n=== chromium exempts content scripts, so there is nothing to be blocked by ===');
    await setWorker(false);
    await goto(CSP_URL);
    await wait(5000);
    const still = JSON.parse(await thread());
    ok('the in-page transport still works there on chromium', still.some(t => /lets you see it/.test(t)), still);
}

console.log(`\n${state.fail ? '✗' : '✓'} the two transports: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
