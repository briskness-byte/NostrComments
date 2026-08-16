// Shared plumbing for the browser suites: a throwaway relay, a page to visit, a chromium driven
// over WebDriver, and the extension's own crypto lifted out of the shipped source.
//
// Every suite used to carry its own copy of all of this. Six copies of the same hundred and fifty
// lines is six places to fix a flaky socket or a Chrome flag, and it is how the userscript quietly
// drifted from the extensions elsewhere in this repo. Suites still run standalone — they import
// this and nothing else.
//
// What stays in a suite is what makes it that suite: the events on the relay, the clicks, and the
// assertions. Everything below is scaffolding.
import { spawn, execFileSync } from 'child_process';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const EXT = path.resolve(HERE, '..', 'NostrComments-Chrome');
const ROOTDIR = path.resolve(HERE, '..');

// Which browser the suites drive. Chromium unless NC_BROWSER=firefox, so every existing suite runs
// against either without being edited:
//
//     node tests/browser-votes.mjs                  chromium
//     NC_BROWSER=firefox node tests/browser-votes.mjs
//
// Worth having because the two are not interchangeable in the ways that matter here. All four bugs
// found in real use on 9 August 2026 — signer identity across reloads, signer detection, the key
// not viewable after switching back — came from Firefox with a real NIP-07 signer, and every suite
// at the time ran only against Chromium.
export const BROWSER = process.env.NC_BROWSER === 'firefox' ? 'firefox' : 'chromium';

export function findFirefox() {
    if (process.env.FIREFOX) return process.env.FIREFOX;
    // /usr/local/bin/firefox is often a firejail symlink; geckodriver needs the real binary.
    for (const c of ['/usr/lib/firefox/firefox', '/usr/lib64/firefox/firefox', '/opt/firefox/firefox',
                     '/usr/bin/firefox', '/snap/firefox/current/usr/lib/firefox/firefox']) {
        try { if (fs.statSync(c).isFile() && fs.statSync(c).size > 100000) return c; } catch {}
    }
    throw new Error('No firefox found — set FIREFOX=/path/to/binary');
}

export function findGeckodriver() {
    if (process.env.GECKODRIVER) return process.env.GECKODRIVER;
    for (const c of [path.join(os.homedir(), 'tools/geckodriver'), path.join(os.homedir(), '.local/bin/geckodriver'),
                     '/usr/local/bin/geckodriver', '/usr/bin/geckodriver']) {
        try { if (fs.statSync(c).isFile()) return c; } catch {}
    }
    return 'geckodriver';   // hope it is on PATH; the spawn error says so if not
}

// Firefox installs an add-on, not a folder, so the build has to be zipped first. Done per run into
// the throwaway workdir rather than reusing dist/, so a suite never silently tests a stale package.
function packXpi(dir, into) {
    const xpi = path.join(into, 'ext.xpi');
    const root = path.resolve(dir, '..');
    execFileSync('zip', ['-qrX', xpi, 'content.js', 'injected.js', 'manifest.json'], { cwd: dir });
    execFileSync('zip', ['-qjX', xpi, path.join(root, 'icon48.png'), path.join(root, 'icon128.png')]);
    return xpi;
}

export function findChromium() {
    if (process.env.CHROMIUM) return process.env.CHROMIUM;
    for (const c of ['/usr/lib/chromium/chromium','/usr/lib/chromium-browser/chromium-browser','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/google-chrome-stable']) {
        try { if (fs.statSync(c).isFile() && fs.statSync(c).size > 100000) return c; } catch {}
    }
    throw new Error('No chromium found — set CHROMIUM=/path/to/binary');
}

// --- the real code under test, lifted out of the shipped source -----------------------------
// Extracted rather than reimplemented: a test that signs with its own crypto proves nothing about
// what ships.
export function extensionCode(extPath = EXT) {
    const src = fs.readFileSync(extPath + '/content.js', 'utf8');
    const s0 = src.indexOf('const _secp = (() => {'), s1 = src.indexOf('})();', s0) + 5;
    const _secp = eval(src.slice(s0, s1) + '; _secp');
    const t0 = src.indexOf('const _TRACKING'), t1 = src.indexOf('let pageUrl =', t0);
    const normalizeUrl = eval(src.slice(t0, t1) + '; normalizeUrl');
    const b0 = src.indexOf('        function toBech32(hrp, hex) {'), b1 = src.indexOf('        function fromBech32', b0);
    const toBech32 = eval(src.slice(b0, b1) + '; toBech32');

    const enc = new TextEncoder();
    const sign = async (priv, ev) => {
        const pubkey = _secp.pubKey(priv);
        const ser = JSON.stringify([0, pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
        const idb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(ser)));
        return { ...ev, pubkey, id: _secp.b2h(idb), sig: await _secp.sign(priv, idb) };
    };
    const verify = async ev => {
        const ser = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
        const idb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(ser)));
        return _secp.b2h(idb) === ev.id && await _secp.verify(ev.pubkey, idb, ev.sig);
    };
    const newKey = () => _secp.b2h(crypto.getRandomValues(new Uint8Array(32)));
    return { _secp, normalizeUrl, toBech32, sign, verify, newKey, enc };
}

export function reporter() {
    const state = { pass: 0, fail: 0 };
    const ok = (n, c, e) => {
        c ? (state.pass++, console.log('  ✓ ' + n))
          : (state.fail++, console.log('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e) : '')));
    };
    return { ok, state };
}

// --- a throwaway relay ----------------------------------------------------------------------
// Hand-rolled because the suites stay dependency-free. Single unfragmented text frames only, which
// is all the extension ever sends.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export function frame(txt) {
    const p = Buffer.from(txt);
    let head;
    if (p.length < 126) head = Buffer.from([0x81, p.length]);
    else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(p.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
    return Buffer.concat([head, p]);
}
export function unframe(buf) {
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const mlen = masked ? 4 : 0;
    if (buf.length < off + mlen + len) return null;
    const mask = masked ? buf.subarray(off, off + 4) : null;
    const payload = Buffer.from(buf.subarray(off + mlen, off + mlen + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    return { opcode, text: payload.toString('utf8'), rest: buf.subarray(off + mlen + len) };
}

export const matches = (f, ev) => {
    if (f.kinds && !f.kinds.includes(ev.kind)) return false;
    if (f.authors && !f.authors.includes(ev.pubkey)) return false;
    if (f.ids && !f.ids.includes(ev.id)) return false;
    // Tags are whatever the event says they are. A signature covers the serialisation, not the
    // shape, so `tags` can be a string, or a list of strings, and still verify — and a suite that
    // wants to serve one of those to the extension must not take the relay down first. This used
    // to be `(ev.tags || []).some(...)`, which throws on anything that is not an array, so the
    // harness could not represent a relay that misbehaves in the one way that matters.
    const tags = Array.isArray(ev.tags) ? ev.tags.filter(Array.isArray) : [];
    for (const k of Object.keys(f)) {
        if (k[0] !== '#') continue;
        if (!tags.some(t => t[0] === k.slice(1) && f[k].includes(t[1]))) return false;
    }
    return true;
};

export function makeCert() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nccert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    return dir;
}

// The extension only accepts wss:// relay URLs, so the relay speaks TLS with a throwaway
// self-signed certificate and Chrome is started with --ignore-certificate-errors.
//
// `onEvent(ev, { conn, accept, refuse, fanOut })` lets a suite decide what to do with a published
// event. The default accepts it, stores it and fans it out to every matching open subscription,
// which is what an ordinary relay does.
export async function startRelay({ port, onEvent, requireAuth = false, replyDelay = 0 } = {}) {
    const certDir = makeCert();
    const stored = [], published = [], conns = new Set();
    // NIP-42: challenge on connect, refuse everything until a valid kind-22242 comes back. The
    // signature is checked properly — a relay that accepted any old event would let a broken
    // client look like a working one.
    const { verify } = requireAuth ? extensionCode() : {};
    const authed = new Set(), authEvents = [];

    const fanOut = ev => {
        for (const c of conns) for (const [subid, filters] of c.subs)
            if (filters.some(f => matches(f, ev))) c.send(JSON.stringify(['EVENT', subid, ev]));
    };

    // Optional: a measurement can set relay.onTraffic to count sockets and bytes from this side.
    // Nothing in the extension knows or cares, which is the point — instrumenting the thing you
    // are measuring changes what you measure.
    const api = { onTraffic: null };
    const note = (type, bytes) => { try { api.onTraffic && api.onTraffic({ type, bytes }); } catch {} };

    const server = https.createServer({
        key: fs.readFileSync(path.join(certDir, 'key.pem')),
        cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
    }, (_, res) => { res.writeHead(426); res.end(); });

    server.on('upgrade', (req, socket) => {
        const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        const conn = {
            send: t => { note('out', Buffer.byteLength(t)); try { socket.write(frame(t)); } catch {} },
            subs: new Map(),
            close: () => { try { socket.destroy(); } catch {} conns.delete(conn); },
        };
        conns.add(conn);
        note('open', 0);
        const challenge = requireAuth ? crypto.randomBytes(8).toString('hex') : null;
        if (requireAuth) conn.send(JSON.stringify(['AUTH', challenge]));
        let buf = Buffer.alloc(0);
        socket.on('data', d => {
            buf = Buffer.concat([buf, d]);
            for (;;) {
                const m = unframe(buf);
                if (!m) break;
                buf = m.rest;
                if (m.opcode === 8) { conn.close(); return; }
                if (m.opcode !== 1) continue;
                note('in', Buffer.byteLength(m.text));
                let msg; try { msg = JSON.parse(m.text); } catch { continue; }
                if (requireAuth && msg[0] === 'AUTH') {
                    const ev = msg[1] || {};
                    const tag = n => (ev.tags || []).find(t => t[0] === n)?.[1];
                    (async () => {
                        const good = ev.kind === 22242 && tag('challenge') === challenge && !!tag('relay') && await verify(ev);
                        if (good) { authed.add(conn); authEvents.push(ev); }
                        conn.send(JSON.stringify(['OK', ev.id, good, good ? '' : 'invalid: bad authentication']));
                    })();
                    continue;
                }
                if (requireAuth && !authed.has(conn)) {
                    if (msg[0] === 'REQ') conn.send(JSON.stringify(['CLOSED', msg[1], 'auth-required: identify yourself first']));
                    else if (msg[0] === 'EVENT') conn.send(JSON.stringify(['OK', msg[1].id, false, 'auth-required: identify yourself first']));
                    continue;
                }
                if (msg[0] === 'REQ') {
                    const [, subid, ...filters] = msg;
                    conn.subs.set(subid, filters);
                    // `limit` is honoured per filter, newest first, the way a relay does it.
                    // Ignoring it — as this harness did at first — hides the one thing a limit can
                    // get wrong: a budget shared by several kinds, where the numerous ones crowd
                    // out the ones you came for.
                    // replyDelay models a relay that is simply slower than the others. Order of
                    // arrival is otherwise an accident of the loopback, and code that depends on it
                    // passes here and fails against the real network.
                    const respond = () => {
                        const sent = new Set();
                        for (const f of filters) {
                            const hits = stored.filter(ev => matches(f, ev)).sort((a, b) => b.created_at - a.created_at);
                            for (const ev of (typeof f.limit === 'number' ? hits.slice(0, f.limit) : hits)) {
                                if (sent.has(ev.id)) continue;
                                sent.add(ev.id);
                                conn.send(JSON.stringify(['EVENT', subid, ev]));
                            }
                        }
                        conn.send(JSON.stringify(['EOSE', subid]));
                    };
                    if (replyDelay) setTimeout(respond, replyDelay); else respond();
                } else if (msg[0] === 'CLOSE') {
                    conn.subs.delete(msg[1]);
                } else if (msg[0] === 'EVENT') {
                    const ev = msg[1];
                    published.push(ev);
                    const api = {
                        conn,
                        accept: () => { stored.push(ev); conn.send(JSON.stringify(['OK', ev.id, true, ''])); fanOut(ev); },
                        refuse: (reason, delay = 0) => setTimeout(() => conn.send(JSON.stringify(['OK', ev.id, false, reason])), delay),
                        fanOut,
                    };
                    if (onEvent) onEvent(ev, api); else api.accept();
                }
            }
        });
        socket.on('error', () => conns.delete(conn));
    });
    await new Promise(r => server.listen(port, '127.0.0.1', r));

    return {
        url: `wss://127.0.0.1:${port}`,
        stored, published, conns, fanOut, matches, authEvents,
        set onTraffic(fn) { api.onTraffic = fn; },
        get onTraffic() { return api.onTraffic; },
        close: () => { server.close(); fs.rmSync(certDir, { recursive: true, force: true }); },
    };
}

export async function startSite({ port, title = 'QA', heading = 'QA page' }) {
    const server = http.createServer((_, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><html><head><title>${title}</title></head><body style="font:16px sans-serif;padding:40px"><h1>${heading}</h1><p>Article body text.</p></body></html>`);
    });
    await new Promise(r => server.listen(port, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

// The panel lives in a shadow root attached to <html>; everything reaches in through `s`.
export const ROOT = `const host=[...document.documentElement.children].find(e=>e.shadowRoot&&e.shadowRoot.getElementById('donate'));if(!host)return null;const s=host.shadowRoot;`;

// The floating button and its two badges sit in that same shadow root. They used to hang in the
// page, where the site's own CSS could move or hide them.
//
// The document fallback is deliberate and is not dead code. Without it, a suite run against the
// old arrangement finds nothing and reports "badges missing" for every case — which proves only
// that they moved, not that moving them fixed anything. Looking in both places means the
// assertions are about behaviour, so browser-buttoncss.mjs fails against the light-DOM version
// for the actual reasons: badges hidden by the page, or folded into the middle of the button.
export const BADGE = `${ROOT}
  const _pick = id => s.getElementById(id) || document.getElementById(id);
  const nc = { btn: _pick('nc-btn'), red: _pick('nc-badge'), orange: _pick('nc-nbadge') };
  const ncText = el => el ? el.textContent : null;
  const ncShown = el => !!el && getComputedStyle(el).display !== 'none';`;

export async function startBrowser({ cdPort, extPath = EXT, prefix = 'ncqa-', windowSize = '1000,1700', onClose = () => {} }) {
    if (BROWSER === 'firefox') return startFirefox({ cdPort, prefix, onClose });
    // Chrome derives its crashpad database from HOME; a locked-down HOME makes the crash handler
    // abort the browser before the debugging port opens, which reads as "chromium is not installed".
    const W = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(W, 'home'), { recursive: true });
    const env = { ...process.env, HOME: path.join(W, 'home'), XDG_CONFIG_HOME: path.join(W, 'home/.config'), XDG_CACHE_HOME: path.join(W, 'home/.cache'), TMPDIR: W };
    const cd = spawn('chromedriver', [`--port=${cdPort}`], { stdio: ['ignore', 'ignore', 'ignore'], env });
    cd.on('error', e => { console.log('✗ could not start chromedriver: ' + e.message); process.exit(1); });
    const wd = async (m, p, b) => (await fetch(`http://127.0.0.1:${cdPort}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();

    let up = false;
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${cdPort}/status`); up = true; break; } catch { await new Promise(r => setTimeout(r, 250)); } }
    if (!up) { console.log(`✗ chromedriver did not come up on port ${cdPort}`); process.exit(1); }

    const sess = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'goog:chromeOptions': { binary: findChromium(), args: [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
        // The throwaway relay is self-signed; without this Chrome refuses the wss:// handshake.
        '--ignore-certificate-errors', '--allow-insecure-localhost',
        `--user-data-dir=${path.join(W, 'cd')}`, `--load-extension=${extPath}`, `--disable-extensions-except=${extPath}`,
        `--window-size=${windowSize}`] } } } });
    if (!sess.value?.sessionId) {
        console.log('✗ could not start a browser session:\n  ' + (sess.value?.message || JSON.stringify(sess)).split('\n')[0]);
        console.log('  (a stale chromedriver on the same port is a common cause)');
        process.exit(1);
    }
    const sid = sess.value.sessionId;
    const js = async c => (await wd('POST', `/session/${sid}/execute/sync`, { script: `return (function(){${c}})()`, args: [] })).value;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const goto = url => wd('POST', `/session/${sid}/url`, { url });
    const finish = async code => {
        await wd('DELETE', `/session/${sid}`).catch(() => {});
        cd.kill();
        onClose();
        fs.rmSync(W, { recursive: true, force: true });
        process.exit(code);
    };
    return { wd, js, wait, goto, sid, finish };
}

// Consent, point the extension at our relay alone, and give it a key to sign with. Five suites
// opened with the same fifteen lines; the relay list has to be emptied first or the six shipped
// defaults are contacted for real.
// Same shape as startBrowser, over geckodriver. Kept as its own function rather than branching
// through the Chromium one: the two share only the WebDriver calls, and interleaving them would
// make both harder to read than either is alone.
async function startFirefox({ cdPort, prefix, onClose }) {
    const W = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(W, 'home'), { recursive: true });
    const env = { ...process.env, HOME: path.join(W, 'home'), TMPDIR: W };
    const gd = spawn(findGeckodriver(), ['--port', String(cdPort), '--log', 'fatal'],
        { stdio: ['ignore', 'ignore', 'ignore'], env });
    gd.on('error', e => { console.log('✗ could not start geckodriver: ' + e.message); process.exit(1); });
    const wd = async (m, p, b) => (await fetch(`http://127.0.0.1:${cdPort}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();

    let up = false;
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${cdPort}/status`); up = true; break; } catch { await new Promise(r => setTimeout(r, 250)); } }
    if (!up) { console.log(`✗ geckodriver did not come up on port ${cdPort}`); process.exit(1); }

    const sess = await wd('POST', '/session', { capabilities: { alwaysMatch: {
        'moz:firefoxOptions': { binary: findFirefox(), args: ['-headless'] },
        // The throwaway relay is self-signed; Firefox's equivalent of --ignore-certificate-errors.
        acceptInsecureCerts: true } } });
    if (!sess.value?.sessionId) {
        console.log('✗ could not start a Firefox session:\n  ' + (sess.value?.message || JSON.stringify(sess)).split('\n')[0]);
        process.exit(1);
    }
    const sid = sess.value.sessionId;

    // Unsigned, so it has to go in as temporary — which is also what "load a fresh build" means here.
    const add = await wd('POST', `/session/${sid}/moz/addon/install`,
        { path: packXpi(path.resolve(ROOTDIR, 'NostrComments-FireFox'), W), temporary: true });
    if (!add.value) {
        console.log('✗ could not install the add-on:\n  ' + JSON.stringify(add).slice(0, 200));
        process.exit(1);
    }

    const js = async c => (await wd('POST', `/session/${sid}/execute/sync`, { script: `return (function(){${c}})()`, args: [] })).value;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const goto = url => wd('POST', `/session/${sid}/url`, { url });
    const finish = async code => {
        await wd('DELETE', `/session/${sid}`).catch(() => {});
        gd.kill();
        onClose();
        fs.rmSync(W, { recursive: true, force: true });
        process.exit(code);
    };
    return { wd, js, wait, goto, sid, finish };
}

export function configureScript({ relayUrl, nsec }) {
    const urls = Array.isArray(relayUrl) ? relayUrl : [relayUrl];
    return `${ROOT}
      s.getElementById('m').style.display='grid';
      const o=[...s.getElementById('p').children].find(c=>c.textContent.includes('One quick thing'));
      if(o) o.querySelector('button').click();
      s.getElementById('gear-btn').click();
      // Off, or every suite that publishes would also fire the event at the three real
      // EXTRA_PUBLISH_RELAYS. A test that touches the public network is not a test, and one that
      // writes to somebody else's relay on every run is worse than that.
      const _wp = s.getElementById('widepub-toggle');
      if (_wp && _wp.checked) _wp.click();
      let guard=0;
      while (s.getElementById('relay-list').querySelector('.relay-remove') && guard++<50)
          s.getElementById('relay-list').querySelector('.relay-remove').click();
      ${urls.map(u => `s.getElementById('relay-input').value=${JSON.stringify(u)};
      s.getElementById('relay-add-btn').click();`).join('\n      ')}
      ${nsec ? `s.getElementById('privkey-import').value=${JSON.stringify(nsec)};
      s.getElementById('privkey-import-btn').click();` : ''}
      return 1;`;
}
