// Voting in a real browser, against a relay we control.
//
// Reactions are kind-7 events, and reading them back is the part that silently broke: the live
// subscription filters on the page URL, but a reaction carries no r tag unless the client adds
// one, and the refetch that walks the comment ids used to ask for kinds [1,5] only. Between them,
// no vote cast by anyone else ever matched a filter — every thread showed nothing but your own
// optimistic +1, and it stayed that way for many versions because nothing tested it.
//
// So this drives the real extension in chromium against a throwaway relay on localhost and checks
// both halves: votes already sitting on a relay load with the thread (including ones with no r
// tag, as published by older versions), and a vote cast here goes out tagged so it can be found
// again. Nothing is sent to a public relay.
//
//   node tests/browser-votes.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-votes.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT, EXT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9516);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8098);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8443);

const { _secp, normalizeUrl, toBech32, sign, verify, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored, published, conns } = relay;
const RELAY_URL = relay.url;
const site = await startSite({ port: SITE_PORT, heading: 'Vote QA page' });

// --- the events already on the relay ---------------------------------------------------------
const PAGE = normalizeUrl(site.url);
const ME = newKey();
const AUTHOR = newKey(), VOTER_TAGGED = newKey(), VOTER_OLD = newKey(), VOTER_DOWN = newKey();
const now = Math.floor(Date.now() / 1000);

const comment = await sign(AUTHOR, { kind: 1111, created_at: now - 300, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'A comment worth voting on.' });
// One reaction as this version publishes them (r-tagged, so the live subscription finds it)...
const voteTagged = await sign(VOTER_TAGGED, { kind: 7, created_at: now - 200, tags: [['e', comment.id], ['p', comment.pubkey], ['r', PAGE]], content: '+' });
// ...and two as every earlier version published them: no r tag at all. These are the ones that
// were invisible, and the only way to reach them is the #e refetch asking for kind 7.
const voteOld = await sign(VOTER_OLD, { kind: 7, created_at: now - 150, tags: [['e', comment.id], ['p', comment.pubkey]], content: '+' });
const voteDown = await sign(VOTER_DOWN, { kind: 7, created_at: now - 100, tags: [['e', comment.id], ['p', comment.pubkey]], content: '-' });
stored.push(comment, voteTagged, voteOld, voteDown);

const { wd, js, wait, goto, sid, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncvote-',
    onClose: () => { site.close(); relay.close(); },
});

console.log(`\nrelay: ${RELAY_URL}\npage:  ${PAGE}\n`);
await goto(site.url);
await wait(3000);

console.log('=== setup ===');
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

// Consent, then point the extension at our relay only and give it an identity to sign with.
await js(configureScript({ relayUrl: RELAY_URL, nsec: toBech32('nsec', ME) }));
await wait(1500);

// .relay-url, not every span: each row also carries a status line now, and reading both would
// concatenate the URL with whatever that relay happens to be doing.
const relayList = await js(`${ROOT} return [...s.getElementById('relay-list').querySelectorAll('.relay-url')].map(e=>e.textContent).join(',');`);
ok('the only configured relay is the local one', relayList === RELAY_URL, relayList);

// Relays are read once at load, so the thread has to be reopened for them to apply.
await goto(site.url);
await wait(4000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(2000);

const connected = await js(`${ROOT} return s.getElementById('status').textContent;`);
ok('reconnects with the stored identity', /Connected as/.test(connected), connected);

console.log('\n=== reading votes cast by other people ===');
const shownComments = await js(`${ROOT} return s.getElementById('list').querySelectorAll('.c').length;`);
ok('the seeded comment loads from the relay', shownComments === 1, shownComments);

// Counts and, for each arrow, whether the extension considers it your own vote. The marker has to
// survive a reload: an unmarked arrow is an invitation to vote a second time.
const read = () => js(`${ROOT}
  const c = s.getElementById('list').querySelector('.c');
  if (!c) return null;
  const b = [...c.querySelectorAll('button.v')];
  const mine = e => e.classList.contains('mine') && e.getAttribute('aria-pressed') === 'true';
  return JSON.stringify({ up: b[0].textContent.trim(), down: b[1].textContent.trim(),
                          upMine: mine(b[0]), downMine: mine(b[1]) });`);
const scores = JSON.parse(await read() || 'null') || {};
// Two upvotes and one downvote are on the relay. Only one of the three carries an r tag: before
// the fix the other two were unreachable and this read "↑ 1 / ↓ 0".
ok('both upvotes are counted, including the one with no r tag', scores.up === '↑ 2', scores);
ok('the downvote with no r tag is counted too', scores.down === '↓ 1', scores);
ok('other people\'s votes are not marked as yours', !scores.upMine && !scores.downMine, scores);

console.log('\n=== casting a vote ===');
const before = published.length;
await js(`${ROOT} s.getElementById('list').querySelector('button.v').click(); return 1;`);
await wait(2500);

const sent = published.slice(before).filter(e => e.kind === 7);
ok('clicking ↑ publishes a kind-7 reaction', sent.length === 1, published.slice(before).map(e => e.kind));
if (sent.length) {
    const ev = sent[0];
    const tag = n => (ev.tags || []).filter(t => t[0] === n).map(t => t[1]);
    ok('it is a + reaction', ev.content === '+', ev.content);
    ok('it is signed by the connected identity', ev.pubkey === _secp.pubKey(ME), ev.pubkey);
    ok('it tags the comment it reacts to', tag('e')[0] === comment.id, tag('e'));
    ok('it tags the comment author', tag('p')[0] === comment.pubkey, tag('p'));
    // The half of the fix that makes a vote findable later: without an r tag, the live
    // subscription for this page will never return it to anyone.
    ok('it carries the page URL so the thread subscription finds it', tag('r')[0] === PAGE, tag('r'));

    ok('the signature verifies', await verify(ev));
}

const after = JSON.parse(await read() || 'null') || {};
ok('the count reflects the new vote', after.up === '↑ 3', after);
ok('the arrow you picked is marked as yours', after.upMine === true, after);
ok('the arrow you did not pick is left unmarked', after.downMine === false, after);

console.log('\n=== switching a vote ===');
await js(`${ROOT} s.getElementById('list').querySelectorAll('button.v')[1].click(); return 1;`);
await wait(2500);
const switched = JSON.parse(await read() || 'null') || {};
ok('switching to ↓ moves the vote rather than adding one', switched.up === '↑ 2' && switched.down === '↓ 2', switched);
ok('the mark moves with it', switched.downMine === true && switched.upMine === false, switched);

console.log('\n=== your own vote after a reload ===');
// The point of the whole exercise: a reloaded thread has to know which vote is yours. It knew
// nothing before — the arrows came back unmarked, so voting again looked possible, the count
// jumped, and a second reaction went out over your name.
const beforeReload = published.length;
await goto(site.url);
await wait(4500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(1500);
const reloaded = JSON.parse(await read() || 'null') || {};
ok('the counts come back unchanged', reloaded.up === '↑ 2' && reloaded.down === '↓ 2', reloaded);
ok('your own vote is still recognised as yours', reloaded.downMine === true, reloaded);
ok('it is the only one marked', reloaded.upMine === false, reloaded);

await js(`${ROOT} s.getElementById('list').querySelectorAll('button.v')[1].click(); return 1;`);
await wait(2000);
ok('voting the same way again publishes nothing', published.length === beforeReload, published.length - beforeReload);

// New colours need the same scrutiny as the rest: measured against what is actually painted
// behind the pill, in both themes. Bold 13px text, so WCAG AA asks for 4.5:1.
console.log('\n=== contrast of the marked arrow ===');
const rgb = v => v.match(/\d+/g).slice(0, 3).map(Number);
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// A marked ↑ and a marked ↓ are styled differently, so measure whichever one is currently marked
// and run the whole thing once per direction — otherwise half the new colours go unchecked.
const measureMarked = async direction => {
    for (const theme of ['light', 'dark']) {
        await js(`${ROOT}
          const m = s.getElementById('m');
          if (m.classList.contains('dark-mode') !== ${theme === 'dark'}) s.getElementById('theme-btn').click();
          return 1;`);
        await wait(400);
        const c = JSON.parse(await js(`${ROOT}
          const bgOf = el => { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor;
              if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
              n = n.parentElement || (n.getRootNode() && n.getRootNode().host); } return 'rgb(255, 255, 255)'; };
          const b = s.getElementById('list').querySelector('button.v.mine');
          if (!b) return null;
          const cs = getComputedStyle(b);
          return JSON.stringify({ fg: cs.color, bg: bgOf(b) });`) || 'null');
        if (!c) { ok(`${theme}: a marked ${direction} exists to measure`, false); continue; }
        const r = ratio(c.fg, c.bg);
        ok(`${theme}: marked ${direction} contrast ${r.toFixed(2)}:1 (needs 4.5:1)`, r >= 4.5, `${c.fg} on ${c.bg}`);
    }
};
await measureMarked('↓');
// Switch the vote back to ↑ and measure the other pair of colours.
await js(`${ROOT} s.getElementById('list').querySelectorAll('button.v')[0].click(); return 1;`);
await wait(2000);
await measureMarked('↑');

console.log(`\n${state.fail === 0 ? '✓' : '✗'} voting: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
