// A page can name the Nostr entity it natively is with <link rel="alternate" href="nostr:...">,
// the discovery convention proposed in a NIP draft sent to this project in September 2026. NIP-22
// root-scopes a comment on an addressable event (an naddr, a NIP-23 article say) with an A tag, and
// on a regular one (an nevent) with E — never with the I tag a URL-scoped comment carries. Reading
// both, merged into the same panel, is how a page's native Nostr comments and its URL-scoped ones
// meet; nothing here changes what the reader's own comment gets tagged with when they post.
//
// What has to be true at once, each proven against the real NIP-22 tag shapes (not a shortcut):
//   - the control case (no linked entity) is unaffected;
//   - a comment root-scoped to the linked naddr is merged in, carrying the "linked" badge;
//   - a comment root-scoped to a linked nevent is merged in the same way;
//   - the page's own URL-scoped comments are still there too — merged, not replaced;
//   - a page naming an unrelated, real naddr can only add that thread's content, never suppress
//     the page's own;
//   - what the reader posts is still tagged I/K=web, this page's own address — never A or E.
//
//   node tests/browser-niplink.mjs
//   NC_BROWSER=firefox node tests/browser-niplink.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import http from 'http';
import { extensionCode, reporter, startRelay, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9733);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8733);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8734);

const { _secp, normalizeUrl, toBech32, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const ME = newKey(), OTHER = newKey(), ARTICLE_AUTHOR = newKey();
const ARTICLE_PUB = _secp.pubKey(ARTICLE_AUTHOR);
const now = Math.floor(Date.now() / 1000);

// The real naddr from Emre's NIP draft, and a matching nevent — both decode to entities this
// suite's OTHER key does not own, same as a page in the wild names an article it did not write.
const REAL_NADDR = 'naddr1qvzqqqrcvypzq3hnc7an8npsryzfkaku38dmjm35cfrmmkngk6kcvvngy7fllzs6qqsku6ts94kxjmnt94mk2c3dw3hj6mn0wd68ytt9de6xjare94kxjmnt7pzrp0';
const REAL_NADDR_ADDR = '30817:46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a:nip-link-web-to-nostr-entity-link';

// This suite's own article, addressed the way the reader's browser will actually decode it.
const D_TAG = 'my-article';
const ARTICLE_ADDR = `30023:${ARTICLE_PUB}:${D_TAG}`;
const article = await sign(ARTICLE_AUTHOR, { kind: 30023, created_at: now - 1000, tags: [['d', D_TAG], ['title', 'My Article']], content: 'Article body.' });
relay.stored.push(article);

// toBech32 in the shipped code only handles a fixed 32-byte payload (nsec/npub/note); naddr needs
// a TLV-encoded one of no fixed length, so this suite builds it directly with the same NIP-19 shape
// decodeLinkedEntity (tested in tests/niplink.test.mjs) reads back.
function bech32EncodeTLV(hrp, tlvBytes) {
    const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    const pm = v => { let c = 1; for (const d of v) { const t = c >> 25; c = (c & 0x1ffffff) << 5 ^ d; for (let i = 0; i < 5; i++) if ((t >> i) & 1) c ^= GEN[i]; } return c; };
    const ex = h => [...h].map(c => c.charCodeAt(0) >> 5).concat(0, ...[...h].map(c => c.charCodeAt(0) & 31));
    const w = []; let acc = 0, bits = 0;
    for (const b of tlvBytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; w.push((acc >> bits) & 31); } }
    if (bits) w.push((acc << (5 - bits)) & 31);
    const chk = pm([...ex(hrp), ...w, 0, 0, 0, 0, 0, 0]) ^ 1;
    return hrp + '1' + [...w, ...Array.from({ length: 6 }, (_, i) => (chk >> (5 * (5 - i))) & 31)].map(d => CS[d]).join('');
}
function tlv(type, bytes) { return [type, bytes.length, ...bytes]; }
const hexToBytes = h => Array.from(Buffer.from(h, 'hex'));
function naddrFor(kind, pubkeyHex, d) {
    return bech32EncodeTLV('naddr', [
        ...tlv(0, Array.from(Buffer.from(d, 'utf8'))),
        ...tlv(2, hexToBytes(pubkeyHex)),
        ...tlv(3, [(kind >>> 24) & 0xff, (kind >>> 16) & 0xff, (kind >>> 8) & 0xff, kind & 0xff]),
    ]);
}
function neventFor(idHex) {
    return bech32EncodeTLV('nevent', tlv(0, hexToBytes(idHex)));
}

const OWN_NADDR = naddrFor(30023, ARTICLE_PUB, D_TAG);

const NOTE_AUTHOR = newKey(), NOTE_PUB = _secp.pubKey(NOTE_AUTHOR);
const note = await sign(NOTE_AUTHOR, { kind: 1, created_at: now - 900, tags: [], content: 'A plain note, also linkable.' });
relay.stored.push(note);
const OWN_NEVENT = neventFor(note.id);

const PAGES = {
    plain: '',
    naddr: `<link rel="alternate" href="nostr:${OWN_NADDR}">`,
    nevent: `<link rel="alternate" href="nostr:${OWN_NEVENT}">`,
    hostile: `<link rel="alternate" href="nostr:${REAL_NADDR}">`,
};
const server = http.createServer((req, res) => {
    const path = req.url.replace(/^\//, '') || 'plain';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><title>QA</title>${PAGES[path] || ''}</head><body style="font:16px sans-serif;padding:40px"><h1>${path}</h1></body></html>`);
});
await new Promise(r => server.listen(SITE_PORT, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${SITE_PORT}/`;

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncniplink-', onClose: () => { server.close(); relay.close(); },
});
const thread = () => js(`${ROOT} return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')].map(c => c.textContent.replace(/\\s+/g,' ').slice(0,90)));`);
const badges = () => js(`${ROOT} return [...s.getElementById('list').querySelectorAll('.nc-notetag')].map(b => b.textContent);`);

await goto(SITE + 'plain'); await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(2000);

console.log('\n=== control: no linked entity, nothing scoped to a real naddr leaks in ===');
const noise = await sign(OTHER, { kind: 1111, created_at: now - 60, tags: [['A', REAL_NADDR_ADDR], ['K', '30817'], ['P', '46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a'], ['a', REAL_NADDR_ADDR], ['k', '30817']], content: 'a comment about an unrelated real article' });
relay.stored.push(noise);
await goto(SITE + 'plain'); await wait(6000);
const t0 = await thread();
ok('nothing scoped to an unrelated entity shows on a plain page', !/unrelated real article/.test(t0 || ''), t0);

console.log('\n=== a page linking its own naddr merges the article\'s comment thread in ===');
const onArticle = await sign(OTHER, { kind: 1111, created_at: now - 50, tags: [['A', ARTICLE_ADDR], ['K', '30023'], ['P', ARTICLE_PUB], ['a', ARTICLE_ADDR], ['k', '30023']], content: 'a comment written natively about the article' });
relay.stored.push(onArticle);
await goto(SITE + 'naddr'); await wait(6000);
const t1 = await thread();
ok('the article\'s native comment is shown', /written natively about the article/.test(t1 || ''), t1);
const b1 = await badges();
ok('it carries the "linked" badge', b1.includes('linked'), b1);

console.log('\n=== and this page\'s own (URL-scoped) comments still show too — merged, not replaced ===');
const OWN_PAGE_ADDR_URL = normalizeUrl(SITE + 'naddr');
const viaUrl = await sign(OTHER, { kind: 1111, created_at: now - 40, tags: [['I', OWN_PAGE_ADDR_URL], ['K', 'web'], ['i', OWN_PAGE_ADDR_URL], ['k', 'web']], content: 'an ordinary comment tagged to this page\'s own url' });
relay.stored.push(viaUrl);
await goto(SITE + 'naddr'); await wait(6000);
const t2 = await thread();
ok('the article comment is still there', /written natively about the article/.test(t2 || ''), t2);
ok('the URL-scoped comment is there too', /this page.s own url/.test(t2 || ''), t2);
const b2 = await badges();
ok('only the article comment carries the badge, not the URL-scoped one', b2.filter(x => x === 'linked').length === 1, b2);

console.log('\n=== a linked nevent (a plain note, not an addressable event) works the same way ===');
const onNote = await sign(OTHER, { kind: 1111, created_at: now - 30, tags: [['E', note.id, '', NOTE_PUB], ['K', '1'], ['P', NOTE_PUB], ['e', note.id, '', NOTE_PUB], ['k', '1'], ['p', NOTE_PUB]], content: 'replying to the linked note natively' });
relay.stored.push(onNote);
await goto(SITE + 'nevent'); await wait(6000);
const t3 = await thread();
ok('a comment scoped to the linked nevent by its E tag is shown', /replying to the linked note/.test(t3 || ''), t3);

console.log('\n=== a page naming a real, unrelated naddr only adds noise — never suppresses this page\'s own thread ===');
const ownOnHostile = await sign(OTHER, { kind: 1111, created_at: now - 20, tags: (() => { const u = normalizeUrl(SITE + 'hostile'); return [['I', u], ['K', 'web'], ['i', u], ['k', 'web']]; })(), content: 'this page\'s own comment, even with a hostile link tag present' });
relay.stored.push(ownOnHostile);
await goto(SITE + 'hostile'); await wait(6000);
const t4 = await thread();
ok('the unrelated real thread is merged in (a nuisance, not a secret)', /unrelated real article/.test(t4 || ''), t4);
ok('this page\'s own comment is still shown — the hostile tag cannot suppress it', /even with a hostile link tag present/.test(t4 || ''), t4);

console.log('\n=== what the reader writes is still tagged to this page\'s own address, never A or E ===');
await goto(SITE + 'naddr'); await wait(6000);
await nclick("s.getElementById('nc-btn')"); await wait(1200);
await js(`${ROOT} s.getElementById('input').value = 'my own comment, written on the naddr-linked page'; s.getElementById('input').dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
await nclick("s.getElementById('send')");
await wait(4000);
const mine = relay.published.find(e => e.kind === 1111 && e.content === 'my own comment, written on the naddr-linked page');
ok('the comment was published', !!mine, relay.published.map(e => e.content));
const tagNames = mine ? mine.tags.map(t => t[0]) : [];
ok('it carries an I tag (url-scoped)', tagNames.includes('I'), tagNames);
ok('it carries no A tag', !tagNames.includes('A'), tagNames);
ok('it carries no E tag', !tagNames.includes('E'), tagNames);
const iTag = mine && mine.tags.find(t => t[0] === 'I');
ok('the I tag is this page\'s own address', iTag && iTag[1] === normalizeUrl(SITE + 'naddr'), iTag);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} NIP-LINK: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
