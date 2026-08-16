// Pasting a private key into the wrong box.
//
// Reported as a layout worry — the nsec import field sat directly above the muted-words field, and
// the two look alike. Following it turned up something larger: no field in this panel knew what a
// private key was, and the comment box is open on every page. Pasting an nsec there and pressing
// send published the key to public relays, signed by that very key, permanently. The name field
// did the same into a profile.
//
// So the guard is not about layout. nsec1… is refused wherever it appears, because there is no
// reason to publish one. Bare 64-character hex is only refused when it is actually the key this
// browser holds — an event id and a pubkey are the same shape, and people quote those.
//
//   node tests/browser-keypaste.mjs
//   NC_BROWSER=firefox node tests/browser-keypaste.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9554);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8113);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8481);

const { _secp, toBech32, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Key paste QA page' });

const MINE = newKey();
const MINE_NSEC = toBech32('nsec', MINE);
const OTHER = newKey();                     // somebody else's key: still must never be published
const SOMEONES_PUBKEY = _secp.pubKey(OTHER); // 64 hex, and perfectly ordinary to quote

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'nckp-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}`, nsec: MINE_NSEC }));
await wait(1500);
await js(`${ROOT}
  const o = [...s.getElementById('p').children].find(c => c.style.zIndex === '28' && getComputedStyle(c).display !== 'none');
  if (o) [...o.querySelectorAll('button')].find(b => /not now/i.test(b.textContent))?.click();
  return 1;`);
await wait(2500);

const msg = () => js(`${ROOT} return s.getElementById('msg').textContent;`);
const postComment = async text => {
    await js(`${ROOT}
      s.getElementById('m').style.display='grid';
      s.getElementById('settings-close')?.click();
      const i = s.getElementById('input');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input', {bubbles:true}));
      s.getElementById('send').click(); return 1;`);
    await wait(3500);
};
const publishedText = () => relay.published.filter(e => e.kind === 1111 || e.kind === 1).map(e => e.content);

// --- the comment box, which is open on every page ---------------------------------------------------
console.log('\n=== a private key is never published as a comment ===');
relay.published.length = 0;
await postComment(MINE_NSEC);
ok('nothing is published', publishedText().length === 0, publishedText());
ok('and it says why', /looks like a private key/i.test(await msg()), await msg());
ok('it points at the right box instead', /existing identity/i.test(await msg()), await msg());

// A key does not have to be the whole message to be just as gone.
console.log('\n=== including one buried in a sentence ===');
relay.published.length = 0;
await postComment(`here is the thing I was talking about ${MINE_NSEC} — let me know`);
ok('a key mid-sentence is caught too', publishedText().length === 0, publishedText());

// Somebody else's nsec is not yours to publish either, and the panel cannot know whose it is.
console.log('\n=== somebody else’s key too ===');
relay.published.length = 0;
await postComment(toBech32('nsec', OTHER));
ok('any nsec is refused, not only your own', publishedText().length === 0, publishedText());

// --- and the things that must still go through ------------------------------------------------------
// A guard that refused anything key-shaped would break quoting an event or a person, which is
// ordinary on Nostr. This is the assertion that stops the fix from being worse than the bug.
console.log('\n=== ordinary comments still post ===');
relay.published.length = 0;
await postComment('a perfectly normal comment');
ok('normal text is published', publishedText().length === 1, publishedText());

relay.published.length = 0;
await postComment(`see the note by ${SOMEONES_PUBKEY} about this`);
ok('a 64-character pubkey is not mistaken for a private key', publishedText().length === 1, publishedText());

relay.published.length = 0;
await postComment(`good point from ${toBech32('npub', SOMEONES_PUBKEY)}`);
ok('an npub goes through as well', publishedText().length === 1, publishedText());

relay.published.length = 0;
await postComment(`nsec is the private half; never share it`);
ok('the word alone is not enough to be refused', publishedText().length === 1, publishedText());

// --- the name field, which writes a public profile ----------------------------------------------------
console.log('\n=== a private key is never published as a name ===');
relay.published.length = 0;
await js(`${ROOT}
  s.getElementById('m').style.display='grid';
  s.getElementById('gear-btn').click();
  s.getElementById('setname-input').value = ${JSON.stringify(MINE_NSEC)};
  s.getElementById('setname-btn').click(); return 1;`);
await wait(4000);
ok('no profile is published', relay.published.filter(e => e.kind === 0).length === 0,
   relay.published.filter(e => e.kind === 0).map(e => e.content));
ok('and it says why', /looks like a private key/i.test(await msg()), await msg());

// --- muted words: never published, but it outlives deleting the key -------------------------------------
console.log('\n=== a private key is not kept as a muted word ===');
await js(`${ROOT}
  s.getElementById('muteword-input').value = ${JSON.stringify(MINE_NSEC)};
  s.getElementById('muteword-add-btn').click(); return 1;`);
await wait(1500);
const muted = await js(`${ROOT}
  return JSON.stringify([...s.getElementById('muteword-list').querySelectorAll('*')].map(e => e.textContent).join(' '));`);
ok('it is not added to the list', !new RegExp(MINE_NSEC.slice(0, 20)).test(muted), muted);
ok('and it says why', /looks like a private key/i.test(await msg()), await msg());

await js(`${ROOT}
  s.getElementById('muteword-input').value = 'spam';
  s.getElementById('muteword-add-btn').click(); return 1;`);
await wait(1200);
ok('an ordinary word is still muted', /muted/i.test(await msg()), await msg());

// --- layout: the two boxes are no longer neighbours ------------------------------------------------------
// The report that started this. Order in the DOM is what puts them next to each other on screen.
console.log('\n=== the import box no longer sits next to the word filter ===');
const order = JSON.parse(await js(`${ROOT}
  const ids = ['keypair-section','import-section','signer-section','muted-section'];
  const p = s.getElementById('settings');
  const all = [...s.querySelectorAll('[id]')].map(e => e.id);
  return JSON.stringify(ids.map(id => all.indexOf(id)));`));
const [keypair, importS, signer, mutedS] = order;
ok('the import box comes after the private key block', importS > keypair, order);
ok('and before the signing choice', importS < signer, order);
ok('with the signing choice between it and the muted words', signer < mutedS, order);

console.log(`\n${state.fail ? '✗' : '✓'} pasting a key in the wrong box: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
