// A NIP-07 signer that claims one identity and signs as another.
//
// The bridge to window.nostr runs on DOM events in the page's own world, so any script on the page
// can answer in place of the signer. That cannot be closed by a nonce or a token: there is no
// secret a content script can hand to main-world code that the page cannot read straight back out
// of it. The channel is unauthenticatable, and pretending otherwise would be the mistake.
//
// So the panel stopped taking getPublicKey on trust. A signed event carries the pubkey that
// actually signed it, and producing one for a key you do not hold is the thing the protocol rests
// on being impossible. This suite installs a signer that reports key A and signs with key B, and
// checks that the panel ends up believing B — the one that can be proved.
//
// The same path covers a signer that honestly switched account between the two calls.
//
//   node tests/browser-signer.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-signer.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9524);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8090);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8451);

const { _secp, normalizeUrl, toBech32, sign, verify, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored, published } = relay;
const RELAY_URL = relay.url;
const site = await startSite({ port: SITE_PORT, heading: 'Signer QA page' });

const PAGE = normalizeUrl(site.url);
const CLAIMED = newKey(), CLAIMED_PUB = _secp.pubKey(CLAIMED);   // what the signer says it is
const ACTUAL = newKey(), ACTUAL_PUB = _secp.pubKey(ACTUAL);      // what it actually signs with
const now = Math.floor(Date.now() / 1000);

// The event the fake signer hands back whatever it is asked to sign — a page answering in place of
// the signer has no reason to sign what you typed.
const forged = await sign(ACTUAL, {
    kind: 1111, created_at: now, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'Signed by the key that actually holds the pen.',
});
stored.push(await sign(newKey(), { kind: 1111, created_at: now - 300, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'An existing comment.' }));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncsign-',
    onClose: () => { site.close(); relay.close(); },
});

console.log(`\nrelay:   ${RELAY_URL}\nclaimed: ${CLAIMED_PUB.slice(0, 16)}…\nactual:  ${ACTUAL_PUB.slice(0, 16)}…\n`);
await goto(site.url);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

// No local key: the panel has to fall back to whatever window.nostr claims to be.
await js(configureScript({ relayUrl: RELAY_URL }));
await wait(1200);
await goto(site.url);
await wait(2000);

// Install the dishonest signer in the page, exactly where a hostile script would put it.
await js(`window.nostr = {
    getPublicKey: async () => ${JSON.stringify(CLAIMED_PUB)},
    signEvent: async () => (${JSON.stringify(forged)}),
  };
  return 1;`);
await wait(4000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(3000);

const status = () => js(`${ROOT} return s.getElementById('status').textContent;`);
const before = await status();
ok('the panel connects to the signer', /Connected as/.test(before || ''), before);

console.log('\n=== what the panel believes before anything is signed ===');
// Nothing has been proved yet, so the claim is all there is — and it is shown.
ok('it shows the identity the signer claimed', !/Not connected/.test(before || ''), before);

console.log('\n=== after something is actually signed ===');
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'Anything at all.';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);
await wait(4000);

const sent = published.filter(e => e.kind === 1111);
ok('the event that went out is the one the signer produced', sent.length === 1 && sent[0].pubkey === ACTUAL_PUB,
   sent.map(e => e.pubkey.slice(0, 16)));
ok('and it verifies', sent.length === 1 && await verify(sent[0]), sent.length);

// The correction: the panel adopts the key that signed, not the one that was claimed.
const view = JSON.parse(await js(`${ROOT}
  return JSON.stringify({ status: s.getElementById('status').textContent,
                          msg: s.getElementById('msg').textContent,
                          own: [...s.getElementById('list').querySelectorAll('.c.own')].length });`) || '{}');
// The status line shows an npub, so compare against that — comparing against hex would pass no
// matter what the panel believed, which is how this assertion was worthless the first time.
const shown = hex => toBech32('npub', hex).slice(0, 10);
ok('the panel shows the identity that signed', (view.status || '').includes(shown(ACTUAL_PUB)),
   { status: view.status, expected: shown(ACTUAL_PUB) });
ok('and no longer the one that was claimed', !(view.status || '').includes(shown(CLAIMED_PUB)),
   { status: view.status, claimed: shown(CLAIMED_PUB) });
ok('it recognises the comment as its own', view.own >= 1, view);
ok('and it says the identity moved', /Signing as|caught up/i.test(view.msg || ''), view.msg);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} signer: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
