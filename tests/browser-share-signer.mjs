// Share on your own comment, when the identity comes from a NIP-07 signer.
//
// On 14 Oct 2026 a reader signing through a signer extension saw their own comment with Delete but
// without Share — on 23.9.3, whose code adds Share right before Delete, unconditionally, inside the
// same `ev.pubkey === myPub` block. browser-share.mjs only ever ran with a key stored in the
// extension, so this path had never been looked at.
//
// The setup copies the reader's: a key stored here AND a signer in the page, the comment already on
// the relay, and the identity chosen through the onboarding's "Connect your Nostr signer" button.
// Whatever the result, it prints which buttons each card actually has, because "Share is missing"
// has no explanation in the source and the first job is to see it happen.
//
//   node tests/browser-share-signer.mjs
//   NC_BROWSER=firefox node tests/browser-share-signer.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9591);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8151);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8511);

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored } = relay;
const site = await startSite({ port: SITE_PORT, heading: 'Share via signer QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);

const STORED = newKey();                          // the key kept in the extension, not used here
const ME = newKey(), MY_PUB = _secp.pubKey(ME);   // the identity the signer holds
const MINE = 'Written earlier through the signer.';
const mine = await sign(ME, {
    kind: 1111, created_at: now - 300,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web'], ['client', 'NostrComments']],
    content: MINE,
});
stored.push(mine);
stored.push(await sign(newKey(), {
    kind: 1111, created_at: now - 200,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'Somebody else wrote this one.',
}));

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncsharesig-',
    onClose: () => { site.close(); relay.close(); },
});

console.log(`\nrelay: ${relay.url}\npage:  ${PAGE}\nme:    ${MY_PUB.slice(0, 16)}…\n`);
await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', STORED) }));
await wait(1500);
await goto(site.url);
await wait(2000);

// An honest signer for ME. It is only asked for the public key here: nothing is signed, because the
// reader's report was about what the panel shows after connecting, before anything is published.
await js(`window.nostr = {
    getPublicKey: async () => ${JSON.stringify(MY_PUB)},
    signEvent: async () => { throw new Error('not used in this suite'); },
  };
  return 1;`);
await wait(3000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(2500);

const status = () => js(`${ROOT} return s.getElementById('status').textContent;`);
let st = await status();
console.log('status before connecting:', JSON.stringify(st));

// The reader's route: the onboarding's own button. Fall back to the header's signer choice if the
// onboarding is not showing, and say which one was used.
const used = await js(`${ROOT}
  const ob = [...s.querySelectorAll('button')].find(b => /Connect your Nostr signer/.test(b.textContent) && b.offsetParent);
  if (ob) { ob.setAttribute('data-qa', 'connect'); return 'onboarding'; }
  const hdr = s.getElementById('signer-nip07');
  if (hdr) { hdr.setAttribute('data-qa', 'connect'); return 'settings'; }
  return '';`);
console.log('connecting through:', used || '(no button found)');
if (used) await nclick(`s.querySelector('[data-qa="connect"]')`);
await wait(4000);
st = await status();
ok('the panel is connected as the signer\'s identity', /Connected as/.test(st || ''), st);

console.log('\n=== which buttons each card has ===');
let cards = [];
for (let i = 0; i < 20; i++) {
    cards = JSON.parse(await js(`${ROOT}
      return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')].map(c => ({
        own: c.classList.contains('own'),
        text: (c.querySelector('.ct, .content, p')?.textContent || c.textContent).slice(0, 40),
        buttons: [...c.querySelectorAll('button')].map(b => b.className + ':' + b.textContent.trim().slice(0, 12)),
      })));`) || '[]');
    if (cards.some(c => c.own)) break;
    await wait(500);
}
for (const c of cards) console.log(`  ${c.own ? 'OWN  ' : 'other'} ${JSON.stringify(c.text)}\n        ${c.buttons.join(' | ')}`);

const own = cards.find(c => c.own);
ok('your comment is recognised as yours', !!own, cards.map(c => c.own));
ok('it has Delete', !!own && own.buttons.some(b => b.startsWith('del-btn')), own && own.buttons);
ok('and it has Share', !!own && own.buttons.some(b => b.startsWith('share-btn')), own && own.buttons);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} share via signer: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
