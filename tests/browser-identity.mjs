// Identity handling in a real browser: importing over a stored key must warn, name the identity
// that disappears, allow a copy to be taken first, and leave everything untouched on cancel.
// Losing a Nostr identity is irreversible, so this path is checked in the browser, not by reading.
//
//   node tests/browser-identity.mjs
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

function findChromium() {
    if (process.env.CHROMIUM) return process.env.CHROMIUM;
    for (const c of ['/usr/lib/chromium/chromium','/usr/lib/chromium-browser/chromium-browser','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/google-chrome-stable']) {
        try { if (fs.statSync(c).isFile() && fs.statSync(c).size > 100000) return c; } catch {}
    }
    throw new Error('No chromium found — set CHROMIUM=/path/to/binary');
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.resolve(HERE, '..', 'NostrComments-Chrome');
const PORT = 9515;
const src = fs.readFileSync(EXT + '/content.js', 'utf8');
const s0 = src.indexOf('const _secp = (() => {'), s1 = src.indexOf('})();', s0) + 5;
const _secp = eval(src.slice(s0, s1) + '; _secp');
const t0 = src.indexOf('        function toBech32(hrp, hex) {'), t1 = src.indexOf('        function fromBech32', t0);
const toBech32 = eval(src.slice(t0, t1) + '; toBech32');

const A = _secp.b2h(crypto.getRandomValues(new Uint8Array(32)));
const B = _secp.b2h(crypto.getRandomValues(new Uint8Array(32)));
const PUB_A = _secp.pubKey(A), PUB_B = _secp.pubKey(B);
// The status line shows an npub now, not a hex tail — compare against what a person actually sees.
const NPUB_A = toBech32('npub', PUB_A), NPUB_B = toBech32('npub', PUB_B);
const shown = np => np.slice(0, 10);

const site = http.createServer((_, r) => { r.writeHead(200, {'Content-Type':'text/html'}); r.end('<!doctype html><html><body><p>x</p></body></html>'); });
await new Promise(r => site.listen(8099, '127.0.0.1', r));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'ncov-'));
fs.mkdirSync(path.join(W, 'home'), { recursive: true });
const env = { ...process.env, HOME: path.join(W,'home'), XDG_CONFIG_HOME: path.join(W,'home/.config'), XDG_CACHE_HOME: path.join(W,'home/.cache'), TMPDIR: W };
const cd = spawn('chromedriver', [`--port=${PORT}`], { stdio:['ignore','ignore','ignore'], env });
const wd = async (m,p,b) => (await fetch(`http://127.0.0.1:${PORT}${p}`,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined})).json();
for (let i=0;i<60;i++){ try { await fetch(`http://127.0.0.1:${PORT}/status`); break; } catch { await new Promise(r=>setTimeout(r,250)); } }

let pass=0, fail=0;
const ok=(n,c,e)=>{ c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(e!==undefined?'  → '+JSON.stringify(e):''))); };
const ROOT = `const host=[...document.documentElement.children].find(e=>e.shadowRoot&&e.shadowRoot.getElementById('donate'));const s=host.shadowRoot;`;

const sess = await wd('POST','/session',{capabilities:{alwaysMatch:{
  'goog:chromeOptions':{binary: findChromium(),args:[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run',
    `--user-data-dir=${path.join(W,'cd')}`,`--load-extension=${EXT}`,`--disable-extensions-except=${EXT}`,'--window-size=1000,1700']}}}});
const sid = sess.value.sessionId;
const js = async c => (await wd('POST',`/session/${sid}/execute/sync`,{script:`return (function(){${c}})()`,args:[]})).value;
await wd('POST',`/session/${sid}/url`,{url:'http://127.0.0.1:8099/'});
await new Promise(r=>setTimeout(r,2800));

// With nothing connected, Connect is the one thing left to do, so it has to be on screen.
const connectDisplay = () => js(`${ROOT} return getComputedStyle(s.getElementById('connect')).display;`);
const btnBefore = await js(`${ROOT}
  s.getElementById('m').style.display='grid';
  const o=[...s.getElementById('p').children].find(c=>c.textContent.includes('One quick thing'));
  if(o) o.querySelector('button').click();
  s.getElementById('gear-btn').click();
  return getComputedStyle(s.getElementById('connect')).display;`);
ok('Connect is shown while nothing is connected', btnBefore !== 'none', btnBefore);

// Import identity A into an empty extension (no dialog expected — nothing to lose).
await js(`${ROOT}
  s.getElementById('privkey-import').value=${JSON.stringify(toBech32('nsec',A))};
  s.getElementById('privkey-import-btn').click(); return 1;`);
await new Promise(r=>setTimeout(r,1200));
let st = await js(`${ROOT} return s.getElementById('status').textContent;`);
ok('identity A imported into an empty extension without a warning', st.includes(shown(NPUB_A)), st);
// It used to stay, disabled but styled exactly like a live primary button, next to a status line
// already saying you were connected. Nothing to click, nothing to gain: it should be gone.
ok('Connect disappears once an identity is connected', (await connectDisplay()) === 'none', await connectDisplay());

// Now import B over A. The warning must appear.
await js(`${ROOT} s.getElementById('privkey-import').value=${JSON.stringify(toBech32('nsec',B))}; s.getElementById('privkey-import-btn').click(); return 1;`);
await new Promise(r=>setTimeout(r,700));
const dlg = JSON.parse(await js(`${ROOT}
  const ov=[...s.getElementById('p').children].find(c=>c.style.zIndex==='30');
  const vis = ov && getComputedStyle(ov).display!=='none';
  return JSON.stringify({
    visible: !!vis,
    text: vis ? ov.textContent : '',
    buttons: vis ? [...ov.querySelectorAll('button')].map(b=>b.textContent) : []
  });`));
ok('a warning appears before the identity is replaced', dlg.visible, dlg);
ok('it names the identity that will disappear', dlg.text.includes(_secp.pubKey(A).slice(0,4)) || /npub1/.test(dlg.text), dlg.text.slice(0,120));
ok('it says the change cannot be undone', /cannot be undone/i.test(dlg.text), dlg.text.slice(0,160));
ok('it warns that no backup was confirmed', /NO confirmed backup|marked as backed up/i.test(dlg.text), dlg.text.slice(0,200));
ok('it offers to copy the current key first', dlg.buttons.some(b=>/Copy the current key/i.test(b)), dlg.buttons);
ok('it offers Cancel', dlg.buttons.some(b=>/^Cancel$/i.test(b)), dlg.buttons);

// The copy button must not close the dialog — copying is a step before deciding.
const afterCopy = JSON.parse(await js(`${ROOT}
  const ov=[...s.getElementById('p').children].find(c=>c.style.zIndex==='30');
  [...ov.querySelectorAll('button')].find(b=>/Copy the current key/i.test(b.textContent)).click();
  return JSON.stringify({ stillOpen: getComputedStyle(ov).display!=='none' });`));
ok('copying does not dismiss the dialog', afterCopy.stillOpen, afterCopy);

// Cancel must leave the stored identity untouched.
await js(`${ROOT}
  const ov=[...s.getElementById('p').children].find(c=>c.style.zIndex==='30');
  [...ov.querySelectorAll('button')].find(b=>/^Cancel$/i.test(b.textContent)).click(); return 1;`);
await new Promise(r=>setTimeout(r,500));
st = await js(`${ROOT} return s.getElementById('status').textContent;`);
const msg = await js(`${ROOT} return s.getElementById('msg').textContent;`);
ok('cancelling keeps identity A', st.includes(shown(NPUB_A)), st);
ok('cancelling says nothing changed', /cancelled/i.test(msg), msg);

// Confirming must actually replace it. Cancelling clears the pasted key out of the field — it is
// a private key in a shadow root the page can read — so paste it again the way a user would.
await js(`${ROOT} s.getElementById('privkey-import').value=${JSON.stringify(toBech32('nsec',B))}; s.getElementById('privkey-import-btn').click(); return 1;`);
await new Promise(r=>setTimeout(r,600));
await js(`${ROOT}
  const ov=[...s.getElementById('p').children].find(c=>c.style.zIndex==='30');
  [...ov.querySelectorAll('button')].find(b=>/^Replace it$/i.test(b.textContent)).click(); return 1;`);
await new Promise(r=>setTimeout(r,1200));
st = await js(`${ROOT} return s.getElementById('status').textContent;`);
ok('confirming replaces it with identity B', st.includes(shown(NPUB_B)), st);
ok('Connect stays hidden across an identity swap', (await connectDisplay()) === 'none', await connectDisplay());

// Deleting the stored key is the only route back to a disconnected state the extension has today,
// so it is the one place the button has to reappear.
await js(`${ROOT} if (s.getElementById('settings').style.display !== 'block') s.getElementById('gear-btn').click(); return 1;`);
await new Promise(r=>setTimeout(r,400));
await js(`${ROOT} s.getElementById('privkey-delete').click(); return 1;`);
await new Promise(r=>setTimeout(r,600));
await js(`${ROOT}
  const ov=[...s.getElementById('p').children].find(c=>c.style.zIndex==='30');
  [...ov.querySelectorAll('button')].find(b=>/^Delete it$/i.test(b.textContent)).click(); return 1;`);
await new Promise(r=>setTimeout(r,900));
st = await js(`${ROOT} return s.getElementById('status').textContent;`);
ok('deleting the key disconnects', /Not connected/.test(st), st);
ok('Connect comes back when there is no identity left', (await connectDisplay()) !== 'none', await connectDisplay());
const card = await js(`${ROOT} return s.getElementById('identity-name').textContent;`);
ok('the identity card is cleared too', /Not connected/.test(card), card);

// The private key used to sit in plain view here while the *public* key was the one behind a
// toggle — the wrong way round. A shoulder, a screenshot or a screen share was enough to lose it.
const keyView = () => js(`${ROOT}
  const box = s.getElementById('privkey-box'), inp = s.getElementById('privkey-display');
  return JSON.stringify({
    shown: !!box && getComputedStyle(box).display !== 'none',
    hasValue: !!inp && /^nsec1[02-9ac-hj-np-z]{20,}$/i.test(inp.value),
    btn: (s.getElementById('privkey-reveal') || {}).textContent || null });`);

// A deleted identity has to be gone from the panel as well as from disk. It was not: the key
// stayed in the field after the delete, and pressing Show handed back the identity the user had
// just destroyed. tests/browser-keyexposure.mjs covers the leak itself; this pins the delete.
let kv = JSON.parse(await keyView() || '{}');
ok('deleting leaves no key in the field', kv.hasValue === false, kv);
await js(`${ROOT} s.getElementById('privkey-reveal').click(); return 1;`);
await new Promise(r=>setTimeout(r,300));
kv = JSON.parse(await keyView() || '{}');
ok('and Show cannot bring the deleted key back', kv.shown === false && kv.hasValue === false, kv);

// Put an identity back, so show/hide is tested against a key that exists.
await js(`${ROOT}
  s.getElementById('privkey-import').value=${JSON.stringify(toBech32('nsec',B))};
  s.getElementById('privkey-import-btn').click(); return 1;`);
await new Promise(r=>setTimeout(r,1400));
kv = JSON.parse(await keyView() || '{}');
ok('the private key is not on screen until asked for', kv.shown === false, kv);
ok('and it is not sitting in the field either', kv.hasValue === false, kv);
ok('and the button offers to show it', /Show private key/i.test(kv.btn || ''), kv.btn);

await js(`${ROOT} s.getElementById('privkey-reveal').click(); return 1;`);
await new Promise(r=>setTimeout(r,300));
kv = JSON.parse(await keyView() || '{}');
ok('asking for it shows it', kv.shown === true && kv.hasValue === true, kv);
ok('and the button offers to hide it again', /Hide private key/i.test(kv.btn || ''), kv.btn);

// Closing Settings must put it away: the next person to open this panel is not necessarily the
// same person.
await js(`${ROOT} s.getElementById('settings-close').click(); return 1;`);
await new Promise(r=>setTimeout(r,300));
await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
await new Promise(r=>setTimeout(r,400));
kv = JSON.parse(await keyView() || '{}');
ok('closing Settings puts it away again', kv.shown === false, kv);

ok('there is only one Copy npub button', await js(`${ROOT}
  return [...s.getElementById('settings').querySelectorAll('button')].filter(b => /copy npub/i.test(b.textContent)).length;`) === 1);

console.log(`\n${fail===0?'✓':'✗'} identity and connect state: ${pass} passed, ${fail} failed`);
await wd('DELETE',`/session/${sid}`); cd.kill(); site.close(); fs.rmSync(W,{recursive:true,force:true});
process.exit(fail?1:0);
