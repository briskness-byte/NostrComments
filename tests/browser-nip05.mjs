// Verified names (NIP-05), and the domain that must not be contacted unless you ask.
//
// A profile can claim a name@domain. Checking it means fetching from that domain — which tells the
// domain that somebody is reading a page where that person commented, and hands it the reader's IP.
// Every other request this extension makes goes to relays the user chose. So the check is off
// unless switched on, and this suite pins both halves: silence by default, and a mark that only
// appears once the domain has actually confirmed the pubkey.
//
// The "domain" here is a local server that answers /.well-known/nostr.json and counts its callers.
//
//   node tests/browser-nip05.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-nip05.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import https from 'https';
import fs from 'fs';
import path from 'path';
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, makeCert, ROOT, BROWSER } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9526);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8088);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8453);
const WELLKNOWN_PORT = Number(process.env.QA_WK_PORT || 8087);

const { _secp, normalizeUrl, toBech32, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored } = relay;
const site = await startSite({ port: SITE_PORT, heading: 'NIP-05 QA page' });

// The claimed domain. It records every lookup, which is the thing the default has to avoid.
const lookups = [];
// NIP-05 mandates https, so this has to be TLS as well — a plain http server here would only
// prove that the extension refuses to talk to it.
const wkCert = makeCert();
const wellKnown = https.createServer({
    key: fs.readFileSync(path.join(wkCert, 'key.pem')),
    cert: fs.readFileSync(path.join(wkCert, 'cert.pem')),
}, (req, res) => {
    lookups.push(req.url);
    const name = new URL(req.url, 'http://x').searchParams.get('name');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ names: name === 'alice' ? { alice: ALICE_PUB } : {} }));
});

const PAGE = normalizeUrl(site.url);
const ME = newKey();
const ALICE = newKey(), ALICE_PUB = _secp.pubKey(ALICE);
const now = Math.floor(Date.now() / 1000);

await new Promise(r => wellKnown.listen(WELLKNOWN_PORT, '127.0.0.1', r));
// A name, not 127.0.0.1:8087. Since 23.0.8 the extension accepts only plain domain names here — an
// address literal or a port is how a profile would aim a lookup at the reader's own network — so a
// claim carrying either is refused before any request goes out, and this suite would be asserting
// against a guard rather than against the feature.
//
// The name is mapped onto the local server below, port and all. Only Chromium can do that; Firefox
// resolves names to localhost but cannot redirect a port, so the suite says so and stops rather than
// reporting failures that are about the harness.
const DOMAIN = 'nip05.example';

stored.push(await sign(ALICE, {
    kind: 0, created_at: now - 400, tags: [],
    content: JSON.stringify({ name: 'alice', nip05: `alice@${DOMAIN}` }),
}));
stored.push(await sign(ALICE, {
    kind: 1111, created_at: now - 300, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'A comment by somebody who claims a verified name.',
}));

if (BROWSER === 'firefox') {
    console.log('\nSkipped on Firefox: this suite needs a hostname redirected to a local port, which');
    console.log('only Chromium can do. The host check itself is covered for all three builds by');
    console.log('nip05host.test.mjs, which runs in `node tests/run.mjs`.');
    wellKnown.close(); site.close(); relay.close();
    process.exit(0);
}

const { js, wait, goto, finish } = await startBrowser({
    resolverRules: [`MAP ${DOMAIN}:443 127.0.0.1:${WELLKNOWN_PORT}`],
    cdPort: CD_PORT, prefix: 'ncnip05-',
    onClose: () => { site.close(); relay.close(); wellKnown.close(); fs.rmSync(wkCert, { recursive: true, force: true }); },
});

console.log(`\nrelay:  ${relay.url}\nclaim:  alice@${DOMAIN}\n`);
await goto(site.url);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);
await goto(site.url);
await wait(5000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(3000);

const view = () => js(`${ROOT}
  const c = s.getElementById('list').querySelector('.c');
  return JSON.stringify({ loaded: !!c, name: c ? c.textContent.slice(0, 40) : null,
                          ticks: s.getElementById('list').querySelectorAll('.nc-nip05').length });`);

console.log('\n=== by default, nobody is contacted ===');
let v = JSON.parse(await view() || '{}');
ok('the comment and its profile load', v.loaded === true && /alice/i.test(v.name || ''), v);
// The whole argument for the default: a domain learns nothing about who is reading what.
ok('the claimed domain was never asked', lookups.length === 0, lookups);
ok('and no verification mark is shown', v.ticks === 0, v);

console.log('\n=== once switched on ===');
await js(`${ROOT}
  s.getElementById('gear-btn').click();
  s.getElementById('nip05-toggle').click();
  s.getElementById('gear-btn').click();
  return 1;`);
await wait(3000);
v = JSON.parse(await view() || '{}');
ok('the domain is asked', lookups.length >= 1, lookups);
ok('it is asked for the claimed name', (lookups[0] || '').includes('name=alice'), lookups[0]);
ok('the mark appears once the domain confirms the key', v.ticks === 1, v);

console.log('\n=== and switched off again ===');
const seen = lookups.length;
await js(`${ROOT}
  s.getElementById('gear-btn').click();
  s.getElementById('nip05-toggle').click();
  s.getElementById('gear-btn').click();
  return 1;`);
await wait(2000);
v = JSON.parse(await view() || '{}');
ok('the mark goes away again', v.ticks === 0, v);
ok('and nothing more is fetched', lookups.length === seen, { seen, now: lookups.length });

console.log(`\n${state.fail === 0 ? '✓' : '✗'} nip05: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
