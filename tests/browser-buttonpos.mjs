// Where the floating button sits, and getting it out of the way.
//
// Reported from real use: the button sometimes covers a menu or another control. Bottom right is
// not unlucky, it is contested — every support-chat widget defaults there, along with back-to-top
// buttons and cookie bars. So collisions are structural rather than occasional, and the fix has to
// be per site: moving it globally would trade one site's problem for every other site's.
//
// Dragging was considered and rejected. It needs a click-versus-drag threshold, touch handling and
// a stored position that can land off-screen at another window size, and almost nobody discovers
// it. Four corners give nearly all of the benefit with none of the ambiguity.
//
//   node tests/browser-buttonpos.mjs
//   NC_BROWSER=firefox node tests/browser-buttonpos.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9556);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8115);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8483);

const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Button position QA page' });

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncbp-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

// The button lives in its own shadow host, not the panel's.
const button = () => js(`
  const hosts = [...document.documentElement.children].filter(e => e.shadowRoot);
  for (const h of hosts) {
    const b = h.shadowRoot.getElementById('nc-btn');
    if (b) {
      const r = b.getBoundingClientRect(), st = getComputedStyle(b);
      return JSON.stringify({ classes: [...b.classList], w: Math.round(r.width), h: Math.round(r.height),
        left: Math.round(r.left), top: Math.round(r.top),
        right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom),
        shadow: st.boxShadow });
    }
  }
  return JSON.stringify({ missing: true });`);
const pick = corner => js(`${ROOT}
  const b = [...s.querySelectorAll('.btnpos')].find(x => x.dataset.c === ${JSON.stringify(corner)});
  if (!b) return 'no button';
  b.click(); return 'clicked';`);
const openSettings = async () => {
    await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn').click(); return 1;`);
    await wait(1200);
};

console.log('\n=== the default, and its size ===');
await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}` }));
await wait(1500);
let b = JSON.parse(await button());
ok('the button is there', !b.missing, b);
ok('it starts bottom right', b.classes.includes('nc-br'), b.classes);
ok('and it really is in that corner', b.right < 40 && b.bottom < 40, { right: b.right, bottom: b.bottom });
// 68px with a 35px glow is larger than a Material FAB and claims more of the page than a comment
// layer should while somebody is reading.
ok('it is no bigger than a standard floating action button', b.w <= 56 && b.h <= 56, { w: b.w, h: b.h });
ok('and the glow is not enormous', !/35px/.test(b.shadow), b.shadow);

console.log('\n=== moving it, on this site ===');
await openSettings();
ok('the picker offers the corner', (await pick('bl')) === 'clicked');
await wait(800);
b = JSON.parse(await button());
ok('it moves to bottom left', b.classes.includes('nc-bl'), b.classes);
ok('exactly one corner class is applied', b.classes.filter(c => /^nc-(tl|tr|bl|br)$/.test(c)).length === 1, b.classes);
ok('and it is measurably on the other side', b.left < 40 && b.bottom < 40, { left: b.left, bottom: b.bottom });

await openSettings();
await pick('tr');
await wait(800);
b = JSON.parse(await button());
ok('top right works too', b.classes.includes('nc-tr') && b.top < 40 && b.right < 40, b);

console.log('\n=== and it is remembered ===');
await goto(site.url);
await wait(3000);
b = JSON.parse(await button());
ok('a reload keeps the chosen corner', b.classes.includes('nc-tr'), b.classes);
ok('measured, not just labelled', b.top < 40 && b.right < 40, { top: b.top, right: b.right });

// The whole point of storing it per origin: a site where the button was in the way must not drag
// every other site along with it.
console.log('\n=== another site is unaffected ===');
const other = await startSite({ port: SITE_PORT + 1, heading: 'A different origin' });
await goto(other.url);
await wait(3500);
b = JSON.parse(await button());
ok('a different origin is still bottom right', b.classes.includes('nc-br'), b.classes);
ok('and measurably so', b.right < 40 && b.bottom < 40, { right: b.right, bottom: b.bottom });
other.close();

// --- the order of the two ways out ------------------------------------------------------------------
// Somebody whose button is in the way reads this section top to bottom. If the first thing they
// meet is "Disable on this site", that is what they press — turning off the extension they
// installed, to solve "move it a hundred pixels". The mild fix has to come first, and this is
// exactly the kind of order that flips back unnoticed during a later edit.
console.log('\n=== the mild fix is offered before the drastic one ===');
await goto(site.url);
await wait(2500);
await openSettings();
const order = JSON.parse(await js(`${ROOT}
  const all = [...s.querySelectorAll('*')];
  const row = s.getElementById('btnpos-row'), off = s.getElementById('site-disable-btn');
  return JSON.stringify({
    picker: all.indexOf(row), disable: all.indexOf(off),
    intro: s.getElementById('site-origin') ? s.getElementById('site-origin').parentElement.textContent : null });`));
ok('both controls are present', order.picker >= 0 && order.disable >= 0, order);
ok('the position picker comes first', order.picker < order.disable, order);
// The sentence above them has to describe both, not only the red button underneath it.
ok('the text covers moving it', /where the nostrcomments button sits/i.test(order.intro || ''), order.intro);
ok('and covers hiding it', /appears at all/i.test(order.intro || ''), order.intro);
ok('and names the site it applies to', /localhost|127\.0\.0\.1/.test(order.intro || ''), order.intro);

console.log(`\n${state.fail ? '✗' : '✓'} button position: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
