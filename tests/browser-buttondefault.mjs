// A global default corner for sites the reader has never placed the button on themselves.
//
// "Use this corner on every new site" in settings writes nostrcomments_btndefault; a fresh origin
// with no entry of its own in nostrcomments_btnpos falls back to that instead of always bottom
// right. A site already placed — through the picker or a drag — keeps its own choice regardless.
//
//   node tests/browser-buttondefault.mjs
//   NC_BROWSER=firefox node tests/browser-buttondefault.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { reporter, startRelay, startSite, startBrowser, seedStorage, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9559);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8122);
const SITE2_PORT = SITE_PORT + 1;
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8488);

const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Button-default QA page' });
const site2 = await startSite({ port: SITE2_PORT, heading: 'A second, never-visited origin' });

const { js, nclick, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncbd-',
    onClose: () => { site.close(); site2.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

const corner = () => js(`${ROOT}
  const b = s.getElementById('nc-btn');
  return [...b.classList].find(c => /^nc-(tl|tr|bl|br)$/.test(c));`);
const openSettings = async () => {
    await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn').click(); return 1;`);
    await wait(1000);
};

console.log('=== with no default set, a fresh site still starts bottom right ===');
let c = await corner();
ok('bottom right by default', c === 'nc-br', c);

console.log('=== moving it here, then setting that as the default ===');
await openSettings();
await nclick("[...s.querySelectorAll('.btnpos')].find(b => b.dataset.c === 'tl')");
await wait(400);
c = await corner();
ok('moved to top left on this site', c === 'nc-tl', c);
const defaultBtnText = () => js(`${ROOT} return s.getElementById('btndefault-btn').textContent;`);
let label = await defaultBtnText();
ok('the default button offers to adopt it', /Use this corner/.test(label), label);
await nclick("s.getElementById('btndefault-btn')");
await wait(400);
label = await defaultBtnText();
ok('and then shows it is the default', /Default for new sites/.test(label), label);

console.log('=== a second, never-visited site picks up the new default ===');
await goto(site2.url);
await wait(2500);
c = await corner();
ok('starts top left — the new default, not bottom right', c === 'nc-tl', c);

console.log('=== going back to the first site, its own choice is unaffected ===');
await goto(site.url);
await wait(2500);
c = await corner();
ok('still top left (its own setting, same value here, but read from its own entry)', c === 'nc-tl', c);

console.log('=== a site with its own, different choice is not overridden by the default ===');
await openSettings();
await nclick("[...s.querySelectorAll('.btnpos')].find(b => b.dataset.c === 'br')");
await wait(400);
await goto(site.url);
await wait(2500);
c = await corner();
ok('this site keeps its own bottom-right, despite the top-left default', c === 'nc-br', c);
await goto(site2.url);
await wait(2500);
c = await corner();
ok('the other site is still unaffected, still the default', c === 'nc-tl', c);

console.log(`\n${state.fail ? '✗' : '✓'} button default: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
