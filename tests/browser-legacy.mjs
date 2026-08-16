// Kind 1 notes that carry an r tag for this page: read, never written.
//
// v22.51 moved comments to NIP-22 kind 1111 and stopped asking for kind 1 at all. The migration
// note justified that by saying there was no corpus worth protecting, which was true of this
// extension's own history and wrong about everything else — an r-tagged note is how any Nostr
// client links a note to a URL, so the whole of that conversation went invisible at once.
//
// It also left the panel making a promise it could not keep. Notifications listen on kind 1 as well
// as 1111, because somebody can mention you in an ordinary note; the badge lit up and the thread
// had nowhere to show what it was pointing at.
//
// Reading them back is not a return to kind 1. NIP-22 is explicit — "Comments MUST NOT be used to
// reply to kind 1 notes" — and answering in kind would put the reply in everybody's feed, which is
// the thing 1111 exists to prevent. So these are readable and votable, and replies are refused with
// a reason. This suite pins that shape from both ends: that the old notes come back, and that
// nothing starts writing them again.
//
//   node tests/browser-legacy.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-legacy.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { BADGE, extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9538);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8097);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8465);

const { _secp, normalizeUrl, toBech32, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const published = [];
const relay = await startRelay({ port: RELAY_PORT, onEvent: (ev, api) => { published.push(ev); api.accept(); } });
const site = await startSite({ port: SITE_PORT, heading: 'Legacy notes QA page' });
const pageUrl = normalizeUrl(site.url);

const ME = newKey(), MY_PUB = _secp.pubKey(ME);
const OTHER = newKey();
const now = Math.floor(Date.now() / 1000);

// An ordinary note linking to this page — what every earlier version wrote, and what other clients
// still write when somebody shares a URL with a remark.
const legacyTop = await sign(OTHER, { kind: 1, created_at: now - 300, content: 'legacy top level', tags: [['r', pageUrl]] });
// A reply to it, also kind 1, threaded the NIP-10 way.
const legacyReply = await sign(OTHER, { kind: 1, created_at: now - 200, content: 'legacy reply', tags: [['r', pageUrl], ['e', legacyTop.id, '', 'reply']] });
// A note that mentions the reader: the case the notification badge could point at but never show.
const legacyMention = await sign(OTHER, { kind: 1, created_at: now - 100, content: 'legacy note naming you', tags: [['r', pageUrl], ['p', MY_PUB]] });
// And a modern comment, so an empty thread is distinguishable from a filtered one.
const modern = await sign(OTHER, { kind: 1111, created_at: now - 50, content: 'modern comment', tags: [['I', pageUrl], ['K', 'web'], ['i', pageUrl], ['k', 'web']] });
relay.stored.push(legacyTop, legacyReply, legacyMention, modern);

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'nclegacy-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}`, nsec: toBech32('nsec', ME) }));
await wait(1500);
await js(`${ROOT}
  const o = [...s.getElementById('p').children].find(c => c.style.zIndex === '28' && getComputedStyle(c).display !== 'none');
  if (o) [...o.querySelectorAll('button')].find(b => /not now/i.test(b.textContent))?.click();
  return 1;`);
await goto(site.url);
await wait(5000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(800);

const rows = () => js(`${ROOT}
  return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')].map(c => ({
    text: (c.querySelector('.nc-body') || {}).textContent || '',
    note: !!c.querySelector('.nc-notetag'),
    nested: c.classList.contains('reply'),
    up: (c.querySelector('button.v') || {}).textContent || '',
    isNote: c.classList.contains('nc-note'),
    border: getComputedStyle(c).borderLeftColor,
    bg: getComputedStyle(c).backgroundColor,
    replyText: (c.querySelector('.reply-btn') || {}).textContent || '' })));`);

console.log('\n=== the old notes are back ===');
let drawn = JSON.parse(await rows());
const find = t => drawn.find(r => r.text.includes(t));
ok('a kind 1 note tagged with this page is shown', !!find('legacy top level'), drawn.map(d => d.text));
ok('so is one that mentions the reader', !!find('legacy note naming you'), drawn.map(d => d.text));
ok('the modern comment is still shown', !!find('modern comment'), drawn.map(d => d.text));
ok('a legacy reply threads under its legacy parent', find('legacy reply')?.nested === true, find('legacy reply'));

console.log('\n=== and they are marked as what they are ===');
ok('a legacy note carries the note marker', find('legacy top level')?.note === true, find('legacy top level'));
ok('a modern comment does not', find('modern comment')?.note === false, find('modern comment'));

// The badge promising a discussion the thread cannot show is the bug that started this.
const badge = JSON.parse(await js(`${BADGE}
  return JSON.stringify({ text: ncText(nc.red), shown: ncShown(nc.red) });`));
ok('the badge counts what is actually drawn', badge.text === String(drawn.length), { badge, drawn: drawn.length });

console.log('\n=== a note reads as a note, not as a comment ===');
const legacyIdx = drawn.findIndex(r => r.text.includes('legacy top level'));
const modernRow = find('modern comment');
ok('a note card is marked as one', drawn[legacyIdx].isNote === true, drawn[legacyIdx]);
ok('a comment card is not', modernRow.isNote === false, modernRow);
// The chip alone was too easy to miss when scrolling; the border colour carries meaning in this
// UI already (comment / reply / yours), and a note was borrowing the comment's.
ok('a note has its own border colour', drawn[legacyIdx].border !== modernRow.border,
    { note: drawn[legacyIdx].border, comment: modernRow.border });
ok('and its own background', drawn[legacyIdx].bg !== modernRow.bg,
    { note: drawn[legacyIdx].bg, comment: modernRow.bg });

// A title attribute cannot be reached on a phone, so the chip has to answer a tap.
await js(`${ROOT} s.getElementById('list').querySelectorAll('.c')[${legacyIdx}].querySelector('.nc-notetag').click(); return 1;`);
await wait(400);
const chipMsg = await js(`${ROOT} return s.getElementById('msg').textContent;`);
ok('tapping the note chip explains what it is', /ordinary Nostr note/i.test(chipMsg), chipMsg);

console.log('\n=== replying to a note publishes a NIP-10 note ===');
// The dangerous half of this feature: the shape of an event signed with the user's key is decided
// by which kind the parent was. Pinned exactly, both branches, because a mistake here is not a
// visible bug — it is a malformed event published under someone's identity.
const replyToNote = async (idx, text) => {
    published.length = 0;
    await js(`${ROOT} s.getElementById('list').querySelectorAll('.c')[${idx}].querySelector('.reply-btn').click(); return 1;`);
    await wait(400);
    const strip = JSON.parse(await js(`${ROOT} return JSON.stringify({
      shown: getComputedStyle(s.getElementById('reply-indicator')).display !== 'none',
      label: s.getElementById('reply-to-label').textContent,
      hint: s.getElementById('reply-hint').textContent,
      hintShown: getComputedStyle(s.getElementById('reply-hint')).display !== 'none' });`));
    await js(`${ROOT} s.getElementById('input').value = ${JSON.stringify(text)}; s.getElementById('send').click(); return 1;`);
    await wait(2500);
    return { strip, ev: published.find(e => e.kind === 1 || e.kind === 1111) };
};

let r = await replyToNote(legacyIdx, 'answering the note');
ok('the reply box says a note is being answered', r.strip.shown === true, r.strip);
ok('and warns it goes out as an ordinary note', /ordinary Nostr note/i.test(r.strip.hint) && r.strip.hintShown, r.strip);
// A note with no p tags of its own reaches exactly one person, and saying "1 people" would be the
// kind of small wrongness that makes the rest of a warning easy to disbelieve.
ok('and says only the author is notified', /its author will be notified/i.test(r.strip.hint), r.strip.hint);
ok('the reply is published as kind 1', r.ev?.kind === 1, r.ev?.kind);

// "A direct reply to the root of a thread should have a single marked 'e' tag of type 'root'."
let es = (r.ev?.tags || []).filter(t => t[0] === 'e');
ok('a direct reply to a root carries exactly one e tag', es.length === 1, es);
ok('marked as the root, naming the note', es[0]?.[1] === legacyTop.id && es[0]?.[3] === 'root', es[0]);
ok('with the author as the fifth field', es[0]?.[4] === _secp.pubKey(OTHER), es[0]);
ok('it p-tags the author being answered', (r.ev?.tags || []).some(t => t[0] === 'p' && t[1] === _secp.pubKey(OTHER)), r.ev?.tags);
ok('it stays attached to this page', (r.ev?.tags || []).some(t => t[0] === 'r' && t[1] === pageUrl), r.ev?.tags);
ok('and carries no NIP-22 scope tags', !(r.ev?.tags || []).some(t => t[0] === 'I' || t[0] === 'K'), r.ev?.tags);

// Replying to something that is itself a reply needs both markers, and the root is taken from the
// parent's own tags rather than guessed.
let rows2 = JSON.parse(await rows());
const nestedIdx = rows2.findIndex(x => x.text.includes('legacy reply'));
r = await replyToNote(nestedIdx, 'answering the reply');
es = (r.ev?.tags || []).filter(t => t[0] === 'e');
ok('replying to a reply carries two e tags', es.length === 2, es);
ok('the first is the thread root', es[0]?.[1] === legacyTop.id && es[0]?.[3] === 'root', es[0]);
ok('the second is what is being answered', es[1]?.[1] === legacyReply.id && es[1]?.[3] === 'reply', es[1]);

// A note that mentions somebody: NIP-10 says the reply carries the parent's p tags as well.
rows2 = JSON.parse(await rows());
const mentionIdx = rows2.findIndex(x => x.text.includes('legacy note naming you'));
r = await replyToNote(mentionIdx, 'answering the mention');
const ps = (r.ev?.tags || []).filter(t => t[0] === 'p').map(t => t[1]);
ok("it carries the parent's p tags too", ps.includes(MY_PUB) && ps.includes(_secp.pubKey(OTHER)), ps);
ok('with no duplicates', ps.length === new Set(ps).size, ps);
// The number in the strip has to be the number that goes out. A count worked out separately is a
// count that can drift, and then the panel is stating something that is not so.
ok('the warning counted exactly who was notified',
    new RegExp(`\\b${ps.length} people will be notified`).test(r.strip.hint), { hint: r.strip.hint, sent: ps.length });

// A note tagging more people than the cap allows: the strip has to admit the cap rather than
// quietly report the smaller number as if it were the whole story.
console.log('\n=== a note that tags more people than the cap allows ===');
const crowd = await sign(OTHER, {
    kind: 1, created_at: now - 20, content: 'a note tagging a crowd',
    tags: [['r', pageUrl], ...Array.from({ length: 40 }, () => ['p', _secp.pubKey(newKey())])],
});
relay.stored.push(crowd);
relay.fanOut(crowd);
await wait(2500);
const crowdIdx = JSON.parse(await rows()).findIndex(x => x.text.includes('a note tagging a crowd'));
ok('the crowded note reaches the thread', crowdIdx >= 0, crowdIdx);
if (crowdIdx >= 0) {
    r = await replyToNote(crowdIdx, 'answering the crowd');
    const sent = (r.ev?.tags || []).filter(t => t[0] === 'p').length;
    ok('the reply stops at the cap', sent === 20, sent);
    ok('and the strip says so rather than reporting 20 as the whole story',
        /the note tags 41, and this stops at 20/.test(r.strip.hint), r.strip.hint);
}

console.log('\n=== and a comment is still a comment ===');
rows2 = JSON.parse(await rows());
const modIdx = rows2.findIndex(x => x.text.includes('modern comment'));
r = await replyToNote(modIdx, 'answering the comment');
ok('replying to a comment shows no note warning', !r.strip.hintShown, r.strip);
ok('and publishes a 1111, not a kind 1', r.ev?.kind === 1111, r.ev?.kind);
ok('scoped to the page the NIP-22 way', (r.ev?.tags || []).some(t => t[0] === 'I' && t[1] === pageUrl), r.ev?.tags);
ok('naming the comment it answers', (r.ev?.tags || []).some(t => t[0] === 'e' && t[1] === modern.id), r.ev?.tags);
ok('and no r tag of the old shape', !(r.ev?.tags || []).some(t => t[0] === 'r'), r.ev?.tags);

// Voting is a kind 7 pointing at an event id; nothing about it cares what kind the target was.
// Recomputed: the replies posted above changed the row order, and an index captured before them
// pointed at a different comment — which is how this read as a broken vote rather than a stale test.
const voteIdx = JSON.parse(await rows()).findIndex(x => x.text.includes('legacy top level'));
published.length = 0;
await js(`${ROOT} s.getElementById('list').querySelectorAll('.c')[${voteIdx}].querySelector('button.v').click(); return 1;`);
await wait(2000);
const vote = published.find(e => e.kind === 7);
ok('a legacy note can be upvoted', !!vote, published.map(e => e.kind));
ok('the vote points at the legacy note', vote?.tags.some(t => t[0] === 'e' && t[1] === legacyTop.id), vote?.tags);
const voted = JSON.parse(await rows())[voteIdx];
ok('and the thread shows the vote on it', voted.up.trim() === '↑ 1', voted.up);
ok('and the button is marked as mine', await js(`${ROOT}
  return s.getElementById('list').querySelectorAll('.c')[${voteIdx}].querySelector('button.v').classList.contains('mine');`) === true);

console.log('\n=== nothing writes kind 1 again ===');
published.length = 0;
await js(`${ROOT}
  s.getElementById('input').value = 'a brand new comment';
  s.getElementById('send').click(); return 1;`);
await wait(2500);
const posted = published.filter(e => e.kind === 1 || e.kind === 1111);
ok('a new comment is published', posted.length === 1, published.map(e => e.kind));
ok('and it is a 1111, not a kind 1', posted[0]?.kind === 1111, posted[0]?.kind);
ok('scoped to this page the NIP-22 way', posted[0]?.tags.some(t => t[0] === 'I' && t[1] === pageUrl), posted[0]?.tags);
ok('and carries no r tag of the old shape', !posted[0]?.tags.some(t => t[0] === 'r'), posted[0]?.tags);

console.log(`\n${state.fail ? '✗' : '✓'} legacy kind 1 notes: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
