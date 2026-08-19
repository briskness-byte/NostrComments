// A NIP-07 signer that is switched off while the tab stays open.
//
// Disabling nos2x or Alby does not take window.nostr away from a page that is already loaded: the
// object belongs to the page, the extension behind it does not. So the provider still accepts
// signEvent, forwards it to a background script that is gone, and no answer ever comes back.
//
// Every liveness check the panel can make says the signer is fine — including its own 'check',
// which reads !!window.nostr and nothing more. Reported from real use: the Post button went dead,
// no comment appeared, and nothing was said. It was waiting the full minute, and the message that
// eventually arrived removed itself again after two and a half seconds.
//
// This suite installs a signer that answers once and then goes quiet, and checks that the panel
// says so within seconds, keeps saying it, and loses nothing that was typed.
//
//   node tests/browser-signerdead.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-signerdead.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9531);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8100);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8458);

const { _secp, normalizeUrl, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { published } = relay;
const RELAY_URL = relay.url;
const site = await startSite({ port: SITE_PORT, heading: 'Dead signer QA page' });

const PAGE = normalizeUrl(site.url);
const SIGNER = newKey(), SIGNER_PUB = _secp.pubKey(SIGNER);
const now = Math.floor(Date.now() / 1000);

// The one event the signer is willing to produce, before it stops answering.
const firstSigned = await sign(SIGNER, {
    kind: 1111, created_at: now, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'The one that gets through.',
});

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncdead-',
    onClose: () => { site.close(); relay.close(); },
});

console.log(`\nrelay:  ${RELAY_URL}\nsigner: ${SIGNER_PUB.slice(0, 16)}…\n`);
await goto(site.url);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: RELAY_URL }));
await wait(1200);
await goto(site.url);
await wait(2000);

// A signer that works exactly once, then behaves like an extension that has just been disabled:
// the object stays, the answers stop. A promise that never settles is precisely what the page
// sees in that state — not a rejection, not an error, nothing.
await js(`window.__ncAnswers = 0;
  window.nostr = {
      getPublicKey: async () => ${JSON.stringify(SIGNER_PUB)},
      signEvent: async () => {
          if (window.__ncAnswers++ === 0) return ${JSON.stringify(firstSigned)};
          return new Promise(() => {});
      },
  };
  return 1;`);
await wait(4000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(3000);

const status = await js(`${ROOT} return s.getElementById('status').textContent;`);
ok('the panel connects to the signer', /Connected as/.test(status || ''), status);

console.log('\n=== while the signer is still answering ===');
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'The one that gets through.';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);
await wait(4000);
ok('the first comment is published', published.filter(e => e.kind === 1111).length === 1,
   published.filter(e => e.kind === 1111).length);

console.log('\n=== and then it goes quiet ===');
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'The one that hangs.';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);

// The point of the fix: something is said within seconds, not after a minute.
await wait(6000);
const early = JSON.parse(await js(`${ROOT}
  const m = s.getElementById('msg');
  return JSON.stringify({ text: m.textContent, shown: m.style.display !== 'none',
                          input: s.getElementById('input').value,
                          disabled: !!s.getElementById('send').disabled });`) || '{}');

ok('the panel says the signer has not answered', /signer has not answered/i.test(early.text || ''), early.text);
// Both halves, because the message strip is left displayed with empty text once anything has
// been said on the page — so "is it visible" on its own passes while the panel says nothing.
ok('and there is something on screen to read', early.shown === true && (early.text || '').trim() !== '', early);
ok('the Post button is still held while it waits', early.disabled === true, early);
ok('nothing typed was lost', early.input === 'The one that hangs.', early.input);
ok('and nothing was published', published.filter(e => e.kind === 1111).length === 1,
   published.filter(e => e.kind === 1111).length);

// It used to take itself off screen after 2.5s, which is how a real report came in as "nothing
// happens at all". A message the reader has to act on stays until there is something new to say.
console.log('\n=== and keeps saying it ===');
await wait(6000);
const later = JSON.parse(await js(`${ROOT}
  const m = s.getElementById('msg');
  return JSON.stringify({ text: m.textContent, shown: m.style.display !== 'none' });`) || '{}');
ok('the message has not removed itself', later.shown === true && /signer has not answered/i.test(later.text || ''), later);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} dead signer: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
