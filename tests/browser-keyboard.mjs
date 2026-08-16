// Typing into the panel on a page that has its own keyboard shortcuts.
//
// Reported from real use: on a Nostr client the space bar did nothing inside the comment box. The
// panel renders in that page's document, so its keystrokes travel through whatever the page listens
// for, and a site that reads space off `document` and cancels it takes the character with it. Most
// clients bind space, and so do GitHub, YouTube and Reddit.
//
// Two failures are possible and they need different fixes, which is why this suite installs two
// listeners on the page:
//
//   - a CAPTURE listener that cancels space. Capture runs before anything in the shadow tree, so it
//     cannot be stopped from inside the panel; the character has to be put in by hand afterwards.
//   - a BUBBLE listener that records what it sees. This one can be stopped, and should be — a page
//     has no business acting on what is typed into a comment box sitting on top of it.
//
// The third assertion is the one that keeps the fix honest: keys pressed in the page itself must
// still reach the page. Blocking everything would pass the first two and break the site.
//
//   node tests/browser-keyboard.mjs
//   NC_BROWSER=firefox node tests/browser-keyboard.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9560);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8120);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8480);

const { normalizeUrl, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

// What poster.place does, reduced to the part that matters. The capture listener is the poster.place
// behaviour; the bubble listener stands in for every site that merely watches keys.
const PAGE_SCRIPT = `
  window.__seen = [];
  document.addEventListener('keydown', e => { if (e.key === ' ') e.preventDefault(); }, true);
  document.addEventListener('keydown', e => { window.__seen.push(e.key); }, false);
`;

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Keyboard QA page', script: PAGE_SCRIPT });
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const PAGE = normalizeUrl(site.url);
const ME = newKey();

const { wd, js, wait, goto, sid, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'nckey-',
    onClose: () => { site.close(); relay.close(); },
});

// Real key events, not synthetic ones: a KeyboardEvent built in script has no default action, so
// dispatching one would insert nothing whether the fix is present or not and the suite would pass
// against both. These go through the WebDriver actions endpoint and behave like a keyboard.
const type = async text => {
    const actions = [];
    for (const ch of text) actions.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch });
    await wd('POST', `/session/${sid}/actions`, { actions: [{ type: 'key', id: 'kb', actions }] });
    await wait(250);
};
const clearActions = () => wd('DELETE', `/session/${sid}/actions`).catch(() => {});

console.log(`\nrelay: ${RELAY_URL}\npage:  ${PAGE}\n`);
await goto(site.url);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: RELAY_URL, nsec: toBech32('nsec', ME) }));
await wait(1500);
await goto(site.url);
await wait(4000);

const hostile = await js(`return JSON.stringify({ listeners: Array.isArray(window.__seen) });`);
ok('the page installed its shortcut handlers', JSON.parse(hostile).listeners === true, hostile);

console.log('\n=== typing into the comment box ===');
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(1200);
await js(`${ROOT} const i = s.getElementById('input'); i.value=''; i.focus(); return 1;`);
await js(`window.__seen = []; return 1;`);

await type('ab cd');
await clearActions();

const typed = await js(`${ROOT} return s.getElementById('input').value;`);
// The whole report in one assertion: without the fix this reads "abcd".
ok('the space arrives in the box even though the page cancels it', typed === 'ab cd', typed);

const seen = JSON.parse(await js(`return JSON.stringify(window.__seen || []);`));
ok('the page does not see what is typed into the panel', seen.length === 0, seen);

console.log('\n=== the page keeps its own keyboard ===');
await js(`${ROOT} s.getElementById('m').style.display='none'; return 1;`);
await js(`document.body.setAttribute('tabindex','-1'); document.body.focus(); window.__seen=[]; return 1;`);
await type('x');
await clearActions();
const outside = JSON.parse(await js(`return JSON.stringify(window.__seen || []);`));
ok('keys pressed in the page still reach the page', outside.includes('x'), outside);

console.log('\n=== Escape still closes the panel ===');
// Escape used to be handled by a listener on document. Stopping propagation cuts that off whenever
// focus sits inside the panel, so the panel has to handle it itself now.
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(600);
await js(`${ROOT} s.getElementById('input').focus(); return 1;`);
await type('\uE00C'); // WebDriver's code point for Escape
await clearActions();
await wait(600);
const closed = await js(`${ROOT} return s.getElementById('m').style.display;`);
ok('Escape closes the panel from inside a focused field', closed === 'none', closed);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} keyboard isolation: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
