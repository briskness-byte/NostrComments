// What happens when the relays refuse, in a real browser.
//
// Publishing was fire-and-forget: the event went out, the comment went straight into the list and
// the box was cleared, without anybody checking that a relay had taken it. Worse, the two most
// common refusals — "restricted" (paid or members-only) and "pow" (proof-of-work required) — were
// deliberately swallowed so they would not nag. So a comment that no relay accepted looked posted,
// and the only copy of the text had just been wiped from the box. A reload was how you found out.
//
// This points the extension at a relay that refuses everything and checks that nothing pretends to
// have worked: not a comment, not a vote, not a deletion request. Then it lets the relay accept
// and checks the ordinary path still behaves.
//
//   node tests/browser-publish.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-publish.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, matches, ROOT, EXT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9521);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8093);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8447);
const REFUSER_PORT = Number(process.env.QA_RELAY2_PORT || 8448);

const { _secp, normalizeUrl, toBech32, sign, verify, newKey } = extensionCode();
const { ok, state } = reporter();

let REFUSE = '';        // when set, the relay refuses every event with this reason
let REFUSE_DELAY = 0;   // how long it sits on the refusal, so optimistic UI can be observed
const relay = await startRelay({
    port: RELAY_PORT,
    onEvent: (ev, api) => REFUSE ? api.refuse(REFUSE, REFUSE_DELAY) : api.accept(),
});
// A second relay that refuses everything, for the mixed case: one says no while another says yes.
// The reason is deliberately not restricted:/pow:, the two the old code filtered out — relays
// refuse with rate-limited:, blocked: and invalid: too, and those all surfaced.
const refuser = await startRelay({
    port: REFUSER_PORT,
    onEvent: (ev, api) => api.refuse('rate-limited: slow down'),
});
const { stored, published, conns } = relay;
const RELAY_URL = relay.url, REFUSER_URL = refuser.url;
const site = await startSite({ port: SITE_PORT, heading: 'Publish QA page' });

// --- the page and the events already on the relay --------------------------------------------

const PAGE = normalizeUrl(site.url);
const ME = newKey();
const AUTHOR = newKey();
const now = Math.floor(Date.now() / 1000);

// Somebody else's comment, so there is something to vote on.
const theirs = await sign(AUTHOR, { kind: 1111, created_at: now - 300, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'A comment to vote on.' });
// And one of ours, so there is something to try to delete.
const mine = await sign(ME, { kind: 1111, created_at: now - 200, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'My own comment, for the delete attempt.' });
stored.push(theirs, mine);

const { wd, js, wait, goto, sid, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncpub-',
    onClose: () => { site.close(); relay.close(); refuser.close(); },
});

console.log(`\nrelay: ${RELAY_URL}\npage:  ${PAGE}\n`);
await goto(site.url);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: RELAY_URL, nsec: toBech32('nsec', ME) }));
await wait(1500);
await goto(site.url);
await wait(4500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(2500);

const read = () => js(`${ROOT}
  return JSON.stringify({
    items: [...s.getElementById('list').querySelectorAll('.c')].map(c => c.textContent),
    box: s.getElementById('input').value,
    msg: s.getElementById('msg').textContent });`);
let view = JSON.parse(await read() || '{}');
ok('the thread loads', (view.items || []).some(t => t.includes('A comment to vote on')), view.items);

// Every relay now refuses, the way a paid relay or one demanding proof-of-work would.
REFUSE = 'pow: difficulty 28 required';

console.log('\n=== a comment no relay accepts ===');
const TEXT = 'This comment will be refused by every relay.';
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = ${JSON.stringify(TEXT)};
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);
await wait(4000);
view = JSON.parse(await read() || '{}');
ok('it is not shown as if it posted', !(view.items || []).some(t => t.includes('refused by every relay')), view.items);
ok('the text is still in the box', view.box === TEXT, view.box);
// The raw string is "pow: difficulty 28 required". What reaches the reader has to be something
// they can act on, because the one thing they cannot do is satisfy it.
ok('the reason is passed on rather than swallowed', /no relay accepted/i.test(view.msg), view.msg);
ok('proof-of-work is explained rather than quoted', /difficulty 28/.test(view.msg) && /another relay|Settings/i.test(view.msg), view.msg);
ok('and it does not just echo the relay\'s wire format', !/pow:/i.test(view.msg), view.msg);
ok('the Post button works again', await js(`${ROOT} return !s.getElementById('send').disabled;`));

console.log('\n=== the shape of what gets published (NIP-22) ===');
// Read from nostr-protocol/nips on 8 Aug 2026: kind 1111, root scope in uppercase, parent in
// lowercase, K and k mandatory, and NIP-73 says a web page is the normalised URL with k = "web".
// Pinning the wire format matters more than usual here — nothing in the panel would look wrong if
// a tag were dropped, and other clients are the only ones who would notice.
{
    const c = published.find(e => e.kind === 1111);
    ok('a comment is a kind-1111 event', !!c, published.map(e => e.kind));
    if (c) {
        const tag = n => (c.tags || []).filter(t => t[0] === n).map(t => t[1]);
        ok('its root scope is the page, in uppercase I', tag('I')[0] === PAGE, tag('I'));
        ok('the root kind says it is a web page', tag('K')[0] === 'web', tag('K'));
        ok('a top-level comment repeats the page as its parent', tag('i')[0] === PAGE, tag('i'));
        ok('with the matching lowercase k', tag('k')[0] === 'web', tag('k'));
        ok('and no r tag, which is not part of NIP-22', tag('r').length === 0, tag('r'));
    }
}

console.log('\n=== a vote no relay accepts ===');
// A vote is shown before it is confirmed — waiting on a relay would leave the arrow dead for as
// long as the slowest one takes. What matters is that it goes back when nobody takes it.
REFUSE_DELAY = 1500;
const before = JSON.parse(await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('A comment to vote on'));
  return JSON.stringify([...c.querySelectorAll('button.v')].map(b => b.textContent.trim()));`) || '[]');
await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('A comment to vote on'));
  c.querySelector('button.v').click(); return 1;`);
await wait(250);
const optimistic = JSON.parse(await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('A comment to vote on'));
  return JSON.stringify({ arrows: [...c.querySelectorAll('button.v')].map(b => b.textContent.trim()),
                          mine: [...c.querySelectorAll('button.v')].some(b => b.classList.contains('mine')) });`) || '{}');
ok('the arrow responds at once rather than waiting on a relay', optimistic.arrows[0] !== before[0] && optimistic.mine === true, { before, optimistic });
await wait(4000);
REFUSE_DELAY = 0;
const after = JSON.parse(await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('A comment to vote on'));
  return JSON.stringify({ arrows: [...c.querySelectorAll('button.v')].map(b => b.textContent.trim()),
                          mine: [...c.querySelectorAll('button.v')].some(b => b.classList.contains('mine')),
                          msg: s.getElementById('msg').textContent });`) || '{}');
ok('and is put back when no relay takes it', JSON.stringify(after.arrows) === JSON.stringify(before), { before, after: after.arrows });
ok('the vote is not left marked as yours', after.mine === false, after);
ok('and it says so', /no relay accepted/i.test(after.msg), after.msg);

console.log('\n=== a deletion no relay accepts ===');
await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('My own comment'));
  [...c.querySelectorAll('button')].find(b => /Delete/i.test(b.textContent)).click(); return 1;`);
await wait(500);
await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('My own comment'));
  [...c.querySelectorAll('button')].find(b => /Confirm/i.test(b.textContent)).click(); return 1;`);
await wait(4000);
view = JSON.parse(await read() || '{}');
// Hiding it locally would be the worst outcome: gone for you, untouched for everyone else.
ok('the comment is still there', (view.items || []).some(t => t.includes('My own comment')), view.items);
ok('and it says so', /no relay accepted/i.test(view.msg), view.msg);
const delBtn = await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('My own comment'));
  const b = [...c.querySelectorAll('button')].find(b => /Delete|Confirm/i.test(b.textContent));
  return JSON.stringify({ label: b.textContent, disabled: b.disabled });`);
ok('the delete button is usable again, not stranded', JSON.parse(delBtn).disabled === false, delBtn);

console.log('\n=== and when a relay does accept ===');
REFUSE = '';
await js(`${ROOT} s.getElementById('send').click(); return 1;`);
await wait(3500);
view = JSON.parse(await read() || '{}');
ok('the comment appears', (view.items || []).some(t => t.includes('refused by every relay')), view.items);
ok('the box is cleared', view.box === '', view.box);

console.log('\n=== replying to a comment ===');
// No suite posted a reply through the UI before this, so the reply tagging had never actually been
// exercised — the branch that builds it was only ever read.
await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('A comment to vote on'));
  [...c.querySelectorAll('button')].find(b => /Reply/i.test(b.textContent)).click();
  const i = s.getElementById('input');
  i.value = 'An answer to it.';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);
await wait(3500);
const reply = published.find(e => e.kind === 1111 && (e.tags || []).some(t => t[0] === 'e'));
ok('the reply is published', !!reply, published.map(e => e.kind));
if (reply) {
    const rt = n => (reply.tags || []).filter(t => t[0] === n).map(t => t[1]);
    ok('it keeps the page as its root scope', rt('I')[0] === PAGE, rt('I'));
    ok('the root kind is still the page', rt('K')[0] === 'web', rt('K'));
    ok('its parent is the comment it answers', rt('e')[0] === theirs.id, rt('e'));
    ok('the parent kind is 1111, not web', rt('k')[0] === '1111', rt('k'));
    ok('and it tags the parent author', rt('p')[0] === theirs.pubkey, rt('p'));
}
const threaded = await js(`${ROOT} return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')].map(c => ({ t: c.textContent.slice(0, 30), reply: c.classList.contains('reply') })));`);
ok('it is drawn as a reply, indented under its parent', /"reply":true/.test(threaded || ''), threaded);

console.log('\n=== one relay refuses, another accepts ===');
// The everyday case with more than one relay configured. A refusal that somebody else made good
// is not news, and reporting it turns a vote that worked into what looks like a failure.
await js(`${ROOT}
  s.getElementById('gear-btn').click();
  s.getElementById('relay-input').value=${JSON.stringify(REFUSER_URL)};
  s.getElementById('relay-add-btn').click();
  s.getElementById('gear-btn').click();
  return 1;`);
await wait(800);
await goto(site.url);
await wait(5000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(2500);
await js(`${ROOT} s.getElementById('msg').textContent = ''; return 1;`);

const arrowsBefore = JSON.parse(await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('A comment to vote on'));
  return JSON.stringify([...c.querySelectorAll('button.v')].map(b => b.textContent.trim()));`) || '[]');
await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('A comment to vote on'));
  c.querySelector('button.v').click(); return 1;`);
await wait(4000);
const mixed = JSON.parse(await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('A comment to vote on'));
  return JSON.stringify({ arrows: [...c.querySelectorAll('button.v')].map(b => b.textContent.trim()),
                          mine: [...c.querySelectorAll('button.v')].some(b => b.classList.contains('mine')),
                          msg: s.getElementById('msg').textContent });`) || '{}');
ok('the vote counts', mixed.arrows[0] !== arrowsBefore[0] && mixed.mine === true, { before: arrowsBefore, after: mixed });
ok('and no error is shown for the relay that refused', mixed.msg.trim() === '', mixed.msg);

console.log(`\n${state.fail === 0 ? '\u2713' : '\u2717'} publishing: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
