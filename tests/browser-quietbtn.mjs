// Quiet mode: the floating button only on pages that have something to see.
//
// A reader removed the extension in Oct 2026 over the floating button, without ever finding the
// options that already existed. Quiet mode is offered where somebody annoyed by the button looks —
// a small − next to the × that appears on hover — and in Settings. It is off by default, because
// every thread starts with somebody seeing the button on a page nobody has commented on yet.
//
// Confirms: the button shows on an empty page by default; a page cannot switch quiet mode on for
// the reader; a real click on − hides the button on an empty page without opening the panel, and
// that survives a reload; a page with comments still shows the button, badge and all; and turning
// quiet mode off in Settings brings the button back on the empty page.
//
//   node tests/browser-quietbtn.mjs
//   NC_BROWSER=firefox node tests/browser-quietbtn.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9593);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8153);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8513);

const { normalizeUrl, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored } = relay;
const site = await startSite({ port: SITE_PORT, heading: 'Quiet-mode QA page' });
// The test site serves the same document at every path; the extension files threads by address,
// so these are two different pages as far as it is concerned.
const BUSY = site.url + 'with-comments';
const EMPTY = site.url + 'nobody-here-yet';
const now = Math.floor(Date.now() / 1000);
for (const [i, text] of ['First comment on the busy page.', 'Second one.'].entries())
    stored.push(await sign(newKey(), {
        kind: 1111, created_at: now - 300 + i,
        tags: [['I', normalizeUrl(BUSY)], ['K', 'web'], ['i', normalizeUrl(BUSY)], ['k', 'web']],
        content: text,
    }));

const { js, nclick, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncquiet-',
    onClose: () => { site.close(); relay.close(); },
});

const btnThere = () => js(`${ROOT} return !!s.getElementById('nc-btn');`);
// Polled: the button can come and go while relays answer, so one look after a fixed wait proves
// little either way.
const settle = async (want, ms = 12000) => {
    let v;
    for (let t = 0; t < ms; t += 400) { v = await btnThere(); if (v === want) return v; await wait(400); }
    return v;
};

console.log('=== setup ===');
await goto(EMPTY);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }
await js(configureScript({ relayUrl: relay.url }));
await wait(1500);

console.log('\n=== off by default ===');
await goto(EMPTY);
await wait(3000);
ok('the button shows on a page with no comments', await settle(true) === true);
const q = JSON.parse(await js(`${ROOT}
  const b = s.getElementById('nc-quiet');
  return JSON.stringify(b ? { display: getComputedStyle(b).display, title: b.title } : { missing: true });`) || '{}');
ok('the − control exists next to ×', q.missing !== true, q);
ok('and is hidden until the button is hovered', q.display === 'none', q);

console.log('\n=== a page cannot switch it on for the reader ===');
await js(`${ROOT} s.getElementById('nc-btn').dispatchEvent(new MouseEvent('mouseenter')); return 1;`);
await js(`${ROOT} s.getElementById('nc-quiet').click(); return 1;`); // untrusted, from script
await wait(800);
ok('the button is still there', await btnThere() === true);
await goto(EMPTY);
await wait(3000);
ok('and still there after a reload — nothing was saved', await settle(true) === true);

console.log('\n=== a real click on − hides it here, without opening the panel ===');
await js(`${ROOT} s.getElementById('nc-btn').dispatchEvent(new MouseEvent('mouseenter')); return 1;`);
// Diagnostics, printed with NC_DEBUG=1. They found the first bug here: − was on top at its own
// middle, yet the click went to the button — pointerdown on −, pointerup on btn, because the drag
// code captured the pointer for everything but ×. What is on top at each control's middle:
const _geo = (await js(`${ROOT}
  const at = id => { const el = s.getElementById(id), r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2, top = s.elementFromPoint(x, y);
    return id + ' ' + [r.left, r.top, r.width, r.height].map(Math.round).join(',') + ' top=' + (top ? (top.id || top.tagName) : 'none'); };
  const b = s.getElementById('nc-btn').getBoundingClientRect();
  return ['btn ' + [b.left, b.top, b.width, b.height].map(Math.round).join(','), at('nc-dismiss'), at('nc-quiet')].join(' | ');`));
if (process.env.NC_DEBUG) console.log('  geometry:', _geo);
// And every event the click produces, recorded from the page's side (the shadow root is open).
await js(`${ROOT} window.__ncLog = [];
  for (const t of ['pointerdown','pointerup','mousedown','mouseup','click','keydown','keyup'])
    s.addEventListener(t, e => window.__ncLog.push(t + '@' + (e.target.id || e.target.tagName) + (e.isTrusted ? '' : '(untrusted)')), true);
  return 1;`);
const clicked = await nclick("s.getElementById('nc-quiet')");
await wait(600);
if (process.env.NC_DEBUG) console.log('  nclick returned:', clicked, '| events:', await js(`return (window.__ncLog || []).join(' ');`));
ok('the button is gone from the empty page', await settle(false, 4000) === false);
const modal = await js(`${ROOT} return getComputedStyle(s.getElementById('m')).display;`);
ok('the panel did not open', modal === 'none', modal);
await goto(EMPTY);
await wait(3000);
ok('it stays gone after a reload', await settle(false, 6000) === false);

console.log('\n=== a page with comments still gets the button ===');
await goto(BUSY);
await wait(3000);
ok('the button appears once the comments are in', await settle(true, 15000) === true);
const badge = await js(`${ROOT} const b = s.getElementById('nc-badge'); return b ? b.textContent + '/' + b.style.display : null;`);
ok('with its comment count', /^2\/block$/.test(badge || ''), badge);

console.log('\n=== Settings turns it off again ===');
// Opening the panel and Settings are not guarded controls; the checkbox is.
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn')?.click(); return 1;`);
await wait(1200);
const checked = await js(`${ROOT} return s.getElementById('quietbtn-toggle').checked;`);
ok('the Settings checkbox shows quiet mode as on', checked === true, checked);
await nclick("s.getElementById('quietbtn-toggle')");
await wait(800);
await goto(EMPTY);
await wait(3000);
ok('the button is back on the empty page', await settle(true) === true);

console.log(`\n${state.fail ? '✗' : '✓'} quiet mode: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
