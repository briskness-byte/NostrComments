// What the page can read out of the panel.
//
// The panel hangs in an OPEN shadow root, which means `host.shadowRoot` is reachable from any
// script on the page — an ad, an analytics tag, anything the site includes. That is by design and
// hard to avoid: closing the root would only raise the bar, since a script running before the
// content script can hook `attachShadow` and capture the root anyway. So the root is not a boundary
// and must not be treated as one. What matters is that no secret ever sits inside it.
//
// It used to. A security review in August 2026 found the private key parked in #privkey-display
// from the moment Settings was opened — not only while it was being shown — and left there for the
// rest of the page's life. The typed password was blanked when its overlay opened rather than when
// it closed, so it too outlived its use.
//
// This suite is written from the attacker's seat on purpose: WebDriver's execute runs in page
// context, exactly where a hostile script sits. Every check below is a thing a page can try.
//
//   node tests/browser-keyexposure.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-keyexposure.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9536);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8095);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8463);

const { _secp, toBech32, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Key exposure QA page' });

const ME = newKey();
const MY_NSEC = toBech32('nsec', ME);
const PASSWORD = 'correct-horse-battery-staple-9137';

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncleak-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

// The sweep a hostile script would actually run: every input value and every scrap of text inside
// the shadow root, plus the attributes, flattened into one haystack. Deliberately broader than
// "read #privkey-display" so that moving the secret to another field does not make this pass.
const sweep = () => js(`${ROOT}
  const parts = [];
  const walk = root => {
    for (const el of root.querySelectorAll('*')) {
      if ('value' in el && typeof el.value === 'string') parts.push(el.value);
      for (const a of el.attributes) parts.push(a.value);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
    parts.push(root.textContent || '');
  };
  walk(s);
  return parts.join('\\u0000');`);

const leaks = async what => {
    const hay = await sweep();
    if (typeof hay !== 'string') return 'sweep failed: ' + JSON.stringify(hay);
    return hay.includes(what);
};

// Import a key the way a user would, then decline the encryption offer so the panel is left in the
// ordinary "unencrypted key stored here" state most users are in.
await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}`, nsec: MY_NSEC }));
await wait(1500);
await js(`${ROOT}
  const o = [...s.getElementById('p').children].find(c => c.style.zIndex === '28' && getComputedStyle(c).display !== 'none');
  if (o) [...o.querySelectorAll('button')].find(b => /not now/i.test(b.textContent))?.click();
  return 1;`);
await wait(600);

const stored = await js(`${ROOT} return s.getElementById('keypair-section').style.display;`);
ok('the imported key is in use', stored === 'block', stored);

console.log('\n=== the key is not left lying in the DOM ===');

// Settings is open at this point — configureScript clicks the gear and never closes it. This is
// the exact state the review found the key in.
const openNow = await js(`${ROOT} return s.getElementById('settings-panel') ? getComputedStyle(s.getElementById('settings-panel')).display : 'no-panel';`);
ok('settings is open for the checks below', openNow !== 'none', openNow);

ok('the private key is not readable from the page with settings open', await leaks(ME) === false);
ok('the nsec form is not readable either', await leaks(MY_NSEC) === false);

// Named explicitly as well as by sweep, so a failure says which field gave it away.
const inField = await js(`${ROOT} const i = s.getElementById('privkey-display'); return i ? i.value : '(missing)';`);
ok('#privkey-display is empty until asked', inField === '', JSON.stringify(inField));

console.log('\n=== revealing it shows it, hiding it takes it back ===');

await js(`${ROOT} s.getElementById('privkey-reveal').click(); return 1;`);
await wait(300);
const revealed = await js(`${ROOT} return s.getElementById('privkey-display').value;`);
// The field shows the nsec form — what every other Nostr app asks for — so that is what the sweep
// below has to look for. Checking for the hex here would pass whatever the field contained, which
// would quietly turn this suite into no test at all.
ok('“Show private key” actually shows the key', revealed === MY_NSEC, revealed === '' ? '(empty)' : 'a different value');
ok('and it is readable from the page while shown — this is the user asking for it', await leaks(MY_NSEC) === true);
ok('the hex form is not in the DOM alongside it', await leaks(ME) === false);

await js(`${ROOT} s.getElementById('privkey-reveal').click(); return 1;`);
await wait(300);
ok('hiding it removes it from the DOM again', await leaks(MY_NSEC) === false);
ok('in neither form', await leaks(ME) === false);
const boxAfterHide = await js(`${ROOT} return s.getElementById('privkey-box').style.display;`);
ok('and the box is closed', boxAfterHide === 'none', boxAfterHide);

console.log('\n=== it does not come back on its own ===');

// Reveal, then close Settings while it is still showing: the close path has to put it away rather
// than leaving a revealed key behind for whoever opens the panel next.
await js(`${ROOT} s.getElementById('privkey-reveal').click(); return 1;`);
await wait(300);
await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
await wait(500);
ok('closing settings while the key is shown clears it', await leaks(ME) === false);

await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
await wait(700);
ok('reopening settings does not put it back', await leaks(ME) === false);
const boxOnReopen = await js(`${ROOT} return s.getElementById('privkey-box').style.display;`);
ok('and reopening does not leave it revealed', boxOnReopen === 'none', boxOnReopen);

// The public half is not secret, but it is an identifier, and it was in the page's reach on every
// site whether or not the panel had ever been opened. A site reading npub1… learns which pseudonym
// is browsing it without the reader posting anything — and unlike the relays, it was never chosen
// or disclosed. The audit's own rule, "nothing sensitive goes in the DOM", was written about the
// private key; this is the public one held to the same standard.
console.log('\n=== the public key is not on offer while the panel is shut ===');

const MY_HEX = _secp.pubKey(ME);
const MY_NPUB = toBech32('npub', MY_HEX);

await goto(site.url);
await wait(3000);
ok('the npub is not in the DOM before the panel is opened', await leaks(MY_NPUB) === false);
ok('nor is the hex public key', await leaks(MY_HEX) === false);

await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(900);
ok('opening the panel shows it, so the reader can still see who they are',
   await leaks(MY_NPUB) === true);

await js(`${ROOT} s.getElementById('c').click(); return 1;`);
await wait(900);
ok('and closing it takes the npub back out of the DOM', await leaks(MY_NPUB) === false);
ok('the hex goes with it', await leaks(MY_HEX) === false);

// The four lists in Settings are built when it opens and were never taken down again, so opening
// Settings once left them readable for the rest of the page. The disabled-site list is the sharp
// one: it names *other* sites the reader visits.
console.log('\n=== Settings does not leave its lists lying about ===');

const MUTED_WORD = 'zzqq-private-word';
const ODD_RELAY = 'wss://relay.example-of-mine.invalid';
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn').click(); return 1;`);
await wait(700);
await js(`${ROOT}
  const w = s.getElementById('muteword-input');
  w.value = ${JSON.stringify(MUTED_WORD)};
  s.getElementById('muteword-add-btn').click();
  const r = s.getElementById('relay-input');
  r.value = ${JSON.stringify(ODD_RELAY)};
  s.getElementById('relay-add-btn').click();
  return 1;`);
await wait(700);
ok('what is in Settings is readable while Settings is open', await leaks(MUTED_WORD) === true);

await js(`${ROOT} s.getElementById('settings-close').click(); return 1;`);
await wait(700);
ok('closing Settings takes the muted word back out of the DOM', await leaks(MUTED_WORD) === false);
ok('and the relay the reader added with it', await leaks(ODD_RELAY) === false);

await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
await wait(700);
ok('reopening Settings builds them again', await leaks(MUTED_WORD) === true);
await js(`${ROOT} s.getElementById('c').click(); return 1;`);
await wait(700);
ok('closing the whole panel clears them too', await leaks(MUTED_WORD) === false);

// Put the panel back the way this section found it: the checks below carry on from an open panel
// with Settings showing, and this block reloaded the page to prove the npub is absent from a fresh
// one.
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn').click(); return 1;`);
await wait(900);

console.log('\n=== the typed password does not outlive its overlay ===');

// Set a password through Settings. The overlay's fields held it from submit until the next time
// the overlay happened to be opened, which on most pages is never.
await js(`${ROOT}
  const b = [...s.querySelectorAll('button')].find(x => /set a password/i.test(x.textContent));
  if (b) b.click();
  return 1;`);
await wait(600);
const pwShown = await js(`${ROOT}
  const o = [...s.getElementById('p').children].find(c => c.style.zIndex === '28' && getComputedStyle(c).display !== 'none');
  return !!o;`);
ok('the password overlay opens', pwShown === true, pwShown);

if (pwShown) {
    await js(`${ROOT}
      const o = [...s.getElementById('p').children].find(c => c.style.zIndex === '28' && getComputedStyle(c).display !== 'none');
      const ins = [...o.querySelectorAll('input')];
      ins[0].value = ${JSON.stringify(PASSWORD)}; ins[1].value = ${JSON.stringify(PASSWORD)};
      [...o.querySelectorAll('button')].find(b => /set a password/i.test(b.textContent)).click();
      return 1;`);
    await wait(2500);

    const encrypted = await js(`${ROOT}
      const b = [...s.querySelectorAll('button')].find(x => /remove password/i.test(x.textContent));
      return !!b;`);
    ok('the key is now encrypted at rest', encrypted === true, encrypted);
    ok('the password is not readable from the page afterwards', await leaks(PASSWORD) === false);
    ok('and the key it protects is not either', await leaks(ME) === false);
}

console.log('\n=== a locked key stays locked ===');

// Reload with the key encrypted: nothing should be recoverable from the DOM before unlocking, and
// pressing Show must not quietly hand over anything.
await goto(site.url);
await wait(3000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; s.getElementById('gear-btn').click(); return 1;`);
await wait(800);
ok('after a reload the encrypted key is not in the DOM', await leaks(ME) === false);
await js(`${ROOT} const b = s.getElementById('privkey-reveal'); if (b) b.click(); return 1;`);
await wait(400);
ok('“Show private key” cannot reveal a locked key', await leaks(ME) === false);

console.log(`\n${state.fail ? '✗' : '✓'} ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
