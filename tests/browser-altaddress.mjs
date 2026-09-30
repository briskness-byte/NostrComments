// A page can name its own canonical address with <link rel="canonical">, and another Nostr client
// keys a comment's page tag to whatever address the page itself used — which is not always our
// normalised one (query order, a bare-domain trailing slash, tracking parameters already stripped
// on their side). Reading that address too, alongside ours, is how the two threads meet.
//
// Three things have to be true at once for this to be safe to ship:
//   - the control case (no canonical link) behaves exactly as before;
//   - a real comment filed under the canonical address is merged into the same panel;
//   - what the reader posts through the panel still goes out tagged to our own address, never the
//     canonical one — a wrong or hostile <link> can only add noise to what is read, and must never
//     change where a word the reader writes gets filed.
//
//   node tests/browser-altaddress.mjs
//   NC_BROWSER=firefox node tests/browser-altaddress.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import http from 'http';
import { extensionCode, reporter, startRelay, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9731);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8731);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8732);

const { _secp, normalizeUrl, toBech32, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const ME = newKey(), OTHER = newKey();
const now = Math.floor(Date.now() / 1000);

// Three pages at the same site, one server: no canonical link (control), a canonical link pointing
// elsewhere (the case this suite is about), and a canonical link pointing at itself (must not
// double the page's own address in the filter — a plain no-op, not a bug).
const PAGES = {
    plain: '',
    canon: `<link rel="canonical" href="https://elsewhere.example/the-real-article">`,
    selfcanon: '', // filled in once its own normalised URL is known
    jscanon: `<link rel="canonical" href="javascript:alert(1)">`,
};
const server = http.createServer((req, res) => {
    const path = req.url.replace(/^\//, '') || 'plain';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><title>QA</title>${PAGES[path] || ''}</head><body style="font:16px sans-serif;padding:40px"><h1>${path}</h1></body></html>`);
});
await new Promise(r => server.listen(SITE_PORT, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${SITE_PORT}/`;
PAGES.selfcanon = `<link rel="canonical" href="${SITE}selfcanon">`;

const CANONICAL_ADDR = 'https://elsewhere.example/the-real-article';
const PLAIN_ADDR = normalizeUrl(SITE + 'plain');
const CANON_PAGE_ADDR = normalizeUrl(SITE + 'canon');

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncaltaddr-', onClose: () => { server.close(); relay.close(); },
});
const thread = () => js(`${ROOT} return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')].map(c => c.textContent.replace(/\\s+/g,' ').slice(0,80)));`);

await goto(SITE + 'plain'); await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(2000);

console.log('\n=== control: no canonical link, nothing under the canonical address shows ===');
const controlOwn = await sign(OTHER, { kind: 1111, created_at: now - 60, tags: [['I', PLAIN_ADDR], ['K', 'web'], ['i', PLAIN_ADDR], ['k', 'web']], content: 'a plain-address comment' });
const controlElsewhere = await sign(OTHER, { kind: 1111, created_at: now - 60, tags: [['I', CANONICAL_ADDR], ['K', 'web'], ['i', CANONICAL_ADDR], ['k', 'web']], content: 'filed under the canonical address, unrelated to this page' });
relay.stored.push(controlOwn, controlElsewhere);
await goto(SITE + 'plain'); await wait(6000);
const t0 = await thread();
ok('the page\'s own comment is shown', /plain-address comment/.test(t0 || ''), t0);
ok('nothing filed only under the canonical address leaks onto an unrelated page', !/unrelated to this page/.test(t0 || ''), t0);

console.log('\n=== a page with a canonical link merges that address\'s thread in ===');
const viaCanonical = await sign(OTHER, { kind: 1111, created_at: now - 50, tags: [['I', CANONICAL_ADDR], ['K', 'web'], ['i', CANONICAL_ADDR], ['k', 'web']], content: 'another client\'s comment, filed under the canonical address' });
relay.stored.push(viaCanonical);
await goto(SITE + 'canon'); await wait(6000);
const t1 = await thread();
ok('the other client\'s comment (filed under the canonical address) is shown here', /another client.s comment/.test(t1 || ''), t1);

console.log('\n=== a comment filed under this page\'s own (non-canonical) address still shows too ===');
const viaOwn = await sign(OTHER, { kind: 1111, created_at: now - 40, tags: [['I', CANON_PAGE_ADDR], ['K', 'web'], ['i', CANON_PAGE_ADDR], ['k', 'web']], content: 'a comment filed under this page\'s own address' });
relay.stored.push(viaOwn);
await goto(SITE + 'canon'); await wait(6000);
const t2 = await thread();
ok('the canonical-address comment is still there', /filed under the canonical address/.test(t2 || ''), t2);
ok('and the page\'s own-address comment is there too — merged, not replaced', /this page.s own address/.test(t2 || ''), t2);

console.log('\n=== a non-http(s) canonical link is ignored, same restriction as any other link this reads ===');
const jsPageAddr = normalizeUrl(SITE + 'jscanon');
const onJsPage = await sign(OTHER, { kind: 1111, created_at: now - 35, tags: [['I', jsPageAddr], ['K', 'web'], ['i', jsPageAddr], ['k', 'web']], content: 'a js-canon-page comment' });
relay.stored.push(onJsPage);
await goto(SITE + 'jscanon'); await wait(6000);
const tjs = await thread();
ok('the page still loads and shows its own comment', /js-canon-page comment/.test(tjs || ''), tjs);

console.log('\n=== a page whose canonical link points at itself is a no-op, not a duplicate filter value ===');
await goto(SITE + 'selfcanon'); await wait(6000);
const selfOk = await js(`${ROOT} return s.getElementById('m') ? 'ok' : 'missing';`);
ok('a self-referencing canonical link does not break the page', selfOk === 'ok', selfOk);

console.log('\n=== what the reader writes still files under this page\'s own address, never the canonical one ===');
await goto(SITE + 'canon'); await wait(6000);
await nclick("s.getElementById('nc-btn')"); await wait(1200);
await js(`${ROOT} s.getElementById('input').value = 'my own comment, written on the canon page'; s.getElementById('input').dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
await nclick("s.getElementById('send')");
await wait(4000);
const mine = relay.published.find(e => e.kind === 1111 && e.content === 'my own comment, written on the canon page');
ok('the comment was published', !!mine, relay.published.map(e => e.content));
const iTag = mine && mine.tags.find(t => t[0] === 'I');
ok('it is tagged with this page\'s own address', iTag && iTag[1] === CANON_PAGE_ADDR, iTag);
ok('never with the canonical address the page named', iTag && iTag[1] !== CANONICAL_ADDR, iTag);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} alternate address: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
