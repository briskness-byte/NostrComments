// The onboarding block, and the one button that could destroy a key without asking.
//
// "Start commenting — generate your key" writes a fresh private key straight to storage. Rotate and
// import both stop and confirm first, and offer to copy the current key; this one never asked,
// because it is only ever shown to people who have no key. That assumption held only as long as
// every path that gave you an identity remembered to take the block down, and importing a key from
// settings did not: the block stayed up behind the settings pane, offering to generate over the key
// that had just been imported. One click, no undo.
//
// Order matters here, and the first version of this file got it wrong twice. Generating a key first
// leaves the block already down, so "the block is down after importing" passed against the very bug
// it was written for. And a generate button that has already run stays disabled, so clicking it
// again proves nothing about the guard — the key survives because nothing happens. So: never let a
// section start from a state that makes the next assertion true for free.
//
//   node tests/browser-onboarding.mjs
//   NC_BROWSER=firefox node tests/browser-onboarding.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT, BROWSER } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9550);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8109);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8477);

const { _secp, toBech32, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Onboarding QA page' });

const MINE = newKey(), MINE_NPUB = toBech32('npub', _secp.pubKey(MINE));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncob-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

const st = () => js(`${ROOT}
  const ob = s.getElementById('onboard');
  return JSON.stringify({
    onboard: getComputedStyle(ob).display,
    buttons: [...ob.querySelectorAll('button')].map(b => b.textContent),
    npub: s.getElementById('identity-npub').textContent,
    msg: s.getElementById('msg').textContent });`);
const clickGenerate = () => js(`${ROOT}
  const b = [...s.getElementById('onboard').querySelectorAll('button')].find(x => /generate your key/i.test(x.textContent));
  if (!b) return 'no button';
  if (b.disabled) return 'disabled';
  b.click(); return 'clicked';`);
// Answer whichever confirmation is up, by the label on its button.
const confirmWith = label => js(`${ROOT}
  const ov = [...s.getElementById('p').children].find(c => c.style.zIndex === '30' && getComputedStyle(c).display !== 'none');
  if (!ov) return 'no dialog';
  const b = [...ov.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
  if (!b) return 'no button: ' + [...ov.querySelectorAll('button')].map(x => x.textContent).join('|');
  b.click(); return 'confirmed';`);

// --- with no key, the block is the way in ---------------------------------------------------------
console.log('\n=== with no identity the block is shown ===');
await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}` }));
await wait(1500);
await js(`${ROOT} s.getElementById('settings-close')?.click(); return 1;`);
await wait(800);
let r = JSON.parse(await st());
ok('the onboarding block is shown', r.onboard === 'block', r.onboard);
ok('and it offers to generate a key', r.buttons.some(b => /generate your key/i.test(b)), r.buttons);
ok('with no identity yet', r.npub === '', r.npub);

// The alternative to generating a key is installing a signer, and that link has to land somewhere
// with an install button. Which store depends on the build, so this asserts against the build
// actually under test rather than against whichever one was written first.
const wallets = JSON.parse(await js(`${ROOT}
  const ob = s.getElementById('onboard');
  return JSON.stringify({
    links: [...ob.querySelectorAll('a')].map(a => ({ text: a.textContent, href: a.href, target: a.target, rel: a.rel })),
    hint: [...ob.querySelectorAll('p')].map(p => p.textContent).join(' | ') });`));
const store = BROWSER === 'firefox' ? 'addons.mozilla.org' : 'chromewebstore.google.com';
const wrongStore = BROWSER === 'firefox' ? 'chromewebstore.google.com' : 'addons.mozilla.org';
ok('two signers are offered', wallets.links.length === 2, wallets.links.map(l => l.text));
ok(`both link to ${store}`, wallets.links.every(l => l.href.includes(store)), wallets.links.map(l => l.href));
ok('neither links to the other browser\'s store', !wallets.links.some(l => l.href.includes(wrongStore)), wallets.links.map(l => l.href));
ok('nobody is sent to a source repository', !wallets.links.some(l => /github\.com/.test(l.href)), wallets.links.map(l => l.href));
// Firefox has no nos2x — the port there has a different name and a different author.
ok('the label matches what they will land on',
   wallets.links.some(l => l.text === (BROWSER === 'firefox' ? 'nos2x-fox' : 'nos2x')), wallets.links.map(l => l.text));
ok('links open away from the page, without handing it a window reference',
   wallets.links.every(l => l.target === '_blank' && /noopener/.test(l.rel)), wallets.links.map(l => [l.target, l.rel]));
ok('and it says to reload afterwards', /Install it, then reload this page\./.test(wallets.hint), wallets.hint);

// --- importing takes it down, and this is the bug ---------------------------------------------------
// The block is up right now — that is what makes the next assertion mean anything. This path set the
// identity and repainted everything except the block, which stayed up until the panel was closed and
// reopened, offering to generate a key over the one that had just been imported.
console.log('\n=== importing a key takes the block down, without reopening the panel ===');
await js(`${ROOT}
  s.getElementById('gear-btn').click();
  s.getElementById('privkey-import').value=${JSON.stringify(toBech32('nsec', MINE))};
  s.getElementById('privkey-import-btn').click(); return 1;`);
await wait(2500);
r = JSON.parse(await st());
ok('the imported identity is in use', r.npub === MINE_NPUB, r.npub);
ok('and the block is down straight away', r.onboard === 'none', r.onboard);

// --- on screen anyway, it must refuse ----------------------------------------------------------------
// A reload builds a fresh, enabled button while the key sits in storage. That is the state a user is
// in, and the guarantee above is one line of code away from breaking again, so the button has to be
// safe on its own terms too.
console.log('\n=== on screen anyway, it refuses rather than overwrites ===');
await goto(site.url);
await wait(3000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(1500);
r = JSON.parse(await st());
ok('a reload knows the identity', r.npub === MINE_NPUB, r.npub);
ok('and does not offer to onboard', r.onboard === 'none', r.onboard);

await js(`${ROOT} s.getElementById('onboard').style.display='block'; return 1;`);
await wait(400);
ok('the block can be forced back on screen', JSON.parse(await st()).onboard === 'block');
ok('and the button there is live, not disabled', (await clickGenerate()) === 'clicked');
await wait(2500);
r = JSON.parse(await st());
ok('the stored identity is untouched', r.npub === MINE_NPUB, { now: r.npub, expected: MINE_NPUB });
ok('it says why nothing happened', /already a key stored/i.test(r.msg), r.msg);
ok('and it puts the stale block away', r.onboard === 'none', r.onboard);

// --- but it still works when it is supposed to --------------------------------------------------------
// A guard that always refuses would pass everything above. Deleting the key is also the other half of
// the same bug: that path has to bring the block back.
console.log('\n=== after deleting the key it comes back and works ===');
await js(`${ROOT} s.getElementById('gear-btn').click(); s.getElementById('privkey-delete').click(); return 1;`);
await wait(800);
ok('the delete asks first', (await confirmWith('Delete it')) === 'confirmed');
await wait(2000);
r = JSON.parse(await st());
ok('the identity is gone', r.npub === '', r.npub);
ok('and the block comes back on its own', r.onboard === 'block', r.onboard);

ok('the button is live again', (await clickGenerate()) === 'clicked');
await wait(3000);
r = JSON.parse(await st());
ok('a key is generated', /^npub1/.test(r.npub), r.npub);
ok('a different one from before', r.npub !== MINE_NPUB, r.npub);
ok('and the block takes itself down', r.onboard === 'none', r.onboard);
// This is the key in storage from here on; the imported one was deleted above.
const regenerated = r.npub;

// --- what happens straight after a key is made -------------------------------------------------------
// It used to open Settings and reveal the key on the spot. The reasoning was sound — the key exists
// in this browser and nowhere else — but the moment was wrong: somebody presses a button labelled
// "start commenting" and is handed a red warning block and a secret. Nothing is at stake yet either.
console.log('\n=== after generating a key, get out of the way ===');
const after = JSON.parse(await js(`${ROOT} return JSON.stringify({
  settings: getComputedStyle(s.getElementById('settings')).display,
  keyBox: getComputedStyle(s.getElementById('privkey-box')).display,
  keyField: s.getElementById('privkey-display').value,
  focused: s.activeElement ? s.activeElement.id : null,
  msg: s.getElementById('msg').textContent });`));
ok('settings is not opened', after.settings === 'none', after.settings);
ok('the key is not put on screen', after.keyBox === 'none' && after.keyField === '', after);
ok('the comment box has the focus instead', after.focused === 'input', after.focused);
ok('and it says they can comment', /can comment now/i.test(after.msg), after.msg);

// --- and the ask, moved to where the argument is true --------------------------------------------------
console.log('\n=== the backup ask comes after the first comment ===');
const dialog = () => js(`${ROOT}
  const ov = [...s.getElementById('p').children].find(c => c.style.zIndex === '30' && getComputedStyle(c).display !== 'none');
  if (!ov) return JSON.stringify({ open: false });
  return JSON.stringify({ open: true, text: ov.textContent,
                          buttons: [...ov.querySelectorAll('button')].map(b => b.textContent) });`);
ok('nothing is asked before anything is posted', JSON.parse(await dialog()).open === false);

await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'my first comment';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);
await wait(4000);
let d = JSON.parse(await dialog());
ok('after the first comment it asks', d.open === true, d);
ok('it explains what would be lost', /only in this browser/i.test(d.text || ''), (d.text || '').slice(0, 120));
ok('and offers to put it off', (d.buttons || []).some(b => /^Later$/.test(b)), d.buttons);
ok('rather than saying "Cancel"', !(d.buttons || []).some(b => /^Cancel$/.test(b)), d.buttons);

await js(`${ROOT}
  const ov = [...s.getElementById('p').children].find(c => c.style.zIndex === '30' && getComputedStyle(c).display !== 'none');
  const b = ov && [...ov.querySelectorAll('button')].find(x => /^Later$/.test(x.textContent));
  if (b) b.click(); return !!b;`);
await wait(1200);
ok('the dialog closes', JSON.parse(await dialog()).open === false);

// Once, not on every comment. A prompt that returns after each post is a prompt people learn to
// dismiss without reading.
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'a second comment';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);
await wait(4000);
ok('and it does not come back on the next comment', JSON.parse(await dialog()).open === false);

// The flag that stops it resets with the page, so on its own it asked again on every site where
// somebody posted their first comment. What makes it once is the stored timestamp.
await goto(site.url);
await wait(3000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(1500);
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'a comment after reloading';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);
await wait(4000);
ok('nor after a reload, which is where it used to start over', JSON.parse(await dialog()).open === false);

// --- chosen a signer, and the signer went away -----------------------------------------------------
// Reported from real use, and the dead end was created by the guard two sections above. Selecting
// the NIP-07 signer deliberately leaves a stored key unloaded. If that signer then stops answering
// nothing connects, the block stays up, and its only button refuses because a key already exists —
// so the panel holds a perfectly good key, will not use it, and offers no way to say so.
//
// Falling back to the stored key automatically is not the fix: posting as a different identity than
// the one somebody selected is the bug browser-signerchoice.mjs exists for. It has to be offered.
console.log('\n=== a chosen signer that stops answering is not a dead end ===');
await goto(site.url);
await wait(2500);
// Pick the signer while one exists, which is the only way the choice can be made at all.
await js(`window.nostr = { getPublicKey: async () => ${JSON.stringify(_secp.pubKey(newKey()))},
                           signEvent: async ev => ev }; return 1;`);
await wait(4000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn').click();
  s.getElementById('signer-nip07').click(); return 1;`);
await wait(2500);
// Now reload without it, the way a disabled or broken signer behaves.
await goto(site.url);
await wait(4000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(2000);

r = JSON.parse(await st());
ok('the block is shown, since nothing could connect', r.onboard === 'block', r.onboard);
const stranded = JSON.parse(await js(`${ROOT}
  const ob = s.getElementById('onboard');
  return JSON.stringify({
    buttons: [...ob.querySelectorAll('button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.textContent),
    pitch: [...ob.querySelectorAll('p')].map(p => p.textContent).join(' | ') });`));
ok('it offers the key that is already stored', stranded.buttons.some(b => /use the key stored here/i.test(b)), stranded.buttons);
ok('and stops offering to generate one that would be refused',
   !stranded.buttons.some(b => /generate your key/i.test(b)), stranded.buttons);
ok('it says the signer is the reason', /not answering/i.test(stranded.pitch), stranded.pitch);

await js(`${ROOT}
  const b = [...s.getElementById('onboard').querySelectorAll('button')].find(x => /use the key stored here/i.test(x.textContent));
  if (b) b.click(); return !!b;`);
await wait(3000);
r = JSON.parse(await st());
ok('pressing it connects with the stored key', r.npub === regenerated, { now: r.npub, expected: regenerated });
ok('and the block goes away', r.onboard === 'none', r.onboard);

console.log(`\n${state.fail ? '✗' : '✓'} onboarding: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
