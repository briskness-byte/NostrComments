// The onboarding block used to sell you a signer you already had.
//
// Its two wallet buttons were unconditional links to the Chrome Web Store pages for Alby and nos2x
// — shown even to somebody with one of them already running, who was sent off to install an
// extension that was in their browser at that moment. Meanwhile the thing they wanted, connect the
// signer I have, existed only behind the Connect button in the header, which does not say what it
// will do. Reported from real use, exactly that way round.
//
// One button rather than two, because nothing here can tell Alby from nos2x: both simply provide
// window.nostr. Two named buttons would offer a choice that does not exist, and the "wrong" one
// would work anyway.
//
// The signer here refuses until it is approved, which is what nos2x and Alby actually do on a site
// they have not seen. That matters: a signer that answers immediately is picked up by auto-connect
// and the block is gone before anybody could press anything, so it is precisely the awaiting-
// approval case that the button exists for.
//
//   node tests/browser-signeroffer.mjs
//   NC_BROWSER=firefox node tests/browser-signeroffer.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9542);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8112);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8482);

const { _secp, toBech32, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Signer offer QA page' });
const SIGNER_PUB = _secp.pubKey(newKey());

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncoffer-',
    onClose: () => { site.close(); relay.close(); },
});

// offsetParent is null whenever an ancestor is hidden. getComputedStyle on the element alone is
// not, which would happily report the contents of a panel that is not on screen at all.
const shape = () => js(`${ROOT}
  const ob = s.getElementById('onboard');
  const vis = el => !!el && !!el.offsetParent;
  const btn = t => [...ob.querySelectorAll('button')].find(b => t.test(b.textContent));
  return JSON.stringify({
    block:    vis(ob),
    signer:   vis(btn(/connect your nostr signer/i)),
    generate: vis(btn(/generate your key|start commenting/i)),
    install:  [...ob.querySelectorAll('a')].filter(a => /alby|nos2x/i.test(a.textContent)).some(vis),
    hint:     [...ob.querySelectorAll('p')].some(p => /install it, then reload/i.test(p.textContent) && vis(p)),
    npub:     s.getElementById('identity-npub').textContent,
  });`);

await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: relay.url }));
await wait(1200);
await goto(site.url);
await wait(2500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(1500);

console.log('=== with no signer in the page ===');
let sh = JSON.parse(await shape());
ok('the onboarding block is up', sh.block === true, sh);
ok('the install links are what is offered', sh.install === true, sh);
ok('and the reload hint with them', sh.hint === true, sh);
ok('there is nothing to connect to', sh.signer === false, sh);
ok('generating a key is the primary way in', sh.generate === true, sh);

console.log('\n=== a signer appears, and will not hand over a key until approved ===');
await js(`window.__approved = false;
  window.nostr = {
      getPublicKey: async () => { if (!window.__approved) throw new Error('denied by user'); return ${JSON.stringify(SIGNER_PUB)}; },
      signEvent: async ev => ev,
  }; return 1;`);
for (let i = 0; i < 10; i++) {
    await wait(1500);
    sh = JSON.parse(await shape());
    if (sh.signer) break;
}
ok('the block offers to connect it', sh.signer === true, sh);
ok('the install links step aside', sh.install === false, sh);
ok('as does the reload hint, which no longer applies', sh.hint === false, sh);
ok('generating a key is still offered, as the second option', sh.generate === true, sh);

console.log('\n=== approving it and pressing the button ===');
await js(`window.__approved = true; return 1;`);
const clicked = await js(`${ROOT}
  const b = [...s.getElementById('onboard').querySelectorAll('button')].find(x => /connect your nostr signer/i.test(x.textContent));
  if (!b) return 'no button';
  b.click(); return 'clicked';`);
ok('the button is there to press', clicked === 'clicked', clicked);
await wait(3500);
sh = JSON.parse(await shape());
ok('it connects with that signer', sh.npub === toBech32('npub', SIGNER_PUB), { got: sh.npub, wanted: toBech32('npub', SIGNER_PUB) });
ok('and the block goes away', sh.block === false, sh);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} signer offer: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
