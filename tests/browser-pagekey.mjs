// Which address the thread is actually filed under.
//
// A thread is keyed to normalizeUrl(location.href), not to what is in the address bar, and the two
// disagree more often than it looks: anchors are dropped, tracking parameters are removed, query
// parameters are sorted. Somebody who followed a link to #section-3 is reading one part of an
// article and commenting on all of it, and nothing in the panel said so.
//
// The line only appears when the two differ. That is the whole design: on most pages they do not,
// and a line repeating the address bar is the clutter that teaches people to stop reading the
// panel. So the suite has to prove both halves — that it shows up when it matters, and that it
// stays away when it does not.
//
// The anchor case is checked after a click rather than on load, because clicking an anchor is the
// one navigation that changes nothing the panel would otherwise react to: same thread, no reload,
// and an early return in the navigation watcher that used to skip the repaint.
//
//   node tests/browser-pagekey.mjs
//   NC_BROWSER=firefox node tests/browser-pagekey.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9565);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8125);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8485);

const { normalizeUrl, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({
    port: SITE_PORT, heading: 'Thread key QA page',
    script: `document.body.insertAdjacentHTML('beforeend', '<a id="anchor" href="#section-3">to section 3</a><div id="section-3" style="height:1200px">s3</div>');`,
});
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const BASE = site.url;
const ME = newKey();

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'nckey2-',
    onClose: () => { site.close(); relay.close(); },
});

const readLine = () => js(`${ROOT}
  const el = s.getElementById('pagekey');
  return JSON.stringify({
    shown: !!el && el.offsetParent !== null,
    text: el ? el.textContent : null,
    title: el ? (el.getAttribute('title') || '') : null,
  });`);

console.log(`\nrelay: ${RELAY_URL}\npage:  ${normalizeUrl(BASE)}\n`);
await goto(BASE);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: RELAY_URL, nsec: toBech32('nsec', ME) }));
await wait(1500);

console.log('\n=== a plain address says nothing ===');
await goto(BASE);
await wait(3500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(800);
let r = JSON.parse(await readLine());
// The restraint half. A line here would repeat the address bar on every ordinary page.
ok('no line when the address bar and the thread key agree', r.shown === false, r);

console.log('\n=== a tracking parameter is dropped, so it says so ===');
await goto(BASE + '?utm_source=newsletter&utm_campaign=x');
await wait(3500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(800);
r = JSON.parse(await readLine());
ok('the line appears once the two differ', r.shown === true, r);
ok('it names the address the thread is filed under', (r.text || '').includes('127.0.0.1:' + SITE_PORT), r.text);
ok('the stripped parameters are not in it', !/utm_/.test(r.text || ''), r.text);
ok('the full address is in the tooltip', (r.title || '').startsWith(normalizeUrl(BASE)), r.title);
ok('the tooltip explains why they differ', /same thread/i.test(r.title || ''), r.title);

console.log('\n=== clicking an anchor is the case that used to be missed ===');
await goto(BASE);
await wait(3500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(600);
r = JSON.parse(await readLine());
ok('nothing shown before the anchor is clicked', r.shown === false, r);

// A same-page anchor changes no thread, so the navigation watcher returns early. That early return
// used to skip the repaint, and this is the exact case the line exists for.
await js(`document.getElementById('anchor').click(); return 1;`);
await wait(1200);
r = JSON.parse(await readLine());
ok('the line appears after clicking an anchor', r.shown === true, r);
ok('and it shows the address without the anchor', !/#section-3/.test(r.text || ''), r.text);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} thread key: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
