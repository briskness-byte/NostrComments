// Publishing a display name without destroying the rest of a profile.
//
// Somebody who generates a key here has no kind 0, so every comment they write shows npub1abc… and
// a thread of those is not a conversation. One field fixes that. The danger is what the field is
// built on: kind 0 is replaceable, so publishing one replaces the *whole* object rather than the
// field being set. A profile made in another client carries a picture, an about, a website, a
// nip05, and writing {"name":"…"} over it destroys all of them at once.
//
// The first version of this refused whenever a profile existed. That was wrong in a way worth
// recording: it made a typo permanent, because the only way to correct a name was to export the
// nsec into another app — the exact habit this extension exists to avoid. So it merges, like every
// other client, and refuses only when it cannot see what it would be replacing: no relay answered,
// or the existing profile is not readable JSON. Those two are the tests that matter.
//
//   node tests/browser-setname.mjs
//   NC_BROWSER=firefox node tests/browser-setname.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, makeCert, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9546);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8105);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8473);
const SLOW_PORT = Number(process.env.QA_SLOW_PORT || 8474);

const { _secp, toBech32, sign, newKey, verify } = extensionCode();
const { ok, state } = reporter();

const published = [];
const relay = await startRelay({ port: RELAY_PORT, onEvent: (ev, api) => { published.push(ev); api.accept(); } });
const slow = await startRelay({ port: SLOW_PORT, replyDelay: 1500 });
const site = await startSite({ port: SITE_PORT, heading: 'Set name QA page' });

// Two identities: one that has never published anything, and one with a full profile to protect.
const FRESH = newKey(), FRESH_PUB = _secp.pubKey(FRESH);
const HASPROFILE = newKey(), HASPROFILE_PUB = _secp.pubKey(HASPROFILE);
const RICH = { name: 'Robin', about: 'builds things', picture: 'https://example.com/a.png',
               website: 'https://example.com', nip05: 'user@example.com', lud16: 'user@example.com',
               display_name: 'Robin Displayed', displayName: 'Robin Displayed' };
relay.stored.push(await sign(HASPROFILE, { kind: 0, created_at: Math.floor(Date.now() / 1000) - 500,
    content: JSON.stringify(RICH), tags: [['client', 'Some Other App']] }));

// Half a profile: a display_name and no name at all. 4.3% of profiles measured on the public relays
// look like this, and without a fallback they would show as npub1… here while every other client
// shows a name.
const DISPLAYONLY = newKey(), DISPLAYONLY_PUB = _secp.pubKey(DISPLAYONLY);
relay.stored.push(await sign(DISPLAYONLY, { kind: 0, created_at: Math.floor(Date.now() / 1000) - 400,
    content: JSON.stringify({ display_name: 'Only Displayed', about: 'no name field' }), tags: [] }));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncsn-',
    onClose: () => { site.close(); relay.close(); slow.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

const setup = async (nsec, relayUrl = `wss://127.0.0.1:${RELAY_PORT}`) => {
    await js(configureScript({ relayUrl, nsec }));
    await wait(1500);
    await js(`${ROOT}
      const o = [...s.getElementById('p').children].find(c => c.style.zIndex === '28' && getComputedStyle(c).display !== 'none');
      if (o) [...o.querySelectorAll('button')].find(b => /not now/i.test(b.textContent))?.click();
      return 1;`);
    await wait(600);
    // Importing over a key already stored here asks first, and that dialog blocks the import.
    await js(`${ROOT}
      const ov = [...s.getElementById('p').children].find(c => c.style.zIndex === '30' && getComputedStyle(c).display !== 'none');
      if (ov) [...ov.querySelectorAll('button')].find(b => /^Replace it$/i.test(b.textContent))?.click();
      return 1;`);
    await wait(1500);
};
const row = () => js(`${ROOT} return JSON.stringify({
  shown: getComputedStyle(s.getElementById('setname-row')).display !== 'none',
  name: s.getElementById('identity-name').textContent,
  input: s.getElementById('setname-input').value,
  avatar: s.getElementById('identity-avatar').src,
  lead: s.getElementById('setname-lead').textContent,
  btn: s.getElementById('setname-btn').textContent,
  msg: s.getElementById('msg').textContent });`);
const publishName = async n => {
    await js(`${ROOT}
      s.getElementById('setname-input').value = ${JSON.stringify(n)};
      s.getElementById('setname-btn').click(); return 1;`);
    await wait(4000);
};

// --- the dangerous half, first --------------------------------------------------------------------
console.log('\n=== changing the name on a full profile keeps the rest of it ===');
await setup(toBech32('nsec', HASPROFILE));
await wait(2500);
let r = JSON.parse(await row());
ok('the field is offered even though a name exists', r.shown === true, r);
// What the panel shows and what the field edits have to be the same field. Reading display_name
// first would show 'Robin Displayed' while the button changed 'Robin', so publishing would appear to
// do nothing for the third of profiles whose two fields differ.
ok('the card shows name, not display_name', r.name === 'Robin', r.name);
ok('the field is filled with the name, so it can be corrected', r.input === 'Robin', r.input);
ok('and the button offers to change it', /change name/i.test(r.btn), r.btn);
ok('the other name is named rather than silently kept', /Robin Displayed/.test(r.lead), r.lead);

published.length = 0;
await publishName('Robin Renamed');
const merged = published.find(e => e.kind === 0);
ok('a kind 0 is published', !!merged, published.map(e => e.kind));
let m = null; try { m = JSON.parse(merged.content); } catch (e) {}
ok('the new name is in it', m?.name === 'Robin Renamed', m?.name);
// The whole reason this suite exists: a replaceable event carries everything or destroys it.
ok('the picture survived', m?.picture === RICH.picture, m?.picture);
ok('the about survived', m?.about === RICH.about, m?.about);
ok('the website survived', m?.website === RICH.website, m?.website);
ok('the nip05 survived', m?.nip05 === RICH.nip05, m?.nip05);
ok('the lightning address survived', m?.lud16 === RICH.lud16, m?.lud16);
// The point of the whole decision: this panel writes name and leaves the rest of the naming to the
// app that owns it. NIP-24 calls displayName deprecated, so it is neither read nor written here —
// but not writing it is not the same as destroying it.
ok('display_name was left alone', m?.display_name === 'Robin Displayed', m?.display_name);
ok('displayName was left alone too', m?.displayName === 'Robin Displayed', m?.displayName);
ok('and the client tag was not copied', !merged.tags.some(t => t[0] === 'client'), merged.tags);
ok('nothing was invented either', Object.keys(m || {}).sort().join() === Object.keys(RICH).sort().join(),
   Object.keys(m || {}).sort());
// A replaceable event only wins if it is newer than the one it replaces.
const prev = relay.stored.find(e => e.kind === 0 && e.pubkey === HASPROFILE_PUB);
ok('and it is newer than the profile it replaces', merged.created_at > prev.created_at,
   { new: merged.created_at, old: prev.created_at });

// Kind 0 is replaceable, so a copy left behind on a relay that has not caught up is not extra
// information — it is a wrong answer. Every relay is asked, and applying whichever answered last
// let one slow relay put an old name back over a new one. That is worse than a display bug now
// that the field is prefilled: it offers to publish the stale name back.
console.log('\n=== an old copy on a slow relay does not win ===');
const STALE = newKey();
const nowS = Math.floor(Date.now() / 1000);
relay.stored.push(await sign(STALE, { kind: 0, created_at: nowS - 60,
    content: JSON.stringify({ name: 'New Name', picture: 'https://example.com/new.png' }), tags: [] }));
slow.stored.push(await sign(STALE, { kind: 0, created_at: nowS - 3600,
    content: JSON.stringify({ name: 'Old Name', picture: 'https://example.com/old.png' }), tags: [] }));
await goto(site.url); await wait(2500);
await setup(toBech32('nsec', STALE), [`wss://127.0.0.1:${RELAY_PORT}`, `wss://127.0.0.1:${SLOW_PORT}`]);
await wait(5000);                                  // longer than the slow relay takes to answer
r = JSON.parse(await row());
ok('the newest profile wins, not the last one to arrive', r.name === 'New Name', r.name);
ok('the field offers the new name, so it cannot be published back', r.input === 'New Name', r.input);
ok('and the rest of the stale copy is not applied either', /new\.png$/.test(r.avatar), r.avatar);

console.log('\n=== a profile with only a display_name still shows a name ===');
await goto(site.url); await wait(2500);
await setup(toBech32('nsec', DISPLAYONLY));
await wait(2500);
r = JSON.parse(await row());
ok('display_name is used when there is no name', r.name === 'Only Displayed', r.name);
ok('but the field stays empty, because that is not the field it edits', r.input === '', r.input);
ok('and it offers to publish rather than to change', /publish name/i.test(r.btn), r.btn);

console.log('\n=== a profile it cannot read is never replaced ===');
const OPAQUE = newKey();
relay.stored.push(await sign(OPAQUE, { kind: 0, created_at: Math.floor(Date.now() / 1000) - 300,
    content: 'this is not json at all', tags: [] }));
await goto(site.url); await wait(2500);
await setup(toBech32('nsec', OPAQUE));
await wait(2500);
published.length = 0;
await publishName('Should Not Publish');
ok('nothing is published over an unreadable profile', published.filter(e => e.kind === 0).length === 0,
   published.filter(e => e.kind === 0).map(e => e.content));
r = JSON.parse(await row());
ok('and it says so', /cannot read/i.test(r.msg), r.msg);

// --- the ordinary case ------------------------------------------------------------------------------
console.log('\n=== a key with no profile can publish one name ===');
await goto(site.url);
await wait(2500);
await setup(toBech32('nsec', FRESH));
await wait(2500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn').click(); return 1;`);
await wait(1200);
r = JSON.parse(await row());
ok('the field is offered', r.shown === true, r);
ok('and the card says no name is published', /no profile name published/i.test(r.name), r.name);

published.length = 0;
await publishName('  Nieuwe   Gebruiker  ');
const ev = published.find(e => e.kind === 0);
ok('a kind 0 is published', !!ev, published.map(e => e.kind));
ok('it verifies', ev ? await verify(ev) : false);
ok('signed by this key', ev?.pubkey === FRESH_PUB, ev?.pubkey?.slice(0, 12));
let content = null; try { content = JSON.parse(ev.content); } catch (e) {}
ok('it carries the name, whitespace tidied', content?.name === 'Nieuwe Gebruiker', content?.name);
ok('and nothing else — no picture, no about invented', Object.keys(content || {}).join() === 'name', Object.keys(content || {}));

await wait(1500);
r = JSON.parse(await row());
ok('the identity card shows it', /Nieuwe Gebruiker/.test(r.name), r.name);
ok('and the field stays, so a typo can be corrected', r.shown === true, r);

console.log('\n=== correcting it afterwards works ===');
published.length = 0;
await publishName('Corrected Name');
const second = published.find(e => e.kind === 0);
ok('the name can be changed again', !!second, published.map(e => e.kind));
let c2 = null; try { c2 = JSON.parse(second.content); } catch (e) {}
ok('and it carries the new one', c2?.name === 'Corrected Name', c2?.name);

// The guard against publishing blind. A relay that accepts the socket and says nothing is the case
// that matters: "this key has no profile" and "nobody told us either way" are indistinguishable
// without checking, and only one of them is safe to write over.
console.log('\n=== nothing is published when no relay answers ===');
const MUTE_PORT = RELAY_PORT + 3;
const mute = await (async () => {
    const dir = makeCert();
    const server = https.createServer({
        key: fs.readFileSync(path.join(dir, 'key.pem')),
        cert: fs.readFileSync(path.join(dir, 'cert.pem')),
    });
    const socks = new Set();
    server.on('upgrade', (req, socket) => {
        const a = crypto.createHash('sha1')
            .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
                     'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + a + '\r\n\r\n');
        socks.add(socket);
        socket.on('error', () => socks.delete(socket));
    });
    await new Promise(r => server.listen(MUTE_PORT, '127.0.0.1', r));
    return { close: () => { for (const x of socks) x.destroy(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
})();

await goto(site.url); await wait(2000);
// Point the panel at the silent relay alone, so nothing can answer the lookup.
await js(`${ROOT}
  s.getElementById('m').style.display='grid';
  s.getElementById('gear-btn').click();
  let g = 0;
  while (s.getElementById('relay-list').querySelector('.relay-remove') && g++ < 50)
      s.getElementById('relay-list').querySelector('.relay-remove').click();
  s.getElementById('relay-input').value = 'wss://127.0.0.1:${MUTE_PORT}';
  s.getElementById('relay-add-btn').click();
  return 1;`);
await wait(800);
published.length = 0;
await publishName('Published Blind');
await wait(4000);
ok('no kind 0 goes out when nothing could be checked', published.filter(e => e.kind === 0).length === 0,
   published.filter(e => e.kind === 0).map(e => e.content));
r = JSON.parse(await row());
ok('and it says the check could not be made', /no relay answered/i.test(r.msg), r.msg);
mute.close();

console.log(`\n${state.fail ? '✗' : '✓'} publishing a name: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
