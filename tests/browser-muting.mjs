// Muted and downvoted comments in a real browser, against a relay we control.
//
// Two placeholders, both of which used to lose content. Muting somebody took every reply to their
// comments down with them — a reply is only ever drawn from its parent, so hiding the parent hid
// the lot, including replies by people the reader had not muted. And "tap to show" on a comment
// downvoted past the threshold only dropped the styling: the placeholder sentence stayed where it
// was, so tapping restyled a line of text and revealed nothing at all.
//
// Both are about content that exists and cannot be reached, which is only visible in a rendered
// thread. Nothing is sent to a public relay.
//
//   node tests/browser-muting.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-muting.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { BADGE, extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, matches, ROOT, EXT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9520);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8094);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8446);

const { _secp, normalizeUrl, toBech32, sign, verify, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored, published, conns } = relay;
const RELAY_URL = relay.url;
const site = await startSite({ port: SITE_PORT, heading: 'Muting QA page' });

// --- the page and the events already on the relay --------------------------------------------

const PAGE = normalizeUrl(site.url);
const ME = newKey();
const LOUDMOUTH = newKey(), REPLIER = newKey(), BYSTANDER = newKey();
const now = Math.floor(Date.now() / 1000);

// The comment the reader will mute, with somebody else's reply hanging off it.
const mutedRoot = await sign(LOUDMOUTH, { kind: 1111, created_at: now - 400, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'A comment by the person you are about to mute.' });
const replyByOther = await sign(REPLIER, { kind: 1111, created_at: now - 300, tags: [['I', PAGE], ['K', 'web'], ['e', mutedRoot.id], ['k', '1111']], content: 'A reply by somebody you did not mute.' });
// A second comment by the same person, with nothing under it.
const lonelyRoot = await sign(LOUDMOUTH, { kind: 1111, created_at: now - 250, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'Another one by the muted person, unanswered.' });
const untouched = await sign(BYSTANDER, { kind: 1111, created_at: now - 200, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'An unrelated comment.' });
// A comment tripping a muted word, answered by somebody whose reply contains no such word.
const wordRoot = await sign(BYSTANDER, { kind: 1111, created_at: now - 190, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'This one mentions FLURBLE, a word you muted.' });
const replyToWord = await sign(REPLIER, { kind: 1111, created_at: now - 180, tags: [['I', PAGE], ['K', 'web'], ['e', wordRoot.id], ['k', '1111']], content: 'An answer that mentions no muted word at all.' });
stored.push(mutedRoot, replyByOther, lonelyRoot, untouched, wordRoot, replyToWord);

// A comment downvoted past the threshold, which is max(5, 10% of all votes) — six downvotes and
// nothing else clears it. It is collapsed behind "tap to show".
const buried = await sign(BYSTANDER, { kind: 1111, created_at: now - 150, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'BURIED-TEXT this got downvoted into the ground.' });
stored.push(buried);
for (let i = 0; i < 6; i++) {
    stored.push(await sign(newKey(), { kind: 7, created_at: now - 100 + i, tags: [['e', buried.id], ['p', buried.pubkey], ['r', PAGE]], content: '-' }));
}

const { wd, js, wait, goto, sid, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncmute-',
    onClose: () => { site.close(); relay.close(); },
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
  const items = [...s.getElementById('list').querySelectorAll('.c')];
  return JSON.stringify(items.map(c => ({ text: c.textContent, tomb: c.classList.contains('tomb'), h: c.classList.contains('h') })));`);
let items = JSON.parse(await read() || '[]');
const has = t => items.some(i => i.text.includes(t));

ok('the thread loads', has('A comment by the person you are about to mute'), items.map(i => i.text.slice(0, 40)));

console.log('\n=== a comment downvoted past the threshold ===');
const collapsed = items.find(i => i.h);
ok('it is collapsed behind a placeholder', !!collapsed && /tap to show/i.test(collapsed.text), collapsed);
ok('its text is not on screen while collapsed', !has('BURIED-TEXT'), items.map(i => i.text.slice(0, 40)));
// This is the regression: tapping used to drop the styling and leave the placeholder sentence.
await js(`${ROOT} [...s.getElementById('list').querySelectorAll('.c.h')][0].click(); return 1;`);
await wait(600);
items = JSON.parse(await read() || '[]');
ok('tapping it actually reveals the comment', has('BURIED-TEXT'), items.map(i => i.text.slice(0, 40)));
ok('the placeholder sentence is gone once revealed', !/tap to show/i.test(items.map(i => i.text).join(' ')), items.map(i => i.text.slice(0, 40)));

console.log('\n=== muting somebody who has been replied to ===');
await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('about to mute'));
  [...c.querySelectorAll('button')].find(b => /Mute/i.test(b.textContent)).click(); return 1;`);
await wait(1200);
items = JSON.parse(await read() || '[]');
ok('the muted comment itself is hidden', !has('A comment by the person you are about to mute'), items.map(i => i.text.slice(0, 40)));
// Their reply was written by somebody the reader never muted.
ok('somebody else\'s reply survives the mute', has('A reply by somebody you did not mute'), items.map(i => i.text.slice(0, 40)));
const ph = items.filter(i => i.tomb);
ok('a placeholder stands in for the muted parent', ph.length === 1 && /muted user/i.test(ph[0].text), ph);
ok('it offers a way to look anyway', /tap to show/i.test(ph[0]?.text || ''), ph[0]?.text);
ok('their unanswered comment is gone entirely', !has('Another one by the muted person'), items.map(i => i.text.slice(0, 40)));
ok('an unrelated comment is untouched', has('An unrelated comment'), items.map(i => i.text.slice(0, 40)));

console.log('\n=== the count on the button ===');
// Same rule for someone you muted: a badge that counts them is offering a conversation you have
// already said you do not want.
const badgeText = await js(`${BADGE} return ncText(nc.red);`);
const visible = JSON.parse(await js(`${ROOT}
  return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')].filter(c => !c.classList.contains('tomb')).length);`) || '0');
ok('muted comments are not counted either', Number(badgeText) === visible, { badge: badgeText, visible });

console.log('\n=== opening a muted comment ===');
await js(`${ROOT} s.getElementById('list').querySelector('.c.tomb').click(); return 1;`);
await wait(600);
items = JSON.parse(await read() || '[]');
ok('tapping the placeholder shows the comment', has('A comment by the person you are about to mute'), items.map(i => i.text.slice(0, 40)));
ok('the reply is still below it', has('A reply by somebody you did not mute'), items.map(i => i.text.slice(0, 40)));

console.log('\n=== a muted word on a comment that has been answered ===');
// The third place this bug lived. Muting a word is a standing choice like muting a person, not a
// transient filter like the search box, so the replies under it must not go with it.
await js(`${ROOT}
  s.getElementById('gear-btn').click();
  s.getElementById('muteword-input').value = 'flurble';
  s.getElementById('muteword-add-btn').click();
  s.getElementById('gear-btn').click();
  return 1;`);
await wait(1200);
items = JSON.parse(await read() || '[]');
ok('the comment with the muted word is hidden', !has('mentions FLURBLE'), items.map(i => i.text.slice(0, 40)));
ok('the reply underneath survives', has('An answer that mentions no muted word'), items.map(i => i.text.slice(0, 40)));
const wordPh = items.filter(i => i.tomb && /muted word/i.test(i.text));
ok('a placeholder explains why it is gone', wordPh.length === 1, items.filter(i => i.tomb).map(i => i.text));
ok('and it can be opened', /tap to show/i.test(wordPh[0]?.text || ''), wordPh[0]?.text);
await js(`${ROOT} [...s.getElementById('list').querySelectorAll('.c.tomb')].find(c => /muted word/i.test(c.textContent)).click(); return 1;`);
await wait(600);
items = JSON.parse(await read() || '[]');
ok('opening it shows the comment', has('mentions FLURBLE'), items.map(i => i.text.slice(0, 40)));

console.log(`\n${state.fail === 0 ? '\u2713' : '\u2717'} muting and collapsing: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
