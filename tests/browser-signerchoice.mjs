// Which key speaks for you, and whether the panel remembers what you told it.
//
// Reported from real use: users must not lose the keys they already have when switching between a
// native app key and a nos2x / Alby extension.
//
// The concern was right and the bug was worse than key loss. The stored key was never deleted, but
// the choice was ignored: on load the panel asked only whether a signer was *installed*, and if one
// was, it skipped the stored key entirely — so choosing "Key stored here" and reloading with Alby
// or nos2x present connected you as the signer's identity, silently, with your own key sitting
// untouched in storage. In an extension whose whole subject is which key speaks for you, posting
// under the wrong one is not a cosmetic bug.
//
// Two more failures in the same place, both reported as "sometimes it does not see nos2x":
// the auto-connect loop stopped for good the first time the check came back empty, and the check
// itself allowed 800ms — less than a signer extension needs to inject window.nostr on a cold start.
//
//   node tests/browser-signerchoice.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9544);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8103);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8471);

const { _secp, toBech32, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Signer choice QA page' });

const STORED = newKey(), STORED_PUB = _secp.pubKey(STORED);
const SIGNER = newKey(), SIGNER_PUB = _secp.pubKey(SIGNER);
const npubOf = p => toBech32('npub', p);

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncsc-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

// --- what the panel says it is using, before anybody has chosen anything -------------------------
// Reported from real use: connected through nos2x-fox, but "Key stored here" was the lit button.
// It was: the highlight was drawn from signerPref, which stays null until somebody presses one of
// the two, while getWallet() falls back to the NIP-07 signer whenever no local key is loaded. So
// the panel named one signer and used the other. This has to be right on the first paint, because
// the whole subject of this extension is which key speaks for you.
//
// Storage is untouched at this point in the run — fresh profile, no key, no preference — which is
// the state a new user with a signer installed is in.
console.log('\n=== with a signer and no stored key, the signer is the lit choice ===');
const putSigner = () => js(`window.nostr = {
    getPublicKey: async () => ${JSON.stringify(SIGNER_PUB)},
    signEvent: async ev => ev,
  }; return 1;`);
await putSigner();
await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}` }));
await wait(1200);
await goto(site.url);                 // a reload, so the signer is there from the very first paint
await wait(2500);
await putSigner();
await wait(8000);                     // the availability check runs on the auto-connect interval
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn').click(); return 1;`);
await wait(1500);

const lit = () => js(`${ROOT}
  // The lit state is a class, not an inline colour. It was inline until the panel's colours were
  // moved into CSS so that dark mode could reach them — reading style.background here would still
  // pass against a button that no longer lights up at all.
  const b = id => { const e = s.getElementById(id); return { on: e.classList.contains('on') }; };
  return JSON.stringify({ local: b('signer-local'), nip07: b('signer-nip07'),
                          note: s.getElementById('signer-note').textContent });`);
let sc = JSON.parse(await lit());
ok('the signer button is the highlighted one', sc.nip07.on === true, sc.nip07);
ok('and the stored-key button is not', sc.local.on === false, sc.local);
ok('the note says the browser signer is in use', /browser signer/i.test(sc.note), sc.note);

await goto(site.url);
await wait(2500);

await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}`, nsec: toBech32('nsec', STORED) }));
await wait(1500);
await js(`${ROOT}
  const o = [...s.getElementById('p').children].find(c => c.style.zIndex === '28' && getComputedStyle(c).display !== 'none');
  if (o) [...o.querySelectorAll('button')].find(b => /not now/i.test(b.textContent))?.click();
  return 1;`);
await wait(500);

const identity = () => js(`${ROOT} return JSON.stringify({
  status: s.getElementById('status').textContent,
  npub: s.getElementById('identity-npub').textContent });`);
const press = label => js(`${ROOT}
  const b = [...s.querySelectorAll('button')].find(x => new RegExp(${JSON.stringify(label)}, 'i').test(x.textContent));
  if (b) b.click(); return !!b;`);
// Install a signer holding a different identity, the way Alby or nos2x would.
const installSigner = () => js(`window.nostr = {
    getPublicKey: async () => ${JSON.stringify(SIGNER_PUB)},
    signEvent: async () => { throw new Error('not needed here'); } };
  return 1;`);
const reloadWithSigner = async (ms = 9000) => { await goto(site.url); await installSigner(); await wait(ms);
    await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`); await wait(1200); };

console.log('\n=== choosing the key stored here, and meaning it ===');
ok('the panel offers the choice', await press('key stored here') === true);
await wait(1200);
let id = JSON.parse(await identity());
ok('it connects with the stored key', id.npub === npubOf(STORED_PUB), id);

await reloadWithSigner();
id = JSON.parse(await identity());
// The bug: a signer being present was enough to override this.
ok('and after a reload with a signer installed it is still the stored key',
    id.npub === npubOf(STORED_PUB), { got: id.npub, wanted: npubOf(STORED_PUB), signer: npubOf(SIGNER_PUB) });
ok('the panel does not silently become the signer', !id.status.includes(npubOf(SIGNER_PUB).slice(0, 10)), id.status);

console.log('\n=== choosing the signer, and meaning that too ===');
await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
await wait(400);
ok('the signer can be chosen', await press('alby / nos2x') === true);
await wait(1500);
id = JSON.parse(await identity());
ok('it switches to the signer identity', id.npub === npubOf(SIGNER_PUB), id);

await reloadWithSigner();
id = JSON.parse(await identity());
ok('and a stored key does not take it back on reload', id.npub === npubOf(SIGNER_PUB),
   { got: id.npub, wanted: npubOf(SIGNER_PUB) });

console.log('\n=== the stored key is never destroyed by switching ===');
await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
await wait(400);
await press('key stored here');
await wait(1500);
id = JSON.parse(await identity());
ok('switching back returns the original identity', id.npub === npubOf(STORED_PUB), id);
const still = await js(`${ROOT}
  s.getElementById('privkey-reveal').click();
  const v = s.getElementById('privkey-display').value;
  s.getElementById('privkey-reveal').click();
  return v;`);
ok('and the key itself was there the whole time', still === toBech32('nsec', STORED), still ? 'a value' : '(empty)');

console.log('\n=== a signer that arrives late is still picked up ===');
// The auto-connect loop used to stop for good the first time the check came back empty, so a
// signer that finished injecting a moment later was never seen again on that page.
await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
await wait(300);
await press('alby / nos2x');
await wait(800);
await goto(site.url);
// The identity strings are only written to the DOM while the panel is on screen, so the panel has
// to be open to observe what this is testing. Set directly rather than clicked: clicking also calls
// startNetwork(), and the timing of the auto-connect loop is the thing under test here.
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(9000);                 // let the first checks come back empty
await installSigner();            // only now does the signer exist
let late = null;
for (let i = 0; i < 12; i++) {
    await wait(2500);
    late = JSON.parse(await identity());
    if (late.npub === npubOf(SIGNER_PUB)) break;
}
ok('a signer appearing after the first check still connects', late.npub === npubOf(SIGNER_PUB),
   { got: late.npub, wanted: npubOf(SIGNER_PUB) });

console.log(`\n${state.fail ? '✗' : '✓'} signer choice: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
