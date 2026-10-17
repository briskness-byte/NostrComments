// A page must not be able to answer the panel's dialogs for the reader.
//
// Audit of 17 Oct 2026: the confirm dialog (replace / regenerate / delete the stored key, and the
// "Save your key?" offer that opens by itself after a first comment), the password dialog (which
// also opens by itself, offering to protect a new key) and the button that sets or removes the
// password all acted on a scripted click. So a page could put the key on screen through "Show my
// key", encrypt it with a password of its own choosing, strip the password from an unlocked key, or
// confirm the deletion of an identity the reader had only started to read about. Every other control
// that touches the key already required a real gesture.
//
// The page here plays the attacker with scripted clicks and a forged Enter key; the reader's own
// answers are real clicks.
//
//   node tests/browser-dialog-gestures.mjs
//   NC_BROWSER=firefox node tests/browser-dialog-gestures.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9603);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8163);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8523);

const { newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT, onEvent: (ev, api) => api.accept() });
const site = await startSite({ port: SITE_PORT, heading: 'Dialog gestures QA page' });
const KEY = newKey();
const NSEC = toBech32('nsec', KEY);
const EVIL = 'chosen-by-the-page';

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncdialogs-',
    onClose: () => { site.close(); relay.close(); },
});

const shown = id => js(`${ROOT} const el = s.getElementById(${JSON.stringify(id)}); if (!el) return false;
  let n = el; while (n && n !== s) { if (getComputedStyle(n).display === 'none') return false; n = n.parentElement || n.parentNode; } return true;`);
const pwLabel = () => js(`${ROOT} return s.getElementById('pw-btn')?.textContent || '';`);
const keyInDom = () => js(`${ROOT} return /nsec1/.test(s.getElementById('privkey-display').value || '');`);

console.log('=== setup: an unencrypted key, never backed up, never offered a password ===');
await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }
await js(configureScript({ relayUrl: relay.url, nsec: NSEC }));
await wait(1500);
await goto(site.url);
await wait(3000);

console.log('\n=== the password offer, which opens by itself ===');
await nclick("s.getElementById('nc-btn')");          // the reader opens the panel
await wait(1500);
ok('the offer to protect the key is on screen', await shown('pw-ok') === true);
await js(`${ROOT} s.getElementById('pw-1').value = ${JSON.stringify(EVIL)}; s.getElementById('pw-2').value = ${JSON.stringify(EVIL)};
  s.getElementById('pw-ok').click(); return 1;`);
await wait(800);
ok('a scripted click on "Set a password" does nothing', await shown('pw-ok') === true);
await js(`${ROOT} s.getElementById('pw-2').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1;`);
await wait(800);
ok('nor does a forged Enter key', await shown('pw-ok') === true);
await nclick("s.getElementById('pw-no')");              // the reader says "Not now"
await wait(800);
ok('the reader\'s own "Not now" closes it', await shown('pw-ok') === false);
ok('and the key was not encrypted with the page\'s password', /set a password/i.test(await pwLabel()), await pwLabel());

console.log('\n=== the password button in Settings ===');
await js(`${ROOT} s.getElementById('gear-btn')?.click(); return 1;`);
await wait(1200);
await js(`${ROOT} s.getElementById('pw-btn').click(); return 1;`);
await wait(800);
ok('a scripted click on the password button opens nothing', await shown('pw-ok') === false);

console.log('\n=== confirming the deletion of the key ===');
await nclick("s.getElementById('privkey-delete')");     // the reader starts to delete…
await wait(800);
ok('the confirmation is on screen', await shown('ask-yes') === true);
await js(`${ROOT} s.getElementById('ask-yes').click(); return 1;`);
await wait(1000);
ok('a scripted "yes" does not delete it', await shown('ask-yes') === true);
await nclick("s.getElementById('ask-no')");              // …and decides against it
await wait(800);
ok('the reader\'s own "Cancel" closes it', await shown('ask-yes') === false);
const stillThere = await js(`${ROOT} return /Delete keypair/i.test(s.getElementById('privkey-delete')?.textContent || '') && getComputedStyle(s.getElementById('keypair-section')).display !== 'none';`);
ok('and the key is still stored', stillThere === true, stillThere);

console.log('\n=== "Save your key?", which opens by itself after a first comment ===');
await goto(site.url);                                   // a fresh page: one prompt per page
await wait(3000);
await nclick("s.getElementById('nc-btn')");
await wait(1500);
await js(`${ROOT} const i = s.getElementById('input'); i.value = 'A first comment.'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
await nclick("s.getElementById('send')");
let offered = false;
for (let i = 0; i < 20 && !offered; i++) { await wait(500); offered = await shown('ask-yes') === true; }
ok('the backup offer appears after the first comment', offered);
if (offered) {
    await js(`${ROOT} s.getElementById('ask-yes').click(); return 1;`);
    await wait(1200);
    ok('a scripted "Show my key" does not put the key in the DOM', await keyInDom() === false);
    ok('and the offer is still waiting for the reader', await shown('ask-yes') === true);
    await nclick("s.getElementById('ask-yes')");
    await wait(1500);
    ok('the reader\'s own click does show it', await keyInDom() === true);
}

console.log(`\n${state.fail ? '✗' : '✓'} dialog gestures: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
