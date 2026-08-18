// The way back to your own conversations.
//
// A comment is filed under one page address, so once you have written it and moved on there is no
// route back to it — you would have to remember where you were. That is the same gap the reply
// banner had before it named a page.
//
// Relays cannot answer "everything under example.com": NIP-01 tag filters match exactly, so a site
// is not a thing you can ask about. They can answer "everything by this key", and every comment
// carries its page in an I tag, so the list is built from the other direction.
//
// It lives in Settings and is fetched when Settings opens. Two reasons, and the suite checks both:
// a list you look at rarely must not be fetched by every page you read, and it has to be somewhere
// you can go and look rather than somewhere you have to catch.
//
//   node tests/browser-mythreads.mjs
//   NC_BROWSER=firefox node tests/browser-mythreads.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9590);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8150);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8510);

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

// Every REQ the relay is asked, so the suite can prove nothing is fetched until Settings is opened.
const asked = [];
const relay = await startRelay({ port: RELAY_PORT });
const { stored } = relay;
const site = await startSite({ port: SITE_PORT, heading: 'My threads QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);

const ME = newKey(), MY_PUB = _secp.pubKey(ME);
const THEM = newKey();

const ELSEWHERE = ['https://example.com/one', 'https://example.com/two', 'https://other.example/three'];
// Two comments on the same page: it must appear once, not twice.
for (const [i, url] of [...ELSEWHERE, ELSEWHERE[0]].entries())
    stored.push(await sign(ME, {
        kind: 1111, created_at: now - 900 + i * 10,
        tags: [['I', url], ['K', 'web'], ['i', url], ['k', 'web']],
        content: `Something I wrote on ${url}`,
    }));
// Somebody else's comment must not turn up in your list.
stored.push(await sign(THEM, {
    kind: 1111, created_at: now - 500,
    tags: [['I', 'https://example.com/theirs'], ['K', 'web'], ['i', 'https://example.com/theirs'], ['k', 'web']],
    content: 'Not yours.',
}));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncmt-',
    onClose: () => { site.close(); relay.close(); },
});

const readList = () => js(`${ROOT}
  const b = s.getElementById('mythreads');
  return JSON.stringify({
    text: b ? b.textContent : null,
    links: b ? [...b.querySelectorAll('a')].map(a => a.getAttribute('href')) : [],
  });`);

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

console.log('\n=== nothing is fetched by simply reading a page ===');
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(1500);
let r = JSON.parse(await readList());
// The block exists in the panel from the start; what must not happen is the query.
ok('the list is empty until Settings is opened', r.links.length === 0 && !/example\.com/.test(r.text || ''), r);

console.log('\n=== opening Settings fetches it ===');
await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
for (let i = 0; i < 25; i++) {
    r = JSON.parse(await readList());
    if (r.links.length) break;
    await wait(600);
}
ok('your pages are listed', r.links.length === 3, r);
ok('the page you commented on twice appears once', new Set(r.links).size === r.links.length, r.links);
ok('somebody else\'s page is not in it', !r.links.some(u => /theirs/.test(u)), r.links);
for (const u of ELSEWHERE) ok(`it lists ${u.replace(/^https?:\/\//, '')}`, r.links.includes(u), r.links);

console.log('\n=== they are links you can follow ===');
const shape = JSON.parse(await js(`${ROOT}
  const a = s.getElementById('mythreads').querySelector('a');
  return JSON.stringify({ target: a.getAttribute('target'), rel: a.getAttribute('rel'), text: a.textContent });`));
ok('each opens in a new tab', shape.target === '_blank', shape);
ok('and carries noopener', /noopener/.test(shape.rel || ''), shape);
ok('the scheme is dropped for readability', !/^https?:/.test(shape.text || ''), shape.text);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} my threads: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
