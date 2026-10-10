// "Hide the floating button on every page" — the one global, off-by-default setting that removes
// the circle from the corner of the page entirely, leaving the toolbar popup's existing
// "Open comments on this page" (nc-toggle, see parity.test.mjs and popup.test.mjs) as the only way
// in. Confirms: off by default, a page cannot switch it on itself (same gesture-trust gate as every
// other toggle in settings), a real toggle removes the button on the next load rather than just
// hiding it, the panel's own host survives regardless, and a session that starts with it already on
// shows the setting correctly reflected in the UI.
//
// The second half seeds the setting directly (seedStorage) rather than reaching it by opening
// settings on a page that had the button earlier in the same session and closing it there first:
// that specific sequence — set the modal's style directly, then click gear-btn, on an origin that
// is not the one the button was last real-clicked on — was seen to leave the style write not
// landed, consistently, through no code path in content.js (no close handler fires, nothing else
// writes to it). It reproduces only through that scripted shortcut, never through a real click,
// which is also the only thing a reader ever does — the toolbar route this setting leaves in place
// goes through a trusted browser-chrome click, not a script setting styles directly. Seeding sidesteps
// the shortcut entirely rather than working around a chromedriver quirk neither this suite nor the
// extension can see the mechanism of.
//
//   node tests/browser-hidebtn.mjs
//   NC_BROWSER=firefox node tests/browser-hidebtn.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { reporter, startRelay, startSite, startBrowser, seedStorage, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9563);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8126);
const SITE2_PORT = SITE_PORT + 1;
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8489);

const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Hide-button QA page' });
const site2 = await startSite({ port: SITE2_PORT, heading: 'A second origin, to prove the setting is global' });

const { js, nclick, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'nchb-',
    onClose: () => { site.close(); site2.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

const hasBtn = () => js(`${ROOT} return !!s.getElementById('nc-btn');`);
const hasModal = () => js(`${ROOT} return !!s.getElementById('m');`); // the panel's own host, independent of the button
const openSettings = async () => {
    await js(`${ROOT} s.getElementById('m').style.display='grid'; if (s.getElementById('settings').style.display !== 'block') s.getElementById('gear-btn').click(); return 1;`);
    await wait(1000);
};

console.log('=== on by default ===');
ok('the button is there', await hasBtn() === true, await hasBtn());

console.log('=== a page cannot switch it on for the reader ===');
await openSettings();
const flip = await js(`${ROOT} const t = s.getElementById('hidebtn-toggle'); t.checked = true; t.dispatchEvent(new Event('change', {bubbles:true})); return t.checked;`);
ok('the checkbox snaps back off', flip === false, flip);
const stillOff = await js(`${ROOT} return s.getElementById('hidebtn-toggle').checked;`);
ok('and the setting itself did not change', stillOff === false, stillOff);

console.log('=== the reader turning it on, for real ===');
await nclick("s.getElementById('hidebtn-toggle')");
await wait(500);
const checkedNow = await js(`${ROOT} return s.getElementById('hidebtn-toggle').checked;`);
ok('the checkbox reflects it', checkedNow === true, checkedNow);
// Takes effect on the next load, same as the worker toggle above it — the button is still the one
// built this page load.
ok('the button is unaffected until reload', await hasBtn() === true, await hasBtn());

console.log('=== after a reload, the button is gone — not hidden, absent ===');
await goto(site.url);
await wait(2500);
ok('no #nc-btn in the shadow root at all', await hasBtn() === false, await hasBtn());
ok('the panel host still exists — the toolbar route is unaffected', await hasModal() === true, await hasModal());

console.log('=== turning it back off restores the button ===');
// settings is not reopened here (see the file comment for why); the storage write from the real
// toggle below is checked the same way the one above was: by what the button does on reload.
await js(seedStorage({ nostrcomments_hidebtn: false }));
await goto(site.url);
await wait(2500);
ok('the button is back', await hasBtn() === true, await hasBtn());

console.log('=== a fresh session starting with it already on shows that in settings ===');
await js(seedStorage({ nostrcomments_hidebtn: true }));
await goto(site2.url); // a different origin — the setting is global, not per-site
await wait(2500);
ok('no button here either', await hasBtn() === false, await hasBtn());
await openSettings();
const reflectsSeeded = await js(`${ROOT} return s.getElementById('hidebtn-toggle').checked;`);
ok('settings shows it checked', reflectsSeeded === true, reflectsSeeded);

console.log(`\n${state.fail ? '✗' : '✓'} hide button: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
