// Publishing a name while an external signer switches account under you.
//
// signAsMe adopts whatever key actually signed: a NIP-07 signer can change account at any time and
// never says so, the pubkey in the signature is the only thing that can be proved, so the panel
// corrects itself and says "the panel has caught up". For a comment that is exactly right — the
// words belong to whoever signed them.
//
// For kind 0 it is the opposite of right. The name path reads the profile of the account the panel
// believes in, merges the new name into it, and hands that to the signer. If the signer answers as
// a different account, the event that comes back carries one account's picture, about, banner,
// nip05 and lud16 — signed by another. Kind 0 is replaceable, so publishing it does not add a stray
// event: it overwrites the second account's entire profile with the first one's.
//
// The window is not narrow. The profile lookup waits up to six seconds, and the signer's own
// approval prompt sits open for as long as the user takes.
//
//   node tests/browser-setname-signer.mjs
//   NC_BROWSER=firefox node tests/browser-setname-signer.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9552);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8111);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8479);

const { _secp, sign, verify, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Signer name QA page' });

// A is who the panel thinks you are. B is who the signer answers as by the time it signs.
const A = newKey(), A_PUB = _secp.pubKey(A);
const B = newKey(), B_PUB = _secp.pubKey(B);
const A_PROFILE = { name: 'Account A', about: 'the profile the panel read', picture: 'https://example.com/a.png',
                    banner: 'https://example.com/a-banner.jpg', nip05: 'a@example.com', lud16: 'a@example.com' };
const B_PROFILE = { name: 'Account B', about: 'a different person entirely', picture: 'https://example.com/b.png',
                    nip05: 'b@example.com' };
const now = Math.floor(Date.now() / 1000);
relay.stored.push(await sign(A, { kind: 0, created_at: now - 600, content: JSON.stringify(A_PROFILE), tags: [] }));
relay.stored.push(await sign(B, { kind: 0, created_at: now - 600, content: JSON.stringify(B_PROFILE), tags: [] }));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncsns-',
    onClose: () => { site.close(); relay.close(); },
});

console.log(`\npanel believes: ${A_PUB.slice(0, 16)}…\nsigner answers: ${B_PUB.slice(0, 16)}…\n`);
await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

// No local key, so the panel has to use the signer in the page.
await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}` }));
await wait(1200);
await goto(site.url);
await wait(2000);

// The signer parks whatever it is asked to sign and waits. That lets this suite sign it for real,
// as B, with the runtime content — a forged signature would be caught by the panel's own
// verification and would prove nothing about this path.
await js(`window.__pending = null; window.__signed = null;
  window.nostr = {
    getPublicKey: async () => ${JSON.stringify(A_PUB)},
    signEvent: async ev => {
      window.__pending = JSON.stringify(ev);
      for (let i = 0; i < 400 && !window.__signed; i++) await new Promise(r => setTimeout(r, 50));
      const out = JSON.parse(window.__signed);
      window.__signed = null; window.__pending = null;
      return out;
    },
  };
  return 1;`);
await wait(4000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn').click(); return 1;`);
await wait(3000);

const view = () => js(`${ROOT} return JSON.stringify({
  name: s.getElementById('identity-name').textContent,
  input: s.getElementById('setname-input').value,
  msg: s.getElementById('msg').textContent });`);

let r = JSON.parse(await view());
ok('the panel is showing account A', r.name === 'Account A', r.name);
ok('and the field holds A’s name', r.input === 'Account A', r.input);

console.log('\n=== the signer answers as somebody else ===');
relay.published.length = 0;
await js(`${ROOT}
  s.getElementById('setname-input').value = 'Renamed While Switching';
  s.getElementById('setname-btn').click(); return 1;`);

// Wait for the event to reach the signer, then sign it as B — the account switch.
let pending = null;
for (let i = 0; i < 60 && !pending; i++) {
    await wait(500);
    pending = await js(`return window.__pending;`);
}
ok('the panel handed an event to the signer', !!pending, pending);
const handed = JSON.parse(pending);
ok('built as a kind 0', handed.kind === 0, handed.kind);
ok('from the profile of the account the panel believed in', JSON.parse(handed.content).picture === A_PROFILE.picture,
   JSON.parse(handed.content).picture);

const signedByB = await sign(B, handed);
ok('the countersignature really is B’s', signedByB.pubkey === B_PUB && await verify(signedByB), signedByB.pubkey.slice(0, 16));
await js(`window.__signed = ${JSON.stringify(JSON.stringify(signedByB))}; return 1;`);
await wait(5000);

console.log('\n=== nothing may be published under the other account ===');
const out = relay.published.filter(e => e.kind === 0);
ok('no kind 0 goes out at all', out.length === 0, out.map(e => ({ pubkey: e.pubkey.slice(0, 12), content: e.content })));
// The specific harm, stated as its own assertion so a failure names it.
const overwrote = out.find(e => e.pubkey === B_PUB);
ok('B’s profile is not replaced by A’s', !overwrote,
   overwrote && { picture: JSON.parse(overwrote.content).picture, was: B_PROFILE.picture });

r = JSON.parse(await view());
ok('and it says the accounts did not match', /different account/i.test(r.msg), r.msg);

// A guard that refused everything would pass every assertion above, so the honest path has to be
// shown working through the same signer, on the same run.
console.log('\n=== the same signer, staying on its account, still works ===');
relay.published.length = 0;
await js(`${ROOT}
  s.getElementById('setname-input').value = 'Renamed Properly';
  s.getElementById('setname-btn').click(); return 1;`);
pending = null;
for (let i = 0; i < 60 && !pending; i++) {
    await wait(500);
    pending = await js(`return window.__pending;`);
}
ok('the event reaches the signer again', !!pending, pending);
const signedByA = await sign(A, JSON.parse(pending));
await js(`window.__signed = ${JSON.stringify(JSON.stringify(signedByA))}; return 1;`);
await wait(5000);

const good = relay.published.filter(e => e.kind === 0);
ok('the kind 0 is published', good.length === 1, good.length);
ok('signed by the account it was built for', good[0]?.pubkey === A_PUB, good[0]?.pubkey?.slice(0, 16));
let gc = null; try { gc = JSON.parse(good[0].content); } catch (e) {}
ok('carrying the new name', gc?.name === 'Renamed Properly', gc?.name);
ok('and the rest of A’s profile intact', gc?.picture === A_PROFILE.picture && gc?.banner === A_PROFILE.banner
   && gc?.nip05 === A_PROFILE.nip05 && gc?.lud16 === A_PROFILE.lud16, gc);

// A signer prompt is a person reading a dialog, not a network round trip. The bridge allowed five
// seconds for it, so an approval that took a moment longer was thrown away together with whatever
// had been typed — reported from a real nos2x run, where waiting to click lost the change.
console.log('\n=== a signer approval that takes its time still counts ===');
relay.published.length = 0;
await js(`${ROOT}
  s.getElementById('setname-input').value = 'Renamed Slowly';
  s.getElementById('setname-btn').click(); return 1;`);
pending = null;
for (let i = 0; i < 60 && !pending; i++) {
    await wait(500);
    pending = await js(`return window.__pending;`);
}
ok('the event reaches the signer', !!pending, pending);
const slowlySigned = await sign(A, JSON.parse(pending));
await wait(12000);                                 // longer than a human takes, and than five seconds
await js(`window.__signed = ${JSON.stringify(JSON.stringify(slowlySigned))}; return 1;`);
await wait(6000);

const late = relay.published.filter(e => e.kind === 0);
ok('the late signature is still accepted', late.length === 1, late.length);
let lc = null; try { lc = JSON.parse(late[0].content); } catch (e) {}
ok('and it carries the name that was typed', lc?.name === 'Renamed Slowly', lc?.name);

console.log(`\n${state.fail ? '✗' : '✓'} publishing a name through a signer: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
