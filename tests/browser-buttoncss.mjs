// The floating button and its badges, against the host page's own stylesheet.
//
// The panel has always been isolated in a shadow root. The button was not — it hung in the page's
// DOM, where the site's CSS applied to it like any other element. That is not a hypothetical:
//
//   span{position:static !important}   folded both badges into the middle of the button,
//                                      with the notification badge to the RIGHT of the count
//   span[id]{display:none !important}  removed both badges entirely
//   *{padding:0}                       shrank them and moved the count
//   svg{width:100%}                    blew the speech-bubble icon up from 36px to the full button,
//                                      which is how it was noticed — the icon looked a different
//                                      size from one site to the next
//   svg{display:none}                  removed the icon, leaving a blank blue circle
//
// None of those are attacks. They are the kind of rule ordinary sites carry, and they are why the
// button looked different from one site to the next — which is exactly how this was found.
//
// The pages below are served with real stylesheets and the geometry is measured, because the
// question "can the page reach this element" is not answerable by reading the CSS.
//
//   node tests/browser-buttoncss.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-buttoncss.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import http from 'http';
import { extensionCode, reporter, startRelay, startBrowser, configureScript, ROOT, BADGE } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9540);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8099);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8467);

const { normalizeUrl, toBech32, sign, newKey } = extensionCode();
const { ok, state } = reporter();

// Ordinary site CSS, not attacks. Each one broke something before the button moved.
const CASES = {
    '/plain':     { css: '', label: 'no page styles' },
    '/reset':     { css: '*{margin:0;padding:0;box-sizing:border-box}span{position:static}', label: 'a CSS reset' },
    '/static':    { css: 'span{position:static !important}', label: 'span{position:static !important}' },
    '/bigfont':   { css: 'span{font-size:26px !important}', label: 'a forced font size' },
    '/hidespans': { css: 'span[id]{display:none !important}', label: 'span[id]{display:none !important}' },
    '/stacking':  { css: 'body{position:relative;z-index:2147483647}', label: 'a page claiming the top of the stack' },
    '/rtl':       { css: 'html{direction:rtl}', label: 'a right-to-left page' },
    // The icon is an <svg> with width="36" as an attribute, and CSS beats presentation attributes.
    '/fluidsvg':  { css: 'svg{width:100%;height:100%}', label: 'svg{width:100%}' },
    '/emsvg':     { css: 'button svg{width:1em;height:1em;font-size:40px}', label: 'an em-sized icon' },
    '/nosvg':     { css: 'svg{display:none !important}', label: 'svg{display:none !important}' },
};

// The icon is drawn at 36×36 inside a 48×48 button. Anything else means the page reached it.
const ICON = [36, 36];

const relay = await startRelay({ port: RELAY_PORT });
const server = http.createServer((req, res) => {
    const c = CASES[req.url];
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><title>t</title><style>${c ? c.css : ''}</style></head><body style="font:16px sans-serif;padding:40px"><h1>page</h1><p>Body text.</p></body></html>`);
});
await new Promise(r => server.listen(SITE_PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${SITE_PORT}`;

const ME = newKey(), OTHER = newKey();
const now = Math.floor(Date.now() / 1000);
for (const path of Object.keys(CASES)) {
    const url = normalizeUrl(base + path);
    relay.stored.push(await sign(OTHER, { kind: 1111, created_at: now - 10, content: 'a comment', tags: [['I', url], ['K', 'web'], ['i', url], ['k', 'web']] }));
}

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncbtn-',
    onClose: () => { server.close(); relay.close(); },
});

await goto(base + '/plain');
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}`, nsec: toBech32('nsec', ME) }));
await wait(1500);
await js(`${ROOT}
  const o = [...s.getElementById('p').children].find(c => c.style.zIndex === '28' && getComputedStyle(c).display !== 'none');
  if (o) [...o.querySelectorAll('button')].find(b => /not now/i.test(b.textContent))?.click();
  return 1;`);

// Both badges forced on: the arrangement only matters when both are showing, and waiting for a
// real unread reply on seven pages would test the notification path rather than this one.
const measure = `${BADGE}
  if (!nc.red || !nc.orange) return JSON.stringify({ missing: true });
  nc.red.textContent = '1'; nc.red.style.display = 'block';
  nc.orange.textContent = '1'; nc.orange.style.display = 'block';
  const r = nc.red.getBoundingClientRect(), o = nc.orange.getBoundingClientRect(), b = nc.btn.getBoundingClientRect();
  const painted = el => { const c = getComputedStyle(el), q = el.getBoundingClientRect();
      return c.display !== 'none' && c.visibility !== 'hidden' && Number(c.opacity) > 0 && q.width > 0 && q.height > 0; };
  return JSON.stringify({
    red: [Math.round(r.x), Math.round(r.y)],
    orange: [Math.round(o.x), Math.round(o.y)],
    overlap: !(r.right <= o.left || o.right <= r.left || r.bottom <= o.top || o.bottom <= r.top),
    bothPainted: painted(nc.red) && painted(nc.orange),
    countOnRight: r.x > o.x,
    onTheButton: r.top >= b.top - 12 && o.top >= b.top - 12 && r.top < b.bottom && o.top < b.bottom,
    inViewport: r.left >= 0 && o.left >= 0 && r.right <= innerWidth && o.right <= innerWidth,
    icon: (() => { const g = nc.btn.querySelector('svg'); if (!g) return null;
        const q = g.getBoundingClientRect(); return [Math.round(q.width), Math.round(q.height)]; })(),
    button: [Math.round(b.width), Math.round(b.height)] });`;

console.log('\n=== the page cannot reach the button ===');
let baseline = null;
for (const [path, { label }] of Object.entries(CASES)) {
    await goto(base + path);
    await wait(3500);
    const m = JSON.parse(await js(measure) || '{}');
    if (m.missing) { ok(`${label}: badges exist`, false, m); continue; }
    baseline ??= m;
    ok(`${label}: both badges are painted`, m.bothPainted === true, m);
    ok(`${label}: they do not overlap`, m.overlap === false, m);
    ok(`${label}: the count stays on the right`, m.countOnRight === true, m);
    ok(`${label}: both sit on the button`, m.onTheButton === true, m);
    ok(`${label}: both stay on screen`, m.inViewport === true, m);
    ok(`${label}: the icon keeps its size`, JSON.stringify(m.icon) === JSON.stringify(ICON), { got: m.icon, want: ICON });
    ok(`${label}: the button keeps its size`, JSON.stringify(m.button) === JSON.stringify([48, 48]), m.button);
    // The strongest statement available: page styles change nothing at all.
    ok(`${label}: identical placement to an unstyled page`,
        JSON.stringify([m.red, m.orange]) === JSON.stringify([baseline.red, baseline.orange]),
        { got: [m.red, m.orange], want: [baseline.red, baseline.orange] });
}

// Last, because it turns the extension off for this origin and there is no way back except the
// control under test.
console.log('\n=== the re-enable button cannot be hidden either ===');
await goto(base + '/plain');
await wait(3000);
const disabled = await js(`${ROOT}
  s.getElementById('m').style.display='grid';
  s.getElementById('gear-btn').click();
  const b = s.getElementById('site-disable-btn');
  if (!b) return 'missing';
  b.click();
  return 'clicked';`);
ok('the extension can be turned off for a site', disabled === 'clicked', disabled);
await wait(1200);

// When it is off there is no panel, and the per-site list is only reachable from the panel on the
// site it applies to — so this button is the only way back. A page that could hide it would make
// itself permanently un-re-enable-able. It lived in the light DOM until this was checked.
const reBtn = async where => {
    await goto(base + where);
    await wait(3000);
    return JSON.parse(await js(`
      const seen = el => { const c = getComputedStyle(el), r = el.getBoundingClientRect();
          return c.display !== 'none' && c.visibility !== 'hidden' && Number(c.opacity) > 0 && r.width > 0 && r.height > 0; };
      const light = [...document.documentElement.children].filter(e => e.tagName === 'BUTTON');
      const shadow = [...document.documentElement.children].filter(e => e.shadowRoot)
          .flatMap(h => [...h.shadowRoot.querySelectorAll('button')]);
      return JSON.stringify({ inLight: light.length, painted: [...light, ...shadow].filter(seen).length });`));
};
const plain = await reBtn('/plain');
ok('it is there on an unstyled page', plain.painted >= 1, plain);
ok('and not loose in the page where a stylesheet can reach it', plain.inLight === 0, plain);
for (const [path, label] of [['/hidespans', 'span[id]{display:none}'], ['/nosvg', 'svg{display:none}'], ['/static', 'span{position:static !important}']]) {
    const r = await reBtn(path);
    ok(`it survives ${label}`, r.painted >= 1, r);
}
// The rule that actually killed it: a page hiding every button.
await goto(base + '/plain');
await wait(500);
const hostile = await js(`
  const st = document.createElement('style');
  st.textContent = 'button{display:none !important}';
  document.head.appendChild(st);
  const seen = el => { const c = getComputedStyle(el), r = el.getBoundingClientRect();
      return c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const light = [...document.documentElement.children].filter(e => e.tagName === 'BUTTON');
  const shadow = [...document.documentElement.children].filter(e => e.shadowRoot)
      .flatMap(h => [...h.shadowRoot.querySelectorAll('button')]);
  return [...light, ...shadow].filter(seen).length;`);
ok('and survives a page hiding every button', hostile >= 1, hostile);

console.log(`\n${state.fail ? '✗' : '✓'} button vs page CSS: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
