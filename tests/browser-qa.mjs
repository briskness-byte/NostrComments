// Browser QA for the support section — the part the dependency-free suite cannot reach.
//
// tests/run.mjs exercises logic. This loads the REAL unpacked Chrome extension in a real browser
// and checks what only a browser can answer: does the panel render, does it react to clicks, do
// the buttons lock while a payment is in flight, and is the text actually readable in both
// themes. It found a WCAG AA contrast failure that no amount of reading the CSS would have.
//
// Not part of `node tests/run.mjs`: that suite is deliberately dependency-free and instant, while
// this needs chromium and chromedriver installed. Run it before a release.
//
//   node tests/browser-qa.mjs                 full run
//   node tests/browser-qa.mjs --no-live       skip the step that contacts the Lightning provider
//   node tests/browser-qa.mjs --shots <dir>   also write screenshots (light + dark) to <dir>
//   CHROMIUM=/path/to/chrome node tests/browser-qa.mjs
//
// NOTE ON THE LIVE STEP: clicking an amount button makes the extension fetch a real invoice from
// the developer's Lightning provider. Nothing is paid and the invoice simply expires, but it is a
// real request to a third party — use --no-live if you would rather not make it.
//
// Requires: chromium (or Chrome) and a matching chromedriver on PATH. Node 18+.
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.resolve(HERE, '..', 'NostrComments-Chrome');
const LIVE = !process.argv.includes('--no-live');
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const PORT = Number(process.env.QA_PORT || 9515);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8099);

function findChromium() {
    if (process.env.CHROMIUM) return process.env.CHROMIUM;
    const candidates = [
        '/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium-browser',
        '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    // Prefer a real binary over a sandbox wrapper: chromedriver has to exec it directly.
    for (const c of candidates) { try { if (fs.statSync(c).isFile() && fs.statSync(c).size > 100000) return c; } catch {} }
    for (const c of candidates) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {} }
    return null;
}

const BIN = findChromium();
if (!BIN) { console.log('✗ No chromium/chrome binary found. Set CHROMIUM=/path/to/binary.'); process.exit(1); }

// Chrome puts its singleton socket under the user-data-dir, and a UNIX socket path is capped
// around 104 characters. Keep these directories short or Chrome dies with "Socket path too long".
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqa-'));
if (W.length > 40) console.log(`  ! warning: working dir is long (${W.length} chars); Chrome may refuse to start`);
fs.mkdirSync(path.join(W, 'home'), { recursive: true });
fs.mkdirSync(path.join(W, 'tmp'), { recursive: true });

let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };

const site = http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>QA</title></head><body style="font:16px sans-serif;padding:40px"><h1>NostrComments QA page</h1><p>Article body text.</p></body></html>');
});
await new Promise(r => site.listen(SITE_PORT, '127.0.0.1', r));

// Chrome derives its crashpad database from HOME; point it somewhere writable so a locked-down
// or containerised HOME does not make the crash handler abort the whole browser.
const env = { ...process.env, HOME: path.join(W, 'home'), XDG_CONFIG_HOME: path.join(W, 'home/.config'), XDG_CACHE_HOME: path.join(W, 'home/.cache'), TMPDIR: path.join(W, 'tmp') };
const cd = spawn('chromedriver', [`--port=${PORT}`], { stdio: ['ignore', 'ignore', 'ignore'], env });
cd.on('error', e => { console.log('✗ could not start chromedriver: ' + e.message); process.exit(1); });

const wd = async (m, p, b) => (await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();

let up = false;
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/status`); up = true; break; } catch { await new Promise(r => setTimeout(r, 250)); } }
if (!up) { console.log(`✗ chromedriver did not come up on port ${PORT}`); process.exit(1); }

const s = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'goog:chromeOptions': { binary: BIN, args: [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    `--user-data-dir=${path.join(W, 'cd')}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
    '--window-size=1000,1600'] } } } });
if (!s.value?.sessionId) {
    console.log('✗ could not start a browser session:\n  ' + (s.value?.message || JSON.stringify(s)).split('\n')[0]);
    console.log('  (a stale chromedriver on the same port is a common cause)');
    cd.kill(); site.close(); process.exit(1);
}
const sid = s.value.sessionId;
const js = async src => (await wd('POST', `/session/${sid}/execute/sync`, { script: `return (function(){${src}})()`, args: [] })).value;
const finish = async code => { await wd('DELETE', `/session/${sid}`).catch(() => {}); cd.kill(); site.close(); fs.rmSync(W, { recursive: true, force: true }); process.exit(code); };

await wd('POST', `/session/${sid}/url`, { url: `http://127.0.0.1:${SITE_PORT}/` });
await new Promise(r => setTimeout(r, 3000));

// The extension lives in a shadow root attached to <html>; everything below reaches in via `s`.
const ROOT = `
  const host = [...document.documentElement.children].find(e => e.shadowRoot && e.shadowRoot.getElementById('donate'));
  if (!host) return null;
  const s = host.shadowRoot;`;

const shot = async name => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const b = (await wd('GET', `/session/${sid}/screenshot`)).value;
    if (b) fs.writeFileSync(path.join(SHOTS, `support-${name}.png`), Buffer.from(b, 'base64'));
};

console.log(`\nchromium: ${BIN}\nextension: ${EXT}\n`);

console.log('=== injection ===');
const injected = await js(`${ROOT} return !!s;`);
ok('content script injects a shadow root containing the support section', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

console.log('\n=== consent gate ===');
const pre = JSON.parse(await js(`${ROOT}
  s.getElementById('m').style.display = 'grid';
  const overlay = [...s.getElementById('p').children].find(c => c.textContent.includes('One quick thing'));
  return JSON.stringify({ overlayExists: !!overlay });`));
ok('disclosure overlay covers the panel before consent', pre.overlayExists, pre);

// The section sat open under every thread — heading, pitch, four buttons and two paragraphs of
// small print, often taller than the comment box above it. It is one line now, and everything else
// is behind a disclosure.
console.log('\n=== collapsed by default ===');
const C = JSON.parse(await js(`${ROOT}
  const overlay = [...s.getElementById('p').children].find(c => c.textContent.includes('One quick thing'));
  if (overlay) overlay.querySelector('button').click();
  const t = s.getElementById('donate-toggle');
  return JSON.stringify({
    bodyHidden: getComputedStyle(s.getElementById('donate-body')).display === 'none',
    expanded: t.getAttribute('aria-expanded'),
    labelled: !!t.getAttribute('aria-label'),
    head: s.getElementById('donate-head').textContent,
    quick: [...s.getElementById('donate-quick').querySelectorAll('button')].map(b => b.textContent) });`));
ok('everything but the one line starts hidden', C.bodyHidden, C);
ok('the disclosure reports itself as collapsed', C.expanded === 'false', C.expanded);
ok('the disclosure has an accessible name', C.labelled, C);
ok('the line still says what it is for', C.head === '⚡ Support the developer', C.head);
ok('two zap amounts stay reachable without expanding', C.quick.length === 2 && /1k/.test(C.quick[0]) && /5k/.test(C.quick[1]), C.quick);

console.log('\n=== rendering (expanded) ===');
const I = JSON.parse(await js(`${ROOT}
  s.getElementById('donate-toggle').click();
  const d = s.getElementById('donate'), cs = getComputedStyle(d);
  return JSON.stringify({
    visible: cs.display !== 'none',
    head: s.getElementById('donate-head').textContent,
    pitchShown: getComputedStyle(s.getElementById('donate-pitch')).display !== 'none',
    buttons: [...s.getElementById('donate-amounts').querySelectorAll('button')].map(b => b.textContent),
    borderTop: cs.borderTopWidth,
    bodyShown: getComputedStyle(s.getElementById('donate-body')).display !== 'none',
    expanded: s.getElementById('donate-toggle').getAttribute('aria-expanded'),
    btc: s.getElementById('donate-btc')?.getAttribute('href') || '',
    xmr: s.getElementById('donate-xmr')?.getAttribute('href') || '',
    customHidden: getComputedStyle(s.getElementById('donate-custom')).display === 'none' });`));
ok('support section is visible', I.visible, I.visible);
ok('the disclosure opens it', I.bodyShown && I.expanded === 'true', { shown: I.bodyShown, expanded: I.expanded });
ok('heading reads "⚡ Support the developer"', I.head === '⚡ Support the developer', I.head);
ok('pitch is shown (not a supporter yet)', I.pitchShown);
ok('amount buttons render with the configured amounts', I.buttons.length === 4 && I.buttons[3] === 'Other…', I.buttons);
ok('separated from the panel by a top border', I.borderTop !== '0px', I.borderTop);
ok('footnote keeps the on-chain bitcoin: link', /^bitcoin:[13bc1][a-zA-Z0-9]{25,}$/.test(I.btc), I.btc);
// 95 base58 characters, no 0/O/I/l — a mainnet Monero address or subaddress.
ok('footnote offers a monero: link', /^monero:[1-9A-HJ-NP-Za-km-z]{95}$/.test(I.xmr), I.xmr);
ok('custom amount field starts hidden', I.customHidden);

console.log('\n=== custom amount toggle ===');
const T = JSON.parse(await js(`${ROOT}
  const other = [...s.getElementById('donate-amounts').querySelectorAll('button')].find(b => b.textContent === 'Other…');
  const custom = s.getElementById('donate-custom');
  other.click();
  const opened = getComputedStyle(custom).display, focused = s.activeElement && s.activeElement.id;
  other.click();
  return JSON.stringify({ opened, focused, closed: getComputedStyle(custom).display });`));
ok('"Other…" reveals the field', T.opened === 'flex', T.opened);
ok('the input takes focus', T.focused === 'donate-custom-input', T.focused);
ok('clicking again hides it', T.closed === 'none', T.closed);

if (LIVE) {
    console.log('\n=== payment in flight (contacts the Lightning provider) ===');
    await js(`${ROOT} s.getElementById('donate-amounts').querySelectorAll('button')[0].click(); return 1;`);
    await new Promise(r => setTimeout(r, 250));
    const during = JSON.parse(await js(`${ROOT} return JSON.stringify([...s.getElementById('donate-amounts').querySelectorAll('button')].map(b => b.disabled));`));
    ok('every amount button is disabled while the request runs', during.every(Boolean), during);
    await new Promise(r => setTimeout(r, 9000));
    const A = JSON.parse(await js(`${ROOT} return JSON.stringify({
        enabled: [...s.getElementById('donate-amounts').querySelectorAll('button')].map(b => !b.disabled),
        msg: s.getElementById('msg').textContent,
        head: s.getElementById('donate-head').textContent });`));
    ok('buttons are re-enabled afterwards', A.enabled.every(Boolean), A.enabled);
    // Any message at all used to satisfy this, so a payment path that failed outright still passed.
    // Both no-wallet outcomes end in an invoice being offered for copying; every failure says it
    // could not get one. This is the check that would catch the callback validation rejecting a
    // provider that real users pay through.
    ok('an invoice actually came back', /copied|copy invoice/i.test(A.msg) && !/could not|error|insecure|unusable/i.test(A.msg), A.msg);
    ok('supporter state stays unset when no wallet confirmed a payment', A.head === '⚡ Support the developer', A.head);
} else {
    console.log('\n=== payment in flight === (skipped: --no-live)');
}

// Contrast: WCAG AA needs 4.5:1 for normal text, 3:1 for large or bold text. Measured against the
// colour actually painted behind each element, not against what the CSS appears to say.
const rgb = v => v.match(/\d+/g).slice(0, 3).map(Number);
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// Every element that paints its own text, rather than four hand-picked ids.
//
// This suite has measured contrast since v22.41 and has been passing the whole time — while eleven
// hint lines in Settings sat at 3.40:1 on the dark panel. It was only ever looking at the support
// block. A contrast check aimed at one corner mostly proves that corner is fine.
//
// Only elements holding their own text node are sampled: a wrapper inherits its colour and would
// report the same failure several times over, once per ancestor.
const sample = async () => JSON.parse(await js(`${ROOT}
  // A gradient reports backgroundColor: transparent, so walking past it lands on whatever is
  // behind the button and measures white text against a pale panel — 1.08:1 for something that is
  // really white on blue. Take the gradient's first colour stop instead; it is an approximation,
  // but it is an approximation of the right surface.
  const bgOf = el => { let n = el; while (n) { const cs = getComputedStyle(n);
      const img = cs.backgroundImage;
      if (img && img !== 'none') { const m = img.match(/rgba?\\([^)]+\\)/); if (m) return m[0]; }
      const c = cs.backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      n = n.parentElement || (n.getRootNode() && n.getRootNode().host); } return 'rgb(255, 255, 255)'; };
  const out = {};
  let i = 0;
  for (const el of s.querySelectorAll('*')) {
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.5) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const label = (el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : el.tagName.toLowerCase())
                + ' "' + el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 28) + '"';
    out[label + ' [' + (i++) + ']'] = { fg: cs.color, bg: bgOf(el), size: cs.fontSize, weight: cs.fontWeight };
  }
  return JSON.stringify(out);`));

// Nothing is waived any more. The brand blue used to appear in two strengths: #1d9bf0 for text and
// #0c75bc for the filled buttons, which were darkened in 23.0.3 when they failed AA. The text kept
// the bright one and sat at 3.00:1 and 2.78:1 for eleven versions, recorded here as debt.
//
// Both are #0c75bc now, so the panel carries one blue rather than two — more consistent, not less.
// Dark mode already had its own tokens (#93c5fd, #60a5fa) and is untouched. If a background moves
// and pushes one of these under the line, this suite is what says so.
const BRAND_DEBT = {};

const checkContrast = (theme, data) => {
    for (const [k, v] of Object.entries(data)) {
        const r = ratio(v.fg, v.bg), px = parseFloat(v.size), bold = Number(v.weight) >= 700;
        const need = (px >= 24 || (bold && px >= 18.66)) ? 3 : 4.5;
        const sel = k.split(' ')[0];
        const debt = BRAND_DEBT[sel];
        if (r < need && debt !== undefined) {
            ok(`${theme}: ${k} is known brand-blue debt, ${r.toFixed(2)}:1 (was ${debt.toFixed(2)}, needs ${need})`,
               r >= debt - 0.01, `${v.fg} on ${v.bg}`);
            continue;
        }
        ok(`${theme}: ${k} contrast ${r.toFixed(2)}:1 (needs ${need}:1)`, r >= need, `${v.fg} on ${v.bg}`);
    }
};

// Never assume which theme the panel starts in: with no saved preference applyTheme() follows
// the system's prefers-color-scheme, so the starting theme differs per machine. Force each one.
const setTheme = async want => {
    const wantDark = want === 'dark';
    await js(`${ROOT}
      const m = s.getElementById('m');
      if (m.classList.contains('dark-mode') !== ${wantDark}) s.getElementById('theme-btn').click();
      return 1;`);
    await new Promise(r => setTimeout(r, 400));
    return JSON.parse(await js(`${ROOT} return JSON.stringify({ dark: s.getElementById('m').classList.contains('dark-mode') });`)).dark;
};

// The whole action row under a comment — reply, zap, link, mute, delete — only exists once a
// comment does, and this suite loads none. So none of it was ever measured, and .reply-btn sat at
// 3.00:1 while .del-btn and .mute-btn sat at 1.92:1. Third time this shape of gap has cost
// something: an element that is absent when the suite looks is an element it cannot hold.
await js(`${ROOT}
  const c = document.createElement('div');
  c.className = 'c own';
  c.append(document.createTextNode('A comment, so the row beneath it exists to be measured.'));
  const row = document.createElement('div');
  row.className = 'actions';
  const mk = (cls, txt) => { const b = document.createElement('button'); b.className = cls; b.textContent = txt; return b; };
  row.append(mk('vote-btn', '\u2191 5'), mk('reply-btn', '\u21a9 Reply'), mk('zap-btn', '\u26a1'),
             mk('copy-btn', '\u{1F517}'), mk('mute-btn', '\u{1F6AB} Mute'), mk('del-btn', '\u{1F5D1} Delete'));
  c.appendChild(row);
  s.getElementById('list').appendChild(c);
  return 1;`);

// The reply banner is hidden until a reply arrives, so it was never sampled — and sat at 2.15:1,
// white on orange, for as long as it existed. Same gap as the note badge below: an element that is
// display:none when the suite looks is an element the suite cannot hold to anything.
await js(`${ROOT}
  const b = s.getElementById('notif-banner');
  b.textContent = '';
  const head = document.createElement('div');
  head.className = 'nb-head';
  const label = document.createElement('span');
  label.textContent = '\u{1F514} 2 new replies on your comments';
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'nb-x'; x.textContent = '\u00d7';
  head.append(label, x);
  const a = document.createElement('a');
  a.href = 'https://example.com/article'; a.textContent = '2 on example.com/article';
  b.append(head, a);
  b.style.display = 'block';
  return 1;`);

// The "note" badge is only drawn on a comment carried over from the old kind 1 format, and this
// suite never loads one — which is how its light-mode colour sat at 4.34:1 for eleven versions
// without anything noticing. Contrast is a property of the stylesheet rather than of how the element
// came to be there, so one is put into the list directly.
await js(`${ROOT}
  const d = document.createElement('div');
  d.className = 'c nc-note';
  d.append(document.createTextNode('A comment carried over from the old note format.'));
  const t = document.createElement('span');
  t.className = 'nc-notetag';
  t.textContent = 'note';
  d.append(t);
  s.getElementById('list').append(d);
  return 1;`);

for (const theme of ['light', 'dark']) {
    console.log(`\n=== contrast, ${theme} mode ===`);
    const isDark = await setTheme(theme);
    ok(`${theme} mode is active`, isDark === (theme === 'dark'), { darkClass: isDark });
    checkContrast(theme, await sample());
    await shot(theme);
}

if (SHOTS) console.log(`\nscreenshots written to ${SHOTS}`);
console.log(`\n${fail === 0 ? '✓' : '✗'} browser QA: ${pass} passed, ${fail} failed`);
await finish(fail ? 1 : 0);
