// What a page can make the panel do, and see, without the reader touching it.
//
// The panel sits in an open shadow root, so a page can reach every control in it. Most controls that
// change something or sign something already ask for a real gesture (browser-keyexposure). This suite
// covers the rest of what a page could do from script alone, each one found by trying it:
//
//   - open the panel itself (the button, or by writing the panel's style) and read what is only drawn
//     while the panel is open: the reader's public key, the pages they have commented on, the sites
//     they switched off, their muted words, who has replied to them. Public keys are public, but a
//     site that can learn which pseudonym is reading it, and where else that pseudonym has been,
//     has been given something no relay was chosen to hold;
//   - press the zap button on a comment. That signs a zap request with the reader's key and sends it
//     to whatever lightning address the commenter's profile names — which can be a server the page
//     itself runs;
//   - flip privacy settings (Verified names contacts other people's domains) or switch which key signs;
//   - forge the browser's report that the site's policy blocks a relay.
//
// Every case has its control: the same thing done by a real click must still work, or a pass could
// mean the panel is simply dead.
//
//   node tests/browser-pagedrive.mjs
//   NC_BROWSER=firefox node tests/browser-pagedrive.mjs        (the zap case needs Chromium's resolver rules)
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import https from 'https';
import fs from 'fs';
import path from 'path';
import { extensionCode, reporter, startRelay, startSite, startBrowser, seedStorage, nsecToHex, makeCert, ROOT, BROWSER } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9702);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8704);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8705);
const LNURL_PORT = Number(process.env.QA_LNURL_PORT || 8706);

const { _secp, normalizeUrl, toBech32, sign, verify, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Page drive QA page' });
const ME = newKey(), ME_PUB = _secp.pubKey(ME), OTHER = newKey(), OTHER_PUB = _secp.pubKey(OTHER);
const now = Math.floor(Date.now() / 1000);
const PAGE = normalizeUrl(site.url);
const NPUB = toBech32('npub', ME_PUB);

// Something the reader has done elsewhere, and a commenter here whose profile names a lightning
// address on a domain that, for this suite, is a server of its own.
relay.stored.push(await sign(ME, { kind: 1111, created_at: now - 100, tags: [['I', 'https://clinic.example/support-group'], ['K', 'web'], ['i', 'https://clinic.example/support-group'], ['k', 'web']], content: 'my comment' }));
relay.stored.push(await sign(OTHER, { kind: 0, created_at: now - 500, tags: [], content: JSON.stringify({ name: 'friendly', lud16: 'pay@lnurl.nctest' }) }));
relay.stored.push(await sign(OTHER, { kind: 1111, created_at: now - 400, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'a comment that carries a zap button' }));

const zapRequests = [];
let lnurl = null;
if (BROWSER === 'chromium') {
    const dir = makeCert();
    lnurl = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
        const u = new URL(req.url, 'https://lnurl.nctest');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        if (u.pathname.startsWith('/.well-known/lnurlp/'))
            return res.end(JSON.stringify({ callback: 'https://lnurl.nctest/cb', minSendable: 1000, maxSendable: 1e9, allowsNostr: true, nostrPubkey: OTHER_PUB, tag: 'payRequest' }));
        zapRequests.push(u.searchParams.get('nostr'));
        res.end(JSON.stringify({ status: 'ERROR', reason: 'no invoice' }));
    });
    await new Promise(r => lnurl.listen(LNURL_PORT, '127.0.0.1', r));
}

const { js, jsRaw, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncpd-',
    resolverRules: BROWSER === 'chromium' ? [`MAP lnurl.nctest:443 127.0.0.1:${LNURL_PORT}`] : [],
    onClose: () => { site.close(); relay.close(); lnurl && lnurl.close(); },
});

await goto(site.url); await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

const seed = () => js(seedStorage({
    nostrcomments_consent: true, nostrcomments_relays: [relay.url], nostrcomments_widepublish: false,
    nostrcomments_privkey: nsecToHex(toBech32('nsec', ME)),
    nostrcomments_disabled: ['https://bank.example', 'https://clinic.example'], nostrcomments_mutewords: ['cancer'] }));
await seed(); await wait(2000);
await goto(site.url); await wait(7000);

// What the panel is showing about the reader, as a page would read it.
const shown = () => js(`${ROOT} const t = id => (s.getElementById(id) || {}).textContent || '';
  return JSON.stringify({ npub: t('identity-npub'), hex: t('identity-hex'), threads: t('mythreads'), disabled: t('disabled-list'),
                          muted: t('muteword-list'), relays: t('relay-list'), notifs: t('notiflist'), banner: t('notif-banner') });`).then(JSON.parse);
const anythingShown = o => Object.values(o).some(v => v && v.length);

console.log('\n=== a page opens the panel by itself ===');
ok('panel closed: nothing about the reader is in the DOM', !anythingShown(await shown()), await shown());
await jsRaw(`${ROOT} s.getElementById('nc-btn').click(); return 1;`); await wait(800);
await jsRaw(`${ROOT} s.getElementById('gear-btn').click(); return 1;`); await wait(3500);
const viaClick = await shown();
ok('clicking the button and Settings from script shows nothing', !anythingShown(viaClick), viaClick);
await jsRaw(`${ROOT} s.getElementById('m').style.display = 'none'; return 1;`); await wait(400);
await jsRaw(`${ROOT} s.getElementById('m').style.display = 'grid'; s.getElementById('settings').style.display = 'block'; s.getElementById('gear-btn').click(); return 1;`); await wait(3500);
const viaStyle = await shown();
ok('writing the panel\'s style from script shows nothing', !anythingShown(viaStyle), viaStyle);
await jsRaw(`${ROOT} s.getElementById('m').style.display = 'none'; s.getElementById('settings').style.display = 'none'; return 1;`); await wait(600);

console.log('\n=== the reader opens it: the same things appear ===');
await nclick("s.getElementById('nc-btn')"); await wait(1500);
await js(`${ROOT} if (s.getElementById('settings').style.display !== 'block') s.getElementById('gear-btn').click(); return 1;`); await wait(4000);
const real = await shown();
ok('the public key is shown', real.npub === NPUB, real.npub);
ok('the pages the reader has commented on are listed', /clinic\.example\/support-group/.test(real.threads), real.threads);
ok('the disabled sites are listed', /bank\.example/.test(real.disabled), real.disabled);
ok('the muted words are listed', /cancer/.test(real.muted), real.muted);
ok('the relays are listed', /127\.0\.0\.1/.test(real.relays), real.relays);

console.log('\n=== and closing it takes them away again ===');
await nclick("s.getElementById('c')"); await wait(800);
const closed = await shown();
ok('nothing about the reader is left after closing', !anythingShown(closed), closed);

console.log('\n=== replies from strangers are not drawn while the panel is closed ===');
const stranger = newKey();
const reply = await sign(stranger, { kind: 1111, created_at: Math.floor(Date.now() / 1000), tags: [['I', 'https://elsewhere.example/post'], ['K', 'web'], ['p', ME_PUB]], content: 'Thanks for the comment' });
let routed = 0;
for (const c of relay.conns) for (const [id, f] of c.subs) if (f.some(x => x['#p'])) { c.send(JSON.stringify(['EVENT', id, reply])); routed++; }
ok('a notification subscription was listening', routed >= 1, routed);
await wait(2500);
const whileClosed = await shown();
ok('the reply appears in neither the list nor the banner', !whileClosed.notifs && !whileClosed.banner, whileClosed);
await nclick("s.getElementById('nc-btn')"); await wait(1500);
ok('the reader opening the panel gets the banner', /Thanks for the comment/.test((await shown()).banner), await shown());
await nclick("s.getElementById('c')"); await wait(500);

console.log('\n=== controls that change what the reader chose ===');
await nclick("s.getElementById('nc-btn')"); await wait(1200);
await js(`${ROOT} if (s.getElementById('settings').style.display !== 'block') s.getElementById('gear-btn').click(); return 1;`); await wait(800);
const flip = await js(`${ROOT} const t = s.getElementById('nip05-toggle'); t.checked = true; t.dispatchEvent(new Event('change', {bubbles:true})); return t.checked;`);
ok('a script cannot switch "Verified names" on', flip === false, flip);
await js(`${ROOT} const b = [...s.querySelectorAll('button')].find(x => /Connect your Nostr signer/.test(x.textContent)); if (b) b.click(); return !!b;`);
await wait(1200);
const flipped = await js(`${ROOT} return s.getElementById('msg').textContent;`);
ok('a script cannot switch which key signs', !/signer/i.test(flipped || ''), flipped);
await nclick("s.getElementById('nip05-toggle')"); await wait(500);
ok('control: the reader can switch "Verified names" on', await js(`${ROOT} return s.getElementById('nip05-toggle').checked;`) === true);
await nclick("s.getElementById('c')"); await wait(500);

console.log('\n=== a forged policy-violation report ===');
await js(`${ROOT} return 1;`);
await js(`document.dispatchEvent(new SecurityPolicyViolationEvent('securitypolicyviolation', {blockedURI: ${JSON.stringify(relay.url)}, effectiveDirective: 'connect-src', violatedDirective: 'connect-src'})); return 1;`);
await wait(800);
await nclick("s.getElementById('nc-btn')"); await wait(1500);
await js(`${ROOT} if (s.getElementById('settings').style.display !== 'block') s.getElementById('gear-btn').click(); return 1;`); await wait(1500);
const st = await js(`${ROOT} return s.getElementById('relay-list').textContent;`);
ok('the relay is not reported as blocked by the site', !/blocked by this site/.test(st || ''), st);
await nclick("s.getElementById('c')"); await wait(500);

if (BROWSER === 'chromium') {
    console.log('\n=== the zap button ===');
    await goto(site.url); await wait(7000);
    await nclick("s.getElementById('nc-btn')"); await wait(1500);
    const zaps = await js(`${ROOT} return s.querySelectorAll('.zap-btn').length;`);
    ok('the thread shows the commenter with a zap button', zaps >= 1, zaps);
    await js(`${ROOT} s.querySelector('.zap-btn').click(); return 1;`); await wait(3500);
    ok('a script cannot make the extension sign a zap request', zapRequests.length === 0, zapRequests.length);
    await nclick("s.querySelector('.zap-btn')"); await wait(3500);
    const sent = zapRequests.map(z => z && JSON.parse(z)).find(Boolean);
    ok('control: the reader pressing it does send one, signed by the reader', !!sent && sent.kind === 9734 && sent.pubkey === ME_PUB && await verify(sent), sent && { kind: sent.kind, pubkey: sent.pubkey });
}

console.log(`\n${state.fail === 0 ? '✓' : '✗'} page drive: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
