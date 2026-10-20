// What the page can learn about the reader, and when. Three findings from a private review
// (21 Oct 2026), each a way the panel kept saying something after it should have stopped:
//
//   1. With the panel closed, the reader's own comment carried an "own" mark and a Delete button,
//      and the name field held their profile name. The thread lives in an open shadow root, so the
//      page could read who the reader is without the panel ever being opened.
//   2. "Disable on this site" took the panel away but left the subscription and the navigation
//      watcher running, so on a single-page site every new address still went to the relays.
//   3. A slow answer for "Your threads" arriving after Settings was closed painted the list back:
//      other pages the reader commented on, in the DOM of this one.
//
// (The fourth finding, the verified-name label, is pinned statically in speaksfor.test.mjs.)
//
//   node tests/browser-privacygates.mjs
//   NC_BROWSER=firefox node tests/browser-privacygates.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, seedStorage, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9612);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8172);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8537);

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

// Slow on purpose: every answer comes 2.5 s after it was asked for, which is what gives the third
// case a window to close Settings in.
const relay = await startRelay({ port: RELAY_PORT, replyDelay: 2500 });
const site = await startSite({ port: SITE_PORT, heading: 'Privacy gates QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);

const ME = newKey(), MY_PUB = _secp.pubKey(ME);
const NAME = 'Gatekeeper Testname';
relay.stored.push(await sign(ME, { kind: 0, created_at: now - 1000, tags: [], content: JSON.stringify({ name: NAME }) }));
relay.stored.push(await sign(ME, {
    kind: 1111, created_at: now - 600,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'A comment the reader wrote here earlier.',
}));
relay.stored.push(await sign(ME, {
    kind: 1111, created_at: now - 500,
    tags: [['I', 'https://elsewhere.example/private'], ['K', 'web'], ['i', 'https://elsewhere.example/private'], ['k', 'web']],
    content: 'Something written on another site.',
}));

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncpg-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);
await js(seedStorage({ nostrcomments_pwoffered: true, nostrcomments_backupasked: true }));
await wait(500);
await goto(site.url);
await wait(7000);   // settle, connect, and two slow answers: the thread and the profile

// Read the way the page itself can: straight out of the open shadow root, no click.
const look = () => js(`${ROOT} return JSON.stringify({
  cards: s.querySelectorAll('.c').length,
  own: s.querySelectorAll('.c.own').length,
  del: s.querySelectorAll('.del-btn').length,
  share: s.querySelectorAll('.nc-tofeed').length,
  name: (s.getElementById('setname-input') || {}).value || '',
  card: (s.getElementById('identity-name') || {}).textContent || '',
  settings: (s.getElementById('settings') || {}).innerHTML?.includes(${JSON.stringify(NAME)}) || false });`);

console.log('\n=== with the panel closed, the page cannot tell which comment is the reader\'s ===');
let v = JSON.parse(await look());
ok('the comment is in the thread', v.cards >= 1, v);
ok('it is not marked as the reader\'s own', v.own === 0, v);
ok('and it has no Delete or Share button', v.del === 0 && v.share === 0, v);
ok('the name field does not hold the reader\'s name', v.name === '', v);
// The name does appear on the comment itself: that is public, and without the own mark it says
// nothing about who is reading. What must not be there is the reader's identity card or Settings.
ok('nor does the identity card or Settings hold it', v.card === '' && v.settings === false, v);

console.log('\n=== opened by the reader, it is theirs again ===');
await nclick("s.getElementById('nc-btn')");
await wait(1500);
v = JSON.parse(await look());
ok('the comment is marked as their own', v.own === 1, v);
ok('with Delete', v.del === 1, v);

console.log('\n=== and closing takes it back out ===');
await nclick("s.getElementById('c')");
await wait(800);
v = JSON.parse(await look());
ok('the own mark is gone', v.own === 0, v);
ok('so is Delete', v.del === 0 && v.share === 0, v);
ok('and the name field is empty', v.name === '', v);

console.log('\n=== a late answer does not paint "Your threads" back ===');
await nclick("s.getElementById('nc-btn')");
await wait(800);
await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);   // the list is asked for now
await wait(600);
await nclick("s.getElementById('settings-close')");                    // and Settings closed before it arrives
await wait(4500);
const links = await js(`${ROOT} return [...s.querySelectorAll('#mythreads a')].map(a => a.href);`);
ok('the answer arrived after Settings was closed and drew nothing', links.length === 0, links);
const leaked = await js(`${ROOT} return s.innerHTML.includes('elsewhere.example');`);
ok('the other site is nowhere in the panel', leaked === false, leaked);
await nclick("s.getElementById('c')");
await wait(500);

console.log('\n=== "Disable on this site" stops the network, not only the panel ===');
await nclick("s.getElementById('nc-btn')");
await wait(800);
await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
await wait(800);
await nclick("s.getElementById('site-disable-btn')");
await wait(1500);
const gone = await js(`return ![...document.documentElement.children].some(el => el.shadowRoot && el.shadowRoot.getElementById('nc-btn'));`);
ok('the panel and button are gone', gone === true, gone);
// A single-page site moving on: the address changes without a load, which is what the watcher polls for.
await js(`history.pushState({}, '', '/a-later-article'); return 1;`);
await wait(3500);
const asked = [...relay.conns].some(c => [...c.subs.values()].some(fs => JSON.stringify(fs).includes('a-later-article')));
ok('the new address is not sent to the relays', asked === false, asked);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} privacy gates: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
