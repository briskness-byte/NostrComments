// NIP-65 inbox delivery (discussed in GitHub issue #4, Oct 2026).
//
// People list the relays they read in a kind 10002 relay list. A reply that only lands on the
// replier's relays can miss its addressee entirely when the addressee's relays refuse strangers'
// relays — which fiatjaf argues is where spam pushes them. So a reply also goes to the inbox of the
// person answered, and the reader's own notifications are also read from the reader's own inbox.
//
// What must hold: a reply reaches the answered person's inbox relay; a top-level comment does not
// go there (nobody is being answered); the reader's notification subscription opens on their own
// inbox relay; and with the setting off, neither happens. Thread reading never touches either.
//
// Inbox relays need a hostname (an address literal is refused, like a picture's host), and only
// Chromium can map a test hostname onto loopback, so this suite is Chromium only.
//
//   node tests/browser-inbox.mjs
//
// Requires: chromium (or Chrome) and chromedriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT, BROWSER, setToggle } from './harness.mjs';

if (BROWSER === 'firefox') { console.log('Chromium only (needs a test hostname on loopback); skipped under Firefox.'); process.exit(0); }

const CD_PORT = Number(process.env.QA_PORT || 9617);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8177);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8538);
const THEIR_INBOX_PORT = Number(process.env.QA_INBOX_PORT || 8539);
const MY_INBOX_PORT = Number(process.env.QA_MYINBOX_PORT || 8541);

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const theirInbox = await startRelay({ port: THEIR_INBOX_PORT });
const myInbox = await startRelay({ port: MY_INBOX_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Inbox QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);
const ME = newKey(), MY_PUB = _secp.pubKey(ME);
const THEM = newKey();
const THEIR_INBOX = `wss://their-inbox.nctest:${THEIR_INBOX_PORT}`;
const MY_INBOX = `wss://my-inbox.nctest:${MY_INBOX_PORT}`;

relay.stored.push(await sign(THEM, {
    kind: 1111, created_at: now - 300,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'A comment worth answering.',
}));
// Their relay list: one inbox, one outbox-only relay that must not be written to.
relay.stored.push(await sign(THEM, { kind: 10002, created_at: now - 1000, content: '',
    tags: [['r', THEIR_INBOX, 'read'], ['r', 'wss://their-outbox.nctest:1', 'write'], ['r', 'wss://10.0.0.5', 'read']] }));
relay.stored.push(await sign(ME, { kind: 10002, created_at: now - 1000, content: '', tags: [['r', MY_INBOX]] }));

const browser = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncinbox-',
    onClose: () => { site.close(); relay.close(); theirInbox.close(); myInbox.close(); },
    resolverRules: ['MAP their-inbox.nctest 127.0.0.1', 'MAP my-inbox.nctest 127.0.0.1'],
});
const { js, wait, goto, finish, nclick } = browser;

await goto(site.url);
await wait(3000);
ok('extension injects into the page', await js(`${ROOT} return !!s;`) === true);
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);
await goto(site.url);
await wait(4000);
await nclick("s.getElementById('nc-btn')");
await wait(1500);

const pSubOn = r => [...r.conns].some(c => [...c.subs.values()].some(fs => fs.some(f => (f['#p'] || []).includes(MY_PUB))));
console.log('\n=== your notifications also come from your own inbox ===');
ok('the notification subscription is open on your inbox relay', pSubOn(myInbox), myInbox.conns.size);

console.log('\n=== a top-level comment goes to your relays only ===');
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'A comment that answers nobody.';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  return 1;`);
await nclick("s.getElementById('send')");
await wait(3500);
ok('it is published', relay.published.some(e => e.content === 'A comment that answers nobody.'));
ok('and not sent to anyone\'s inbox', !theirInbox.published.some(e => e.content === 'A comment that answers nobody.'));

console.log('\n=== a reply also goes to the inbox of the person answered ===');
const reply = async text => {
    await js(`${ROOT}
      const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('A comment worth answering'));
      [...c.querySelectorAll('button')].find(b => /Reply/i.test(b.textContent)).click();
      const i = s.getElementById('input');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input', {bubbles:true}));
      return 1;`);
    await wait(1500);
    await nclick("s.getElementById('send')");
    await wait(4000);
};
await reply('An answer for you.');
ok('the reply is on your relay', relay.published.some(e => e.content === 'An answer for you.'));
ok('and on their inbox relay', theirInbox.published.some(e => e.content === 'An answer for you.'), theirInbox.published.map(e => e.content));
ok('the inbox relay received nothing else', theirInbox.published.every(e => e.content === 'An answer for you.'));

console.log('\n=== with the setting off, neither happens ===');
const off = await setToggle(browser, 'inbox-toggle', false);
ok('the setting can be switched off', off === false, off);
await wait(1500);
for (let i = 0; i < 10 && pSubOn(myInbox); i++) await wait(500);
ok('the notification subscription leaves your inbox relay', !pSubOn(myInbox));
await reply('A second answer, kept to my relays.');
ok('the reply is still published', relay.published.some(e => e.content === 'A second answer, kept to my relays.'));
ok('but not sent to their inbox', !theirInbox.published.some(e => e.content === 'A second answer, kept to my relays.'));

console.log('\n=== and it stays off after a reload ===');
await goto(site.url);
await wait(4000);
await nclick("s.getElementById('nc-btn')");
await wait(1500);
await reply('A third answer, after reloading.');
ok('the reply is published', relay.published.some(e => e.content === 'A third answer, after reloading.'));
ok('and still not sent to their inbox', !theirInbox.published.some(e => e.content === 'A third answer, after reloading.'));

await finish(state.fail ? 1 : 0);
