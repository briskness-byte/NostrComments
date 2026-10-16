// After a reload, a reader who chose their signer should not see "Not connected".
//
// Reported 14 Oct 2026 with Attest: every reload showed "Not connected" and a Connect button, though
// the choice was stored. The automatic reconnect existed, but its first look came five seconds after
// load. Signers inject window.nostr asynchronously, usually well within a second, so this suite puts
// the signer in late on purpose and expects the panel to connect on its own, soon, and to ask the
// signer for the public key exactly once.
//
//   node tests/browser-signer-reload.mjs
//   NC_BROWSER=firefox node tests/browser-signer-reload.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9597);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8157);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8517);

const { _secp, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Signer reload QA page' });

const STORED = newKey();                          // a key kept in the extension too, as the reader had
const ME = newKey(), MY_PUB = _secp.pubKey(ME);   // the identity the signer holds
const SHOWN = toBech32('npub', MY_PUB).slice(0, 10);

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncsigreload-',
    onClose: () => { site.close(); relay.close(); },
});

// An honest signer that counts how often it is asked for the key.
const installSigner = () => js(`window.__gpk = 0; window.nostr = {
    getPublicKey: async () => { window.__gpk++; return ${JSON.stringify(MY_PUB)}; },
    signEvent: async () => { throw new Error('not used in this suite'); },
  }; return 1;`);
const status = () => js(`${ROOT} return s.getElementById('status').textContent;`);

console.log('=== setup: a stored key, and the signer chosen ===');
await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', STORED) }));
await wait(1500);
await goto(site.url);
await wait(1000);
await installSigner();
await wait(2500);
// Choose the signer the way the reader did, through Settings, so the choice is stored for real.
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn')?.click(); return 1;`);
await wait(1000);
await nclick("s.getElementById('signer-nip07')");
await wait(2500);
let st = await status();
ok('the signer is chosen and connected', (st || '').includes(SHOWN), { status: st, expected: SHOWN });

console.log('\n=== reload, with the signer arriving late ===');
await goto(site.url);
const t0 = Date.now();
await wait(800);
await installSigner();                            // the signer shows up after the page did
let connectedAt = null;
for (let t = 0; t < 12000; t += 250) {
    st = await status();
    if ((st || '').includes(SHOWN)) { connectedAt = Date.now() - t0; break; }
    await wait(250);
}
console.log(`  connected after ${connectedAt === null ? 'never (12 s)' : connectedAt + ' ms'}`);
ok('it connects on its own, without a click', connectedAt !== null, st);
// Before the fix the first look came at 5 s, so anything under 4 s means the early looks did it.
ok('and soon: within 4 seconds of the reload', connectedAt !== null && connectedAt < 4000, connectedAt);
ok('as the signer\'s identity, not the stored key', (st || '').includes(SHOWN), st);
const asked = await js(`return window.__gpk;`);
ok('the signer was asked for the public key once', asked === 1, asked);

console.log(`\n${state.fail ? '✗' : '✓'} signer reload: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
