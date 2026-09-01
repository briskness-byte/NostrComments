// The whole point of the background transport: does a thread actually load on a site that forbids
// the page from reaching a relay?
//
// `browser-csp.mjs` pins the bug — on Firefox, a page with a strict connect-src stops every relay
// socket a content script opens, and the panel says so instead of pretending nobody has commented.
// It was written before there was a fix, so it only ever asserts the failure.
//
// This is the other half, and it is the assertion the rebuild exists for. Same page, same header,
// same relay; the only difference is which transport the content script uses. With the socket
// opened in the background — where the extension's own policy applies and the site's does not —
// the comment has to arrive.
//
// Both paths run in one process against one relay, so a pass here is a comparison rather than a
// claim: the in-page path must still be blocked, or the page is not testing what it says it is.
//
//   node tests/browser-worker-csp.mjs
//   NC_BROWSER=firefox node tests/browser-worker-csp.mjs
//
// Firefox is the engine that matters. Chromium exempts content-script requests from the page's
// policy, so there is nothing to get past there and the suite says so rather than passing quietly.
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import http from 'http';
import { extensionCode, reporter, startRelay, startBrowser, configureScript, ROOT, BROWSER } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9610);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8170);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8530);

const { normalizeUrl, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });

// The page allows itself and nothing else — the shape x.com uses, minus its hundred exceptions.
const site = http.createServer((_, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    res.end('<!doctype html><html><head><title>Worker CSP QA</title></head><body style="font:16px sans-serif;padding:40px"><h1>Worker CSP QA page</h1><p>Article body text.</p></body></html>');
});
await new Promise(r => site.listen(SITE_PORT, '127.0.0.1', r));
const SITE_URL = `http://127.0.0.1:${SITE_PORT}/`;
const PAGE = normalizeUrl(SITE_URL);

const COMMENT = 'A comment that exists whether or not the page lets you see it.';
relay.stored.push(await sign(newKey(), {
    kind: 1111, created_at: Math.floor(Date.now() / 1000) - 60,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: COMMENT,
}));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncwcsp-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(SITE_URL);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects even on a site with a strict policy', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: relay.url }));
await wait(1500);

// Read the panel the way a reader would: what is drawn, and what it says when nothing is.
const look = async () => JSON.parse(await js(`${ROOT}
  const e = s.querySelector('.nc-empty');
  return JSON.stringify({
    comments: s.getElementById('list').querySelectorAll('.c').length,
    empty: e ? e.textContent : '',
    body: s.getElementById('list').textContent });`) || '{}');

const setWorker = async on => js(`${ROOT}
  s.getElementById('m').style.display='grid';
  if (getComputedStyle(s.getElementById('settings')).display === 'none') s.getElementById('gear-btn').click();
  const t = s.getElementById('worker-toggle');
  if (!t) return 'no toggle';
  if (t.checked !== ${on ? 'true' : 'false'}) t.click();
  s.getElementById('settings-close')?.click();
  return t.checked;`);

// --- in the page: still blocked, which is what makes the other half mean anything ------------------
console.log('\n=== with the socket opened in the page ===');
ok('the setting exists', (await setWorker(false)) === false);
await goto(SITE_URL);
await wait(2500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(7000);
const off = await look();
console.log(`  comments drawn: ${off.comments}   empty: ${JSON.stringify(off.empty.slice(0, 60))}`);

if (BROWSER === 'firefox') {
    ok('the comment does not arrive', off.comments === 0, off);
    ok('and the panel blames the site rather than claiming silence',
       /does not allow NostrComments to reach/i.test(off.empty), off.empty);
} else {
    // Chromium exempts content-script requests, so there is nothing here to get past. Said out
    // loud rather than skipped, so a green run on Chromium is not mistaken for proof of the fix.
    ok('chromium was never blocked in the first place', off.comments >= 1, off);
}

// --- in the background: the site has no say ---------------------------------------------------------
console.log('\n=== with the socket opened in the background ===');
ok('the setting can be turned on', (await setWorker(true)) === true);
await goto(SITE_URL);
await wait(2500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(9000);
const on = await look();
console.log(`  comments drawn: ${on.comments}   empty: ${JSON.stringify(on.empty.slice(0, 60))}`);

ok('the comment arrives', on.comments >= 1, on);
ok('and it is the one the relay is holding', on.body.includes(COMMENT.slice(0, 40)), on.body.slice(0, 120));
ok('so the panel no longer says the site is in the way', !/does not allow NostrComments to reach/i.test(on.empty), on.empty);

// The comparison is the result. On Firefox the same page, header and relay produced nothing
// through one transport and the comment through the other.
if (BROWSER === 'firefox') {
    ok('the transport is what made the difference', off.comments === 0 && on.comments >= 1,
       { inPage: off.comments, background: on.comments });
}

console.log(`\n${state.fail === 0 ? '✓' : '✗'} worker vs site CSP: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
