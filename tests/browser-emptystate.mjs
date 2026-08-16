// What the panel says when it has nothing to show, and what it hands to third-party image hosts.
//
// "No comments yet – be the first!" used to be said whatever the reason. Reported from real use:
// twenty-one comments on a page, all from one key, that key muted — and the panel reported a page
// nobody had ever commented on. A search that matched nothing said the same. Only one of the three
// situations is an invitation to write something.
//
// The same report turned up a picture that appeared and vanished between reloads. That part was the
// onerror fallback working correctly against a flaky public gateway, but it exposed two things worth
// fixing: every image was fetched eagerly, which is how a gateway starts refusing, and none of them
// set a referrer policy — so the server hosting somebody's avatar was told the address of every page
// the reader opened where that person had commented.
//
//   node tests/browser-emptystate.mjs
//   NC_BROWSER=firefox node tests/browser-emptystate.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import http from 'http';
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9535);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8102);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8464);
const IMG_PORT = RELAY_PORT + 1;

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

// A picture that actually loads. The first version of this suite pointed at example.invalid,
// which never resolves — so onerror replaced every <img> with the link fallback before anything
// could be asserted about it. That proved the fallback works and nothing else.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const imgHost = http.createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); });
await new Promise(r => imgHost.listen(IMG_PORT, '127.0.0.1', r));
const IMG = `http://127.0.0.1:${IMG_PORT}`;

const relay = await startRelay({ port: RELAY_PORT });
const { stored } = relay;
const site = await startSite({ port: SITE_PORT, heading: 'Empty state QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);

// One noisy author, exactly like the page this came from: everything on the page is theirs.
const SPAMMER = newKey(), SPAMMER_PUB = _secp.pubKey(SPAMMER);
const ME = newKey();
for (let i = 0; i < 3; i++)
    stored.push(await sign(SPAMMER, {
        kind: 1111, created_at: now - 600 + i,
        tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
        content: `Buy my thing number ${i} ${IMG}/shot${i}.png`,
    }));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncempty-',
    onClose: () => { site.close(); relay.close(); imgHost.close(); },
});

await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);
await goto(site.url);
await wait(2500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(3000);

const emptyText = () => js(`${ROOT} const e = s.querySelector('.nc-empty'); return e ? e.textContent : '';`);

// Poll rather than sleep: the thread renders when the relay answers, and a fixed wait lands either
// side of that depending on how fast the socket came up. The first version of this suite asserted
// on the pictures before the comments existed and reported zero of them.
async function waitForThread(n = 3, tries = 40) {
    for (let i = 0; i < tries; i++) {
        const c = await js(`${ROOT} return s.getElementById('list').querySelectorAll('.c').length;`);
        if (c >= n) return c;
        await wait(500);
    }
    return 0;
}
ok('the thread loads', (await waitForThread()) >= 3);

console.log('=== images are fetched without handing over the page address ===');
const imgs = JSON.parse(await js(`${ROOT}
  return JSON.stringify([...s.querySelectorAll('.nc-img')].map(i => ({ ref: i.referrerPolicy, loading: i.loading })));`) || '[]');
ok('every inline image is present', imgs.length === 3, imgs.length);
ok('and none of them sends a referrer', imgs.length > 0 && imgs.every(i => i.ref === 'no-referrer'), imgs);
ok('and each loads lazily', imgs.length > 0 && imgs.every(i => i.loading === 'lazy'), imgs);

console.log('\n=== a search that matches nothing says so ===');
await js(`${ROOT}
  const b = s.getElementById('search');
  b.value = 'zzzznotpresent';
  b.dispatchEvent(new Event('input', {bubbles:true})); return 1;`);
await wait(1200);
const searched = await emptyText();
ok('it does not claim the page has no comments', !/be the first/i.test(searched || ''), searched);
ok('it says the search matched nothing', /matches what you searched/i.test(searched || ''), searched);

await js(`${ROOT}
  const b = s.getElementById('search');
  b.value = '';
  b.dispatchEvent(new Event('input', {bubbles:true})); return 1;`);
await wait(1200);
ok('clearing the box brings the thread back', (await js(`${ROOT} return s.getElementById('list').querySelectorAll('.c').length;`)) >= 3);

console.log('\n=== muting the only author does not mean the page is empty ===');
await js(`${ROOT}
  s.getElementById('gear-btn').click();
  const i = s.getElementById('muteword-input');
  i.value = 'Buy my thing';
  s.getElementById('muteword-add-btn').click();
  s.getElementById('settings-close').click(); return 1;`);
await wait(1500);

const muted = await emptyText();
ok('it does not invite you to be the first', !/be the first/i.test(muted || ''), muted);
ok('it says the comments are hidden rather than absent', /hidden/i.test(muted || ''), muted);
ok('and it says how many', /\b3\b/.test(muted || ''), muted);

// The message above sends the reader to Settings. Settings used to hide the muted-users list
// whenever it was empty, so somebody arriving to check who they had muted found no such section —
// indistinguishable from an extension that cannot mute anyone.
console.log('\n=== Settings shows the lists even when they are empty ===');
await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
await wait(1000);
const lists = JSON.parse(await js(`${ROOT}
  const vis = id => { const e = s.getElementById(id); return !!e && e.style.display !== 'none'; };
  return JSON.stringify({
    mutedVisible: vis('muted-section'),
    disabledVisible: vis('disabled-section'),
    mutedText: (s.getElementById('muted-list') || {}).textContent || '',
    disabledText: (s.getElementById('disabled-list') || {}).textContent || '',
  });`) || '{}');
ok('the muted-users section is on screen with nobody muted', lists.mutedVisible === true, lists);
ok('and says so in words', /nobody is muted/i.test(lists.mutedText || ''), lists.mutedText);
ok('the disabled-sites section is on screen with no site disabled', lists.disabledVisible === true, lists);
ok('and says so in words', /switched on everywhere/i.test(lists.disabledText || ''), lists.disabledText);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} empty state: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
