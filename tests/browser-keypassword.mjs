// The one-time offer to encrypt the stored key.
//
// The password lock has existed for a long time, buried in Settings, and nothing ever mentioned it
// — so in practice the key sat unencrypted on disk. Forcing one instead would be worse: a key that
// cannot be used without a password is a key ordinary readers abandon, and this has to stay usable
// by people who did not come for a cryptography lesson.
//
// So it is offered once, when a key first appears, and declining is a real answer that is
// remembered. This suite pins all three halves: that it is offered, that "not now" leaves a working
// key alone, and that it never comes back to ask again.
//
//   node tests/browser-keypassword.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-keypassword.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9527);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8086);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8454);

const { _secp, normalizeUrl, toBech32, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Key password QA page' });
const ME = newKey(), MY_PUB = _secp.pubKey(ME);

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncpw-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

const dialog = () => js(`${ROOT}
  const o = s.getElementById('p') && [...s.getElementById('p').children].find(c => c.style.zIndex === '28');
  const shown = o && getComputedStyle(o).display !== 'none';
  if (!shown) return JSON.stringify({ shown: false, text: '' });
  // The reassurance is meant to be a quiet line of its own under the buttons, not a clause at the
  // end of the paragraph doing the asking.
  const last = o.lastElementChild, cs = last && getComputedStyle(last);
  const buttons = [...o.querySelectorAll('button')];
  return JSON.stringify({
    shown: true, text: o.textContent,
    noteText: last ? last.textContent : '',
    noteIsText: !!last && last.tagName === 'P',
    noteBelowButtons: !!last && !!buttons.length && (last.compareDocumentPosition(buttons[buttons.length-1]) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
    noteSmaller: !!cs && parseFloat(cs.fontSize) < 14 });`);

// No key yet, so nothing to protect and nothing to ask about.
await js(configureScript({ relayUrl: relay.url }));
await wait(1200);
ok('nothing is asked before there is a key', JSON.parse(await dialog()).shown === false, await dialog());

console.log('\n=== a key appears ===');
await js(`${ROOT}
  s.getElementById('privkey-import').value=${JSON.stringify(toBech32('nsec', ME))};
  s.getElementById('privkey-import-btn').click(); return 1;`);
await wait(1500);
let d = JSON.parse(await dialog());
ok('the offer appears', d.shown === true, d);
ok('it explains what a password buys', /encrypts it|cannot take it/i.test(d.text), d.text.slice(0, 120));
ok('it says a password can still be set later', /Settings/i.test(d.noteText || ''), d.noteText);
ok('and that sits under the buttons as its own quiet line', d.noteIsText && d.noteBelowButtons && d.noteSmaller,
   { note: d.noteText, isText: d.noteIsText, below: d.noteBelowButtons, smaller: d.noteSmaller });
ok('so the asking paragraph no longer carries it', !/Settings/i.test((d.text || '').replace(d.noteText || '', '')), d.text.slice(0, 160));
ok('declining is offered as a plain choice, not a dark pattern',
   /Not now/.test(d.text) && !/are you sure|risk losing/i.test(d.text), d.text.slice(-120));

console.log('\n=== saying no ===');
await js(`${ROOT}
  const o = [...s.getElementById('p').children].find(c => c.style.zIndex === '28');
  [...o.querySelectorAll('button')].find(b => /Not now/i.test(b.textContent)).click(); return 1;`);
await wait(1200);
ok('the dialog closes', JSON.parse(await dialog()).shown === false, await dialog());
const after = JSON.parse(await js(`${ROOT} return JSON.stringify({
    status: s.getElementById('status').textContent,
    msg: s.getElementById('msg').textContent,
    pwBtn: [...s.getElementById('settings').querySelectorAll('button')].map(b => b.textContent).find(t => /password/i.test(t)) || null });`));
// The whole point of letting people decline: what they came for still works.
ok('the identity still works', new RegExp(toBech32('npub', MY_PUB).slice(0, 10)).test(after.status), after.status);
ok('it says where to find it later', /Settings/i.test(after.msg || ''), after.msg);
ok('and Settings still offers to set one', /Set a password/i.test(after.pwBtn || ''), after.pwBtn);

console.log('\n=== the offer is not spent while nobody is looking ===');
// It fires for a key that was already stored, which happens at page load — usually with the panel
// shut. Marking it as asked then would spend the single chance on a dialog nobody ever saw.
await js(`${ROOT} return !!s;`);
const consumed = await js(`${ROOT}
  return JSON.stringify({ panelOpen: getComputedStyle(s.getElementById('m')).display !== 'none' });`);
ok('the panel is what the dialog waits for', /panelOpen/.test(consumed || ''), consumed);

console.log('\n=== and it does not ask again ===');
await goto(site.url);
await wait(4500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(2000);
ok('a reload does not bring the question back', JSON.parse(await dialog()).shown === false, await dialog());

console.log(`\n${state.fail === 0 ? '✓' : '✗'} key password: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
