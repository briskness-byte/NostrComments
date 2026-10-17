// A page whose CSP forbids inline styles must not be able to read the stored private key.
//
// Found 17 Oct 2026 from a console log on a strict-CSP page: Firefox dropped every style="" in the
// panel's template, including the display:none that hid the private-key box. privkeyBoxOpen() read
// that style, so the box counted as open, and on load the stored key was written into its field —
// in an open shadow root, where the page's own script could read it. tests/browser-csp.mjs never
// caught it because its page allows 'unsafe-inline'. This page does not.
//
// The page here is the attacker: it sends the policy and then reads the shadow root, without any
// click. The key must not be there, the box must stay hidden, and revealing must still work for a
// real click.
//
//   node tests/browser-csp-style.mjs
//   NC_BROWSER=firefox node tests/browser-csp-style.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import http from 'http';
import { extensionCode, reporter, startRelay, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9599);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8159);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8519);

const { newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });

// No 'unsafe-inline' for styles: what any site may send. The one inline style on the page itself is
// a canary, to prove the browser really enforces the policy in this run.
const site = http.createServer((_, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self'; style-src 'self'; connect-src 'self' wss: ws:",
    });
    res.end('<!doctype html><html><head><title>Strict style CSP</title></head><body><h1 id="canary" style="color: rgb(255, 0, 0)">Strict style CSP page</h1><p>Article body text.</p></body></html>');
});
await new Promise(r => site.listen(SITE_PORT, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${SITE_PORT}/`;

const KEY = newKey();
const NSEC = toBech32('nsec', KEY);

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'nccspstyle-',
    onClose: () => { site.close(); relay.close(); },
});

// What a page script can find anywhere in the panel's shadow root.
const leaked = () => js(`
  const found = [];
  for (const host of document.documentElement.children) {
    const r = host.shadowRoot; if (!r) continue;
    for (const el of r.querySelectorAll('input, textarea')) if (/nsec1|[0-9a-f]{64}/i.test(el.value || '')) found.push(el.id || el.tagName);
    if (/nsec1[02-9ac-hj-np-z]{20,}/i.test(r.textContent || '')) found.push('text');
  }
  return JSON.stringify(found);`);
const box = () => js(`${ROOT} const b = s.getElementById('privkey-box'); return JSON.stringify({ display: getComputedStyle(b).display, value: s.getElementById('privkey-display').value });`);

console.log('=== setup: an unencrypted key stored here ===');
await goto(SITE);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }
await js(configureScript({ relayUrl: relay.url, nsec: NSEC }));
await wait(1500);
await goto(SITE);
await wait(4000);

const canary = await js(`return getComputedStyle(document.getElementById('canary')).color;`);
ok('the page really forbids inline styles (its own red heading is not red)', canary !== 'rgb(255, 0, 0)', canary);

console.log('\n=== the page looks for the key, with no click ===');
let found = JSON.parse(await leaked());
ok('the key is nowhere in the shadow root after load', found.length === 0, found);
let b = JSON.parse(await box());
ok('the key box is hidden', b.display === 'none', b);
ok('and its field is empty', b.value === '', b.value ? '(non-empty)' : '');

// The panel's own inline styles are back, so the layout is the designed one too.
const mono = await js(`${ROOT} return getComputedStyle(s.getElementById('privkey-display')).fontFamily;`);
ok('the panel\'s inline styles are applied despite the policy', /monospace/i.test(mono || ''), mono);

console.log('\n=== Settings open, still no click on "Show private key" ===');
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn')?.click(); return 1;`);
await wait(1500);
found = JSON.parse(await leaked());
ok('opening Settings does not put the key in the DOM', found.length === 0, found);
b = JSON.parse(await box());
ok('the key box is still hidden', b.display === 'none', b);

console.log('\n=== a real click still reveals and hides it ===');
await nclick("s.getElementById('privkey-reveal')");
await wait(800);
b = JSON.parse(await box());
ok('one click shows the key', b.display !== 'none' && b.value.startsWith('nsec1'), { display: b.display, shown: b.value.slice(0, 5) });
await nclick("s.getElementById('privkey-reveal')");
await wait(800);
b = JSON.parse(await box());
ok('a second click hides it and empties the field', b.display === 'none' && b.value === '', b.display);
found = JSON.parse(await leaked());
ok('and nothing is left behind', found.length === 0, found);

console.log(`\n${state.fail ? '✗' : '✓'} strict style CSP: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
