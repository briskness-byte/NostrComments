// What the relay list says each relay is doing.
//
// A relay that never answers used to look exactly like a relay with nothing to say. Sockets fail
// silently in this codebase — onerror closes, onclose retries and gives up after six attempts —
// so the only symptom was a thinner, slower thread and no explanation. Three of the six shipped
// defaults were unreachable from one machine on one afternoon, which is what prompted this: not to
// change the defaults on that evidence, but to make the evidence something a user can see.
//
// The distinction that matters, and the reason "connected" would not have been good enough: a
// relay can accept a socket and never reply. Answered means it sent EOSE.
//
//   node tests/browser-relaystate.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { extensionCode, reporter, startRelay, startSite, startBrowser, makeCert, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9542);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8101);
const GOOD_PORT = Number(process.env.QA_RELAY_PORT || 8469);
const MUTE_PORT = GOOD_PORT + 1;
const DEAD_PORT = GOOD_PORT + 2;      // nothing ever listens here

const { _secp, normalizeUrl, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const good = await startRelay({ port: GOOD_PORT });

// A genuinely silent relay: completes the WebSocket handshake and then says nothing at all — no
// EVENT, no EOSE, ever. startRelay cannot be used for this; it answers every REQ with EOSE
// whatever its options say, which is how the first version of this suite ended up "testing" a
// relay that was politely replying the whole time.
const mute = await (async () => {
    const dir = makeCert();
    const server = https.createServer({
        key: fs.readFileSync(path.join(dir, 'key.pem')),
        cert: fs.readFileSync(path.join(dir, 'cert.pem')),
    });
    const sockets = new Set();
    server.on('upgrade', (req, socket) => {
        const accept = crypto.createHash('sha1')
            .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
                     'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        sockets.add(socket);
        socket.on('error', () => sockets.delete(socket));
        // Deliberately no data handler. Whatever it asks, it gets nothing back.
    });
    await new Promise(r => server.listen(MUTE_PORT, '127.0.0.1', r));
    return { close: () => { for (const s of sockets) s.destroy(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
})();

const site = await startSite({ port: SITE_PORT, heading: 'Relay state QA page' });
const pageUrl = normalizeUrl(site.url);
const OTHER = newKey();
const now = Math.floor(Date.now() / 1000);
good.stored.push(await sign(OTHER, { kind: 1111, created_at: now - 20, content: 'a comment on this page',
    tags: [['I', pageUrl], ['K', 'web'], ['i', pageUrl], ['k', 'web']] }));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncrs-',
    onClose: () => { site.close(); good.close(); mute.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

// Three relays: one that works, one that answers nothing, one that is not there at all.
await js(`${ROOT}
  s.getElementById('m').style.display='grid';
  const o=[...s.getElementById('p').children].find(c=>c.textContent.includes('One quick thing'));
  if(o) o.querySelector('button').click();
  s.getElementById('gear-btn').click();
  let guard=0;
  while (s.getElementById('relay-list').querySelector('.relay-remove') && guard++<50)
      s.getElementById('relay-list').querySelector('.relay-remove').click();
  for (const u of ['wss://127.0.0.1:${GOOD_PORT}','wss://127.0.0.1:${MUTE_PORT}','wss://127.0.0.1:${DEAD_PORT}']) {
      s.getElementById('relay-input').value = u;
      s.getElementById('relay-add-btn').click();
  }
  return 1;`);
await wait(800);

const rows = () => js(`${ROOT}
  return JSON.stringify([...s.getElementById('relay-list').querySelectorAll('.relay-item')].map(i => {
    const st = i.querySelector('.relay-state');
    return { url: (i.querySelector('.relay-url') || {}).textContent || '',
             text: st ? st.textContent : '(none)',
             cls: st ? st.className : '',
             title: st ? st.title : '' };
  }));`);

console.log('\n=== the list reports on every relay ===');
let r = JSON.parse(await rows());
ok('every relay has a status line', r.length === 3 && r.every(x => x.text !== '(none)'), r);

// Reload so the thread subscription runs against all three from a clean start.
await goto(site.url);
await wait(7000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn').click(); return 1;`);
await wait(600);

console.log('\n=== after ===');
// Poll rather than sleep. The silent-relay timer starts at onopen, which is itself after the
// lazy-connect wait, so a fixed sleep lands either side of it depending on how fast the sockets
// come up — the first version of this passed and failed on the same code.
for (let i = 0; i < 30; i++) {
    r = JSON.parse(await rows());
    if (!r.some(x => /connecting/.test(x.text))) break;
    await wait(700);
}
r = JSON.parse(await rows());
const byPort = p => r.find(x => x.url.includes(':' + p)) || {};
const g = byPort(GOOD_PORT), m = byPort(MUTE_PORT), d = byPort(DEAD_PORT);

ok('the working relay is marked as having answered', /answered/.test(g.text), g);
ok('and says how much it returned', /answered · [1-9]/.test(g.text), g.text);
ok('it is styled as good news', /answered/.test(g.cls), g.cls);

// The whole reason this is not a connection check.
ok('a relay that accepts the socket but never replies is not called answered', !/answered/.test(m.text), m);
ok('it is reported as no answer', /no answer|gave up/.test(m.text), m.text);

ok('a relay that is not there is reported too', /no answer|gave up/.test(d.text), d.text);
ok('and marked as a problem, not as neutral', /failed|unreachable/.test(d.cls), d.cls);

// Nothing here should ever read as "everything is fine" when it is not.
ok('the two broken relays do not claim to have answered', !/answered/.test(m.text) && !/answered/.test(d.text), { m: m.text, d: d.text });
ok('each status explains itself on hover', [g, m, d].every(x => (x.title || '').length > 20), [g.title, m.title, d.title]);

// The same relay twice is two sockets on every page, for nothing. The check on adding one was a
// literal string comparison, so a trailing slash was enough to slip past it — which is exactly what
// happened in a real NIP-65 list written by another client.
console.log('\n=== the same relay cannot be added twice ===');
const listed = () => js(`${ROOT} return JSON.stringify(
  [...s.getElementById('relay-list').querySelectorAll('.relay-url')].map(e => e.textContent));`);

const before = JSON.parse(await listed()).length;
const tries = [`wss://127.0.0.1:${GOOD_PORT}/`, `WSS://127.0.0.1:${GOOD_PORT}`, `wss://127.0.0.1:${GOOD_PORT}//`, `  wss://127.0.0.1:${GOOD_PORT}  `];
for (const t of tries) {
    await js(`${ROOT} s.getElementById('relay-input').value = ${JSON.stringify('__T__')}; s.getElementById('relay-add-btn').click(); return 1;`.replace('__T__', t));
    await wait(250);
}
const after = JSON.parse(await listed());
ok('four spellings of a relay already in the list add nothing', after.length === before, { before, after });

await js(`${ROOT} s.getElementById('relay-input').value='wss://relay.example.com/nostr/'; s.getElementById('relay-add-btn').click(); return 1;`);
await wait(300);
const withPath = JSON.parse(await listed());
ok('a genuinely new relay is still accepted', withPath.length === before + 1, withPath);
ok('stored without its trailing slash', withPath.includes('wss://relay.example.com/nostr'), withPath);

await js(`${ROOT} s.getElementById('relay-input').value='wss://relay.example.com/NOSTR'; s.getElementById('relay-add-btn').click(); return 1;`);
await wait(300);
// Hosts are case-insensitive, paths are not: this is a different relay and must be allowed.
ok('a path differing only in case is a different relay', JSON.parse(await listed()).length === before + 2, await listed());

console.log(`\n${state.fail ? '✗' : '✓'} relay state: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
