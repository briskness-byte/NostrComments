// After a reload, a reader who chose their signer should not see "Not connected".
//
// Reported 14 Oct 2026 with Attest: every reload showed "Not connected" and a Connect button, though
// the choice was stored. The automatic reconnect existed, but its first look came five seconds after
// load. Signers inject window.nostr asynchronously, usually well within a second, so this suite puts
// the signer in late on purpose.
//
// Since 19 Oct 2026 the panel no longer asks the signer on load at all: Attest asks permission per
// site, so that meant a prompt on every new site visited. The suite now checks that nothing is asked
// before the panel opens, that opening it asks exactly once and shows the signer's identity, and
// that the on/off switch in the toolbar popup (nostrcomments_off) takes the panel away and brings it
// back on open pages.
//
//   node tests/browser-signer-reload.mjs
//   NC_BROWSER=firefox node tests/browser-signer-reload.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, seedStorage, ROOT } from './harness.mjs';

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

// An honest signer that counts how often it is asked for the key, and remembers when it was first
// asked — in ms since this page started loading (performance.now). That moment *is* the connect:
// the panel asks for the key exactly once, when it connects. It is also visible from the page,
// unlike "Connected as …", which the panel clears whenever it was not opened by a real click.
const installSigner = () => js(`window.__gpk = 0; window.__gpkAt = null; window.__injectedAt = Math.round(performance.now());
  window.nostr = {
    getPublicKey: async () => { window.__gpk++; if (window.__gpkAt === null) window.__gpkAt = Math.round(performance.now()); return ${JSON.stringify(MY_PUB)}; },
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
await wait(800);
await installSigner();                            // the signer shows up after the page did
await wait(5000);                                 // past the 2.5 s settle and the early looks
let t = JSON.parse(await js(`return JSON.stringify({ gpkAt: window.__gpkAt, asked: window.__gpk });`));
// Since 19 Oct 2026 the signer is asked only once the panel is open: Attest asks permission per
// site, so asking on load put a prompt on every new site somebody merely visited.
ok('the signer is not asked before the panel is opened', t.asked === 0, t);

// Identity: open the panel with a real click. Now the signer is asked, once.
await nclick("s.getElementById('nc-btn')");
await wait(1500);
const asked = await js(`return window.__gpk;`);
ok('opening the panel asks the signer for the public key once', asked === 1, asked);
st = await status();
ok('it is connected as the signer\'s identity, not the stored key', (st || '').includes(SHOWN), { status: st, expected: SHOWN });

console.log('\n=== the switch in the toolbar popup ===');
await goto(site.url);
await wait(800);
await installSigner();
// The popup writes nostrcomments_off; the page cannot, so the test writes it through the seed hook.
await js(seedStorage({ nostrcomments_off: true }));
await wait(1500);
let shown = await js(`return !![...document.documentElement.children].find(el => el.shadowRoot && el.shadowRoot.getElementById('nc-btn'));`);
ok('switched off, the button leaves the open page', shown === false, shown);
await goto(site.url);
await wait(800);
await installSigner();
await wait(4000);
shown = await js(`return !![...document.documentElement.children].find(el => el.shadowRoot && el.shadowRoot.getElementById('nc-btn'));`);
ok('and a page loaded while off shows nothing', shown === false, shown);
ok('  and does not ask the signer', (await js(`return window.__gpk;`)) === 0);
await js(seedStorage({ nostrcomments_off: false }));
await wait(2500);
shown = await js(`return !![...document.documentElement.children].find(el => el.shadowRoot && el.shadowRoot.getElementById('nc-btn'));`);
ok('switched on again, it comes back without a reload', shown === true, shown);

console.log(`\n${state.fail ? '✗' : '✓'} signer reload: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
