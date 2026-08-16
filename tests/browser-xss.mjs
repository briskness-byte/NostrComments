// Hostile content, rendered.
//
// Everything the panel draws comes from strangers: comment text, the name on a profile, the address
// of an avatar. None of it is escaped anywhere, because none of it is ever parsed as markup — the
// panel builds its DOM with createElement and textContent, and the one template it does parse is a
// static literal with no interpolation in it.
//
// That holds today. Nothing made it hold. A single innerHTML added in passing would undo all of it
// silently, and this codebase has twice shipped a defence that quietly stopped working: signature
// verification sat dead for eleven versions, and the contrast suite passed for eleven more while
// measuring the wrong four elements. A defence nobody measures is a defence that leaves.
//
// So this suite is written from the attacker's seat. It publishes payloads that would fire if any
// of the four rules broke, and then looks for the marker in the page's own window — inline handlers
// evaluate there, so it is the right place to catch one.
//
//   node tests/browser-xss.mjs
//   NC_BROWSER=firefox node tests/browser-xss.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9570);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8130);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8490);

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored } = relay;
const site = await startSite({ port: SITE_PORT, heading: 'XSS QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);

const ME = newKey();
const ATTACKER = newKey(), ATTACKER_PUB = _secp.pubKey(ATTACKER);

// The marker each payload tries to set. One name, so a single check covers all of them and a new
// payload needs no new assertion.
const M = 'window.__xss=1';

const PAYLOADS = [
    ['a tag with an event handler',      `<img src=x onerror="${M}">`],
    ['a script element',                 `<script>${M}</script>`],
    ['a closing tag then a handler',     `"><svg onload="${M}">`],
    ['a javascript: markdown link',      `[click me](javascript:${M})`],
    ['a javascript: bare URL',           `javascript:${M}`],
    ['a data: URL that is markup',       `data:text/html,<script>${M}</script>`],
    ['a javascript: link dressed as an image', `[pic](javascript:${M})`],
    ['an image URL with a handler after it',  `https://example.invalid/a.png" onerror="${M}`],
];

for (let i = 0; i < PAYLOADS.length; i++)
    stored.push(await sign(ATTACKER, {
        kind: 1111, created_at: now - 900 + i,
        tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
        content: PAYLOADS[i][1],
    }));

// The profile is a second surface entirely: the name is drawn as the author of every comment above,
// and the picture becomes an <img src> without ever passing through the URL check that comment text
// goes through.
stored.push(await sign(ATTACKER, {
    kind: 0, created_at: now - 800,
    tags: [],
    content: JSON.stringify({
        name: `<img src=x onerror="${M}">`,
        display_name: `<script>${M}</script>`,
        picture: `javascript:${M}`,
        nip05: `<script>${M}</script>@example.invalid`,
        about: `<img src=x onerror="${M}">`,
    }),
}));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncxss-',
    onClose: () => { site.close(); relay.close(); },
});

console.log(`\nrelay: ${relay.url}\npage:  ${PAGE}\n`);
await goto(site.url);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);
await goto(site.url);
await wait(3000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);

// Poll for the thread rather than sleeping: asserting before the relay answers would find an empty
// panel and report every payload as harmless.
let count = 0;
for (let i = 0; i < 25; i++) {
    count = await js(`${ROOT} return s.getElementById('list').querySelectorAll('.c').length;`);
    if (count >= PAYLOADS.length) break;
    await wait(600);
}
ok(`all ${PAYLOADS.length} hostile comments rendered`, count >= PAYLOADS.length, count);
if (!count) { console.log('\nNothing rendered; the rest would pass vacuously. Aborting.'); await finish(1); }

console.log('\n=== did anything run ===');
// Inline handlers evaluate in the page's own world, which is where this runs.
const fired = await js(`return typeof window.__xss;`);
ok('no payload executed', fired === 'undefined', fired);

console.log('\n=== what the panel actually built ===');
const shape = JSON.parse(await js(`${ROOT}
  const all = [...s.querySelectorAll('*')];
  const handlerAttrs = [];
  for (const el of all)
    for (const a of el.attributes)
      if (/^on/i.test(a.name)) handlerAttrs.push(el.tagName.toLowerCase() + '[' + a.name + ']');
  const bad = u => /^(javascript|data|vbscript):/i.test((u || '').trim());
  return JSON.stringify({
    scripts: s.querySelectorAll('script').length,
    svgInjected: s.querySelectorAll('svg[onload]').length,
    handlerAttrs,
    badHrefs: [...s.querySelectorAll('a')].map(a => a.getAttribute('href')).filter(bad),
    badSrcs:  [...s.querySelectorAll('img,video,iframe,embed,object')].map(e => e.getAttribute('src')).filter(bad),
    iframes: s.querySelectorAll('iframe,object,embed').length,
  });`));

// A <script> inserted through innerHTML never executes, so counting execution alone would miss the
// case where markup is being parsed but happens to be inert. These say the markup was never built.
ok('no script element was created', shape.scripts === 0, shape.scripts);
ok('no svg carrying a handler', shape.svgInjected === 0, shape.svgInjected);
ok('no on* attribute anywhere in the panel', shape.handlerAttrs.length === 0, shape.handlerAttrs);
ok('no javascript:/data: link', shape.badHrefs.length === 0, shape.badHrefs);
ok('no javascript:/data: image or media source', shape.badSrcs.length === 0, shape.badSrcs);
ok('no iframe, object or embed', shape.iframes === 0, shape.iframes);

console.log('\n=== the payloads are shown as what they are ===');
const text = await js(`${ROOT} return s.getElementById('list').textContent;`);
for (const [name, payload] of PAYLOADS) {
    // Only the distinctive head of each payload: the renderer may split a line at a URL boundary,
    // and asserting on the whole string would fail for a reason that is not a security one.
    const needle = payload.slice(0, 18);
    ok(`${name} is printed, not interpreted`, text.includes(needle), needle);
}

console.log('\n=== the author name is a name, not markup ===');
const nameInfo = JSON.parse(await js(`${ROOT}
  const el = s.querySelector('.nc-name');
  return JSON.stringify({ text: el ? el.textContent : null, kids: el ? el.children.length : -1 });`));
ok('the hostile display name is rendered as text', (nameInfo.text || '').includes('<img'), nameInfo.text);
ok('and it produced no child elements', nameInfo.kids === 0, nameInfo.kids);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} XSS: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
