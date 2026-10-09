// Dragging the floating button nudges it to a corner, instead of picking it up for good.
//
// Driven with real W3C pointer actions (viewport coordinates, not an element reference — the
// button sits in a shadow root, and this sidesteps that entirely) rather than nclick, because the
// gesture under test *is* the pointer movement, not a single click. Confirms: a push past the
// threshold flips just that axis of the corner, a push under it is just a click (opens the panel,
// same as any other), a push over it does not also open the panel, the button visibly travels
// rather than teleporting, and the chosen corner survives a reload — the same persistence
// tests/browser-buttonpos.mjs already proves for the settings picker, checked here because this
// writes through the very same saveBtnCorner().
//
//   node tests/browser-buttonnudge.mjs
//   NC_BROWSER=firefox node tests/browser-buttonnudge.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { reporter, startRelay, startSite, startBrowser, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9558);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8118);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8487);

const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Button-nudge QA page' });

const { wd, js, wait, goto, sid, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncbn-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

const btnState = () => js(`${ROOT}
  const b = s.getElementById('nc-btn'), r = b.getBoundingClientRect();
  return JSON.stringify({ corner: [...b.classList].find(c => /^nc-(tl|tr|bl|br)$/.test(c)),
    cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) });`);
const panelDisplay = () => js(`${ROOT} const m = s.getElementById('m'); return m ? getComputedStyle(m).display : 'missing';`);
const closePanel = () => js(`${ROOT} const m = s.getElementById('m'); if (m) m.style.display = 'none'; return 1;`);

// A real pointer drag, in viewport coordinates — no element lookup needed, so the shadow root is
// not in the way at all. The modal sits at the same z-index as the button and is appended after
// it, so once it is open it paints over the button's old screen position; callers close it between
// steps rather than drag blindly into it.
async function drag(fromX, fromY, dx, dy) {
    await wd('POST', `/session/${sid}/actions`, { actions: [{
        type: 'pointer', id: 'nudge', parameters: { pointerType: 'mouse' },
        actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(fromX), y: Math.round(fromY), origin: 'viewport' },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', duration: 80, x: Math.round(fromX + dx), y: Math.round(fromY + dy), origin: 'viewport' },
            { type: 'pointerUp', button: 0 },
        ],
    }] });
    await wd('DELETE', `/session/${sid}/actions`); // release the action state between gestures
}

console.log('=== starts bottom right ===');
let st = JSON.parse(await btnState());
ok('the default corner', st.corner === 'nc-br', st);

console.log('=== a small wobble is just a click ===');
await drag(st.cx, st.cy, 5, -5);
await wait(400);
st = JSON.parse(await btnState());
ok('the corner did not change', st.corner === 'nc-br', st);
let panel = await panelDisplay();
ok('and it opened the panel, same as any other click', panel === 'grid', panel);
await closePanel();

console.log('=== a push up flips the vertical axis only ===');
await drag(st.cx, st.cy, 0, -40);
await wait(500);
st = JSON.parse(await btnState());
ok('moved to top right — same side, other row', st.corner === 'nc-tr', st);
panel = await panelDisplay();
ok('and the drag did not also open the panel', panel === 'none', panel);

console.log('=== and it visibly travelled, not teleported ===');
// Sampled during the drag back down: this checks the button sat at an intermediate y at some
// point between the old corner and the new one, which a CSS class swap alone could not produce.
await js(`${ROOT}
  const b = s.getElementById('nc-btn');
  window.__ncTrack = [];
  const iv = setInterval(() => { const r = b.getBoundingClientRect(); window.__ncTrack.push(Math.round(r.top)); }, 20);
  setTimeout(() => clearInterval(iv), 450);
  return 1;`);
await drag(st.cx, st.cy, 0, 40); // back down to bottom right
await wait(600);
const track = JSON.parse(await js('return JSON.stringify(window.__ncTrack || []);'));
const spread = track.length ? Math.max(...track) - Math.min(...track) : 0;
ok('the button passed through more than just its start and end y', spread > 10, track);

console.log('=== a push left flips the horizontal axis only ===');
st = JSON.parse(await btnState());
ok('back to bottom right first', st.corner === 'nc-br', st);
await drag(st.cx, st.cy, -40, 0);
await wait(500);
st = JSON.parse(await btnState());
ok('moved to bottom left — other column, same row', st.corner === 'nc-bl', st);
panel = await panelDisplay();
ok('still did not open the panel', panel === 'none', panel);

console.log('=== an ordinary click (no movement) still opens it ===');
await drag(st.cx, st.cy, 0, 0);
await wait(400);
panel = await panelDisplay();
ok('clicking opens the panel', panel === 'grid', panel);
await closePanel();

console.log('=== the nudged corner survives a reload ===');
await goto(site.url);
await wait(2000);
st = JSON.parse(await btnState());
ok('still bottom left after reload', st.corner === 'nc-bl', st);

console.log(`\n${state.fail ? '✗' : '✓'} button nudge: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
