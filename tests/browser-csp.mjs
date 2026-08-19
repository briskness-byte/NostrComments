// A site whose Content-Security-Policy forbids the relay connections.
//
// x.com names every host its own code may reach in connect-src and nothing else, so every relay
// socket is refused before it opens. Chrome exempts a content script's requests from the page's
// policy; Firefox does not, for WebSockets. So on Firefox the panel emptied itself on any site with
// a strict connect-src, all six relays sat at "not contacted yet", and the reader was told
// "No comments yet – be the first!" — which is the one thing that is certainly not true.
//
// Reported from real use, and invisible from the panel: the console said it plainly and nothing
// else did.
//
// The two engines are deliberately asserted differently, because they genuinely differ. On Firefox
// the relay must be reported as blocked by the site. On Chromium the connection must still work
// despite the same header — which pins the exemption this extension relies on there, and would
// catch it going away.
//
//   node tests/browser-csp.mjs
//   NC_BROWSER=firefox node tests/browser-csp.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import http from 'http';
import { extensionCode, reporter, startRelay, startBrowser, configureScript, ROOT, BROWSER } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9537);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8105);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8468);

const { normalizeUrl, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });

// The page allows itself and nothing else — the shape x.com uses, minus its hundred exceptions.
const site = http.createServer((_, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    res.end('<!doctype html><html><head><title>CSP QA</title></head><body style="font:16px sans-serif;padding:40px"><h1>CSP QA page</h1><p>Article body text.</p></body></html>');
});
await new Promise(r => site.listen(SITE_PORT, '127.0.0.1', r));
const SITE_URL = `http://127.0.0.1:${SITE_PORT}/`;
const PAGE = normalizeUrl(SITE_URL);

relay.stored.push(await sign(newKey(), {
    kind: 1111, created_at: Math.floor(Date.now() / 1000) - 60,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'A comment that exists whether or not the page lets you see it.',
}));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'nccsp-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(SITE_URL);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects even on a site with a strict policy', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: relay.url }));
await wait(1500);
await goto(SITE_URL);
await wait(2500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(6000);

const view = JSON.parse(await js(`${ROOT}
  s.getElementById('gear-btn').click();
  const states = [...s.querySelectorAll('.relay-state')].map(e => e.textContent);
  s.getElementById('settings-close').click();
  const e = s.querySelector('.nc-empty');
  return JSON.stringify({ states, empty: e ? e.textContent : '', comments: s.getElementById('list').querySelectorAll('.c').length });`) || '{}');

console.log(`\nbrowser: ${BROWSER}\nrelay states: ${JSON.stringify(view.states)}\nempty text: ${JSON.stringify(view.empty)}\ncomments drawn: ${view.comments}`);

if (BROWSER === 'firefox') {
    // Firefox applies the page's connect-src to a content script's WebSocket.
    ok('the relay is reported as blocked by the site', (view.states || []).some(t => /blocked by this site/i.test(t)), view.states);
    ok('and the thread does not claim nobody has commented', !/be the first/i.test(view.empty || ''), view.empty);
    ok('it says the site is what is in the way', /does not allow NostrComments to reach/i.test(view.empty || ''), view.empty);
} else {
    // Chromium exempts content-script requests from the page policy, so the same header must not
    // stop anything. If this ever fails, the extension has lost its only way onto strict sites.
    ok('the connection is not blocked on this engine', !(view.states || []).some(t => /blocked by this site/i.test(t)), view.states);
    ok('and the comment loads despite the header', view.comments >= 1, view);
}

console.log(`\n${state.fail === 0 ? '✓' : '✗'} site CSP: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
