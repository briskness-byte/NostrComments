// "About this site" end to end (13 Nov 2026).
//
// A warning left on a shop's homepage used to be invisible from its product pages and its checkout:
// relays match a page address exactly. Now a page also fetches its site's homepage thread and offers
// it, apart from its own thread and read-only.
//
// What must hold: on a page with no comments of its own the button shows the site's count in grey;
// the panel offers "N comments about <site>" and shows them on request, without a comment its author
// deleted; those comments never enter the page's own thread; a page with its own comments counts
// those in red and still offers the site's; and the homepage itself offers nothing extra.
//
//   node tests/browser-siteabout.mjs
//   NC_BROWSER=firefox node tests/browser-siteabout.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import fs from 'fs';
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9704);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8708);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8709);

const { normalizeUrl, sign, newKey } = extensionCode();
const { ok, state } = reporter();
const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'A shop' });
const HOME = normalizeUrl(site.url);
const CHECKOUT = site.url + 'checkout';
const PRODUCT = site.url + 'product/42';
const now = Math.floor(Date.now() / 1000);
const tagsFor = u => [['I', normalizeUrl(u)], ['K', 'web'], ['i', normalizeUrl(u)], ['k', 'web']];

const A = newKey(), B = newKey(), C = newKey(), D = newKey();
relay.stored.push(await sign(A, { kind: 1111, created_at: now - 900, tags: tagsFor(HOME), content: 'Ordered twice, never delivered. Avoid.' }));
const gone = await sign(B, { kind: 1111, created_at: now - 800, tags: tagsFor(HOME), content: 'A comment its author took back.' });
relay.stored.push(gone);
relay.stored.push(await sign(B, { kind: 5, created_at: now - 700, tags: [['e', gone.id], ['r', HOME]], content: '' }));
relay.stored.push(await sign(C, { kind: 1, created_at: now - 600, tags: [['r', HOME]], content: 'A note about this shop from another client.' }));
relay.stored.push(await sign(D, { kind: 1111, created_at: now - 500, tags: tagsFor(PRODUCT), content: 'The product page has its own comment.' }));

const { js, wait, goto, finish, nclick, wd, sid } = await startBrowser({ cdPort: CD_PORT, prefix: 'ncsa-', onClose: () => { site.close(); relay.close(); } });
await goto(site.url);
await wait(2500);
await js(configureScript({ relayUrl: relay.url }));
await wait(1500);

const badge = () => js(`${ROOT} const b = s.getElementById('nc-badge'); return { shown: getComputedStyle(b).display, text: b.textContent, bg: b.style.background, title: s.getElementById('nc-btn').title };`);
const about = () => js(`${ROOT} const box = s.getElementById('site-about'); return { shown: getComputedStyle(box).display, toggle: s.getElementById('site-about-toggle').textContent, list: s.getElementById('site-about-list').textContent };`);
const thread = () => js(`${ROOT} return s.getElementById('list').textContent;`);
const open = async () => { await js(`${ROOT} s.getElementById('m').style.display='none'; return 1;`); await wait(300); await nclick("s.getElementById('nc-btn')"); await wait(1500); };

console.log('\n=== a checkout with no comments of its own ===');
await goto(CHECKOUT);
await wait(5000);
let b = await badge();
ok('the button shows the site\'s comments', b.shown === 'block' && b.text === '2', b);
ok('in grey, not the red of a page\'s own', /107, 114, 128|#6b7280/.test(b.bg), b.bg);
ok('and says so when hovered', /about this site, none on this page/.test(b.title), b.title);
await open();
let a = await about();
ok('the panel offers the comments about the site', a.shown === 'block' && /^💬 2 comments about /.test(a.toggle), a);
ok('they are not in the page\'s own thread', !(await thread()).includes('never delivered'), await thread());
await nclick("s.getElementById('site-about-toggle')");
await wait(600);
a = await about();
ok('one tap shows them', a.list.includes('Ordered twice, never delivered') && a.list.includes('A note about this shop'), a.list);
ok('without the one its author deleted', !a.list.includes('took back'), a.list);
// NC_SHOT=file.png saves the panel at this point, for a person to look at.
if (process.env.NC_SHOT) { const png = (await wd('GET', `/session/${sid}/screenshot`)).value; if (png) fs.writeFileSync(process.env.NC_SHOT, Buffer.from(png, 'base64')); }
ok('with the way to reply where they live', /Open the thread on .*homepage to reply/.test(a.list), a.list);

console.log('\n=== a product page with a comment of its own ===');
await goto(PRODUCT);
await wait(5000);
b = await badge();
ok('the button counts the page\'s own comment, in red', b.text === '1' && /229, 57, 53|#e53935/.test(b.bg), b);
await open();
a = await about();
ok('and the panel still offers the site\'s two', a.shown === 'block' && /^💬 2 comments about /.test(a.toggle), a);
ok('while the thread holds the page\'s own', (await thread()).includes('The product page has its own comment.'));

console.log('\n=== the homepage itself ===');
await goto(site.url);
await wait(5000);
await open();
a = await about();
ok('offers nothing extra: its thread already is the site\'s', a.shown === 'none', a);
ok('and shows those comments as its own thread', (await thread()).includes('never delivered'));

await finish(state.fail ? 1 : 0);
