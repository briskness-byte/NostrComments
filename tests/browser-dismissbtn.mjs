// The small "turn off on this site" control on the floating button itself.
//
// Shown only on hover, so visibility is toggled first (dispatching mouseenter directly — that
// handler carries no trust gate, it only changes what is painted), then a trusted click is driven
// the same way the harness drives every other guarded control. Confirms: a page cannot trigger it
// on its own (same reasoning as "disable on this site" in settings — a page switching itself off is
// exactly what this extension exists to prevent), a real click disables the site without also
// opening the panel (it sits inside the button, so the click would otherwise bubble into
// btn.onclick), and the existing re-enable affordance picks it back up after a reload.
//
//   node tests/browser-dismissbtn.mjs
//   NC_BROWSER=firefox node tests/browser-dismissbtn.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { reporter, startRelay, startSite, startBrowser, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9557);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8117);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8486);

const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Dismiss-button QA page' });

const { js, nclick, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncdb-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

const dismissState = () => js(`${ROOT}
  const b = s.getElementById('nc-dismiss');
  if (!b) return JSON.stringify({ missing: true });
  return JSON.stringify({ display: getComputedStyle(b).display, title: b.title });`);

console.log('=== hidden until hovered ===');
let d = JSON.parse(await dismissState());
ok('the control exists', d.missing !== true, d);
ok('it is hidden by default', d.display === 'none', d);

console.log('=== a page cannot click it for the reader ===');
await js(`${ROOT} s.getElementById('nc-btn').dispatchEvent(new MouseEvent('mouseenter')); return 1;`);
await js(`${ROOT} s.getElementById('nc-dismiss').click(); return 1;`); // untrusted, from script
await wait(500);
let stillThere = await js(`${ROOT} return !!s.getElementById('nc-btn');`);
ok('the button is still there — the page could not disable it', stillThere === true, stillThere);
const panelStillClosed = await js(`${ROOT} const m = s.getElementById('m'); return m ? getComputedStyle(m).display : 'missing';`);
ok('and the panel did not open either', panelStillClosed === 'none', panelStillClosed);

console.log('=== a real click turns it off, without opening the panel ===');
await js(`${ROOT} s.getElementById('nc-btn').dispatchEvent(new MouseEvent('mouseenter')); return 1;`);
d = JSON.parse(await dismissState());
ok('visible once hovered', d.display !== 'none', d);
// Polled rather than checked once after a wait: the click's handler disables the site and removes
// the whole shadow host at the end, so by the time a single later check runs there is nothing left
// to find either way — a bug where the click bubbles into btn.onclick too (opening the panel before
// the host is removed) and a correctly-stopped click both end up looking the same afterwards. This
// samples the modal's display in the brief window before removal, to catch the transient "grid" a
// doubled click would produce.
const pollScript = `
  const host=[...document.documentElement.children].find(e=>e.shadowRoot&&e.shadowRoot.getElementById('nc-dismiss'));
  if (!host) return JSON.stringify({ gone: true });
  const m = host.shadowRoot.getElementById('m');
  return JSON.stringify({ gone: false, display: m ? getComputedStyle(m).display : 'missing' });`;
await nclick("s.getElementById('nc-dismiss')");
let sawOpen = false, endedGone = false;
for (let i = 0; i < 40; i++) {
    const r = JSON.parse(await js(pollScript));
    if (r.gone) { endedGone = true; break; }
    if (r.display === 'grid') sawOpen = true;
    await wait(15);
}
ok('the panel never opened, even transiently', sawOpen === false, sawOpen);
ok('the button (and panel) are gone from this page', endedGone === true, endedGone);

console.log('=== a reload shows the existing re-enable affordance ===');
await goto(site.url);
await wait(2000);
const reEnable = await js(`
  for (const h of [...document.documentElement.children].filter(e => e.shadowRoot)) {
    const b = h.shadowRoot.querySelector('button');
    if (b && b.title && b.title.includes('re-enable')) return true;
  }
  return false;`);
ok('the small re-enable button appears on the next load', reEnable === true, reEnable);

console.log(`\n${state.fail ? '✗' : '✓'} dismiss button: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
