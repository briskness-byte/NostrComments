// A relay that will not talk to you until you say who you are (NIP-42).
//
// Nothing handled AUTH or CLOSED at all before this. A relay that turned the subscription away
// answered with a CLOSED nobody read, so the panel showed an empty thread and said nothing —
// indistinguishable from a page where no one has commented. Posting to such a relay was refused
// with "auth-required:", which 22.49 at least reported, but with no way to act on it.
//
// The extension identifies itself only in reply to an actual refusal, never on the challenge
// alone: authenticating because a relay merely offered it would hand your public key to every
// relay you read from, on every page, including the ones where you never post.
//
//   node tests/browser-auth.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-auth.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9525);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8089);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8452);

const { _secp, normalizeUrl, toBech32, sign, verify, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT, requireAuth: true });
const { stored, published, authEvents } = relay;
const RELAY_URL = relay.url;
const site = await startSite({ port: SITE_PORT, heading: 'Auth QA page' });

const PAGE = normalizeUrl(site.url);
const ME = newKey(), MY_PUB = _secp.pubKey(ME);
const AUTHOR = newKey();
const now = Math.floor(Date.now() / 1000);

stored.push(await sign(AUTHOR, {
    kind: 1111, created_at: now - 300, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'BEHIND-AUTH only a client that identifies itself can read this.',
}));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncauth-',
    onClose: () => { site.close(); relay.close(); },
});

console.log(`\nrelay: ${RELAY_URL} (demands NIP-42)\npage:  ${PAGE}\n`);
await goto(site.url);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: RELAY_URL, nsec: toBech32('nsec', ME) }));
await wait(1500);
await goto(site.url);
await wait(6000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(3000);

console.log('\n=== reading from a relay that demands identification ===');
const thread = () => js(`${ROOT} return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')].map(c => c.textContent));`);
ok('the thread behind the wall loads', /BEHIND-AUTH/.test(await thread() || ''), await thread());

console.log('\n=== what was actually sent ===');
ok('exactly one identification was sent', authEvents.length >= 1, authEvents.length);
if (authEvents.length) {
    const ev = authEvents[0];
    const tag = n => (ev.tags || []).find(t => t[0] === n)?.[1];
    ok('it is a kind-22242 event', ev.kind === 22242, ev.kind);
    ok('it answers the relay\'s own challenge', typeof tag('challenge') === 'string' && tag('challenge').length > 0, tag('challenge'));
    ok('it names the relay it is for', (tag('relay') || '').includes('127.0.0.1'), tag('relay'));
    ok('it is signed by the connected identity', ev.pubkey === MY_PUB, ev.pubkey.slice(0, 16));
    ok('and the signature verifies', await verify(ev));
}

console.log('\n=== posting to it ===');
const before = published.filter(e => e.kind === 1111).length;
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'Posted through the wall.';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);
await wait(5000);
const view = JSON.parse(await js(`${ROOT} return JSON.stringify({
    items: [...s.getElementById('list').querySelectorAll('.c')].map(c => c.textContent),
    box: s.getElementById('input').value,
    msg: s.getElementById('msg').textContent });`) || '{}');
ok('the comment is accepted', (view.items || []).some(t => t.includes('Posted through the wall')), view.items);
ok('the box is cleared, so it was not treated as refused', view.box === '', view.box);
ok('the relay holds it', published.filter(e => e.kind === 1111).length > before, { before, after: published.filter(e => e.kind === 1111).length });

console.log(`\n${state.fail === 0 ? '✓' : '✗'} auth: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
