// What one page visit costs in relay connections and bytes.
//
// Not instrumentation: nothing is added to the extension. The throwaway relay already sees every
// socket that opens and every frame that crosses it, so the count comes from the other end of the
// wire. Delete this file and the extension is exactly as it was.
//
// It reports three situations, because they are what the eager/lazy question is actually about:
// a page nobody looks at, a page somebody reads without opening the panel, and a page where the
// panel is opened.
//
//   node tests/measure-connections.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9528);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8085);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8455);

const { normalizeUrl, toBech32, sign, newKey } = extensionCode();
const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Measurement page' });

const PAGE = normalizeUrl(site.url);
const ME = newKey(), AUTHOR = newKey();
const now = Math.floor(Date.now() / 1000);
for (let i = 0; i < 5; i++) {
    relay.stored.push(await sign(AUTHOR, {
        kind: 1111, created_at: now - 500 + i,
        tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
        content: `Comment ${i + 1} on the measured page.`,
    }));
}

const { js, wait, goto, wd, sid, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncmeas-',
    onClose: () => { site.close(); relay.close(); },
});

// Counted from the relay side: sockets opened, and bytes of REQ/EVENT traffic in both directions.
let sockets = 0, bytesIn = 0, bytesOut = 0;
relay.onTraffic = ev => {
    if (ev.type === 'open') sockets++;
    else if (ev.type === 'in') bytesIn += ev.bytes;
    else if (ev.type === 'out') bytesOut += ev.bytes;
};
const reset = () => { sockets = 0; bytesIn = 0; bytesOut = 0; };
const report = label => console.log(
    `  ${label.padEnd(44)} ${String(sockets).padStart(3)} sockets   ` +
    `${String(bytesIn).padStart(6)} B up   ${String(bytesOut).padStart(7)} B down`);

await goto(site.url);
await wait(3000);
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);

console.log('\nOne page visit, measured at the relay:\n');

// 1. a page loaded and left alone, panel never opened
reset();
await goto(site.url);
await wait(9000);
report('read, panel never opened');

// 2. the same, then the panel opened
reset();
await goto(site.url);
await wait(9000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(4000);
report('read, then panel opened');

// 3. a visit abandoned after a second — the common case while browsing
reset();
await goto(site.url);
await wait(1000);
await goto('about:blank');
await wait(6000);
report('opened and left after one second');

// 4. a tab opened in the background and never looked at — middle-clicking a batch of links.
// Headless Chrome does not always report a backgrounded tab as hidden, so this reports what it
// observed rather than asserting: a 0 here means the rule held, anything else means the browser
// considered the tab visible and the measurement says nothing either way.
reset();
await goto(site.url);
const extra = await wd('POST', `/session/${sid}/window/new`, { type: 'tab' });
await wait(9000);
const hidden = await js(`return document.visibilityState;`);
report(`background tab (reported as "${hidden}")`);
try { await wd('DELETE', `/session/${sid}/window`); } catch {}

console.log('');
await finish(0);
