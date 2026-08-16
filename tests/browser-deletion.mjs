// NIP-09 deletion in a real browser, against a relay we control.
//
// Deleting your own comment has a blast radius the code did not account for. A reply is only ever
// drawn from its parent, so removing a deleted comment from the list removed everything hanging
// off it — replies written by other people, which nobody asked to delete. They did not go away on
// the relays; they just stopped being drawn, for every reader.
//
// The other half is reach. A kind 5 carries no page of its own, and the live subscription for a
// page filters on exactly that, so a deletion used to surface only on somebody's next page load.
//
// This drives the real extension against a throwaway relay on localhost: a deleted comment that
// still has replies leaves a tombstone, one with no replies disappears completely, and a deletion
// published while the thread is open arrives without a reload. Nothing is sent to a public relay.
//
//   node tests/browser-deletion.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-deletion.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { BADGE, extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, matches, ROOT, EXT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9519);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8095);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8445);

const { _secp, normalizeUrl, toBech32, sign, verify, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored, published, conns } = relay;
const RELAY_URL = relay.url;
const site = await startSite({ port: SITE_PORT, heading: 'Deletion QA page' });

// --- the page and the events already on the relay --------------------------------------------

const PAGE = normalizeUrl(site.url);
const ME = newKey();
const AUTHOR = newKey(), REPLIER = newKey(), BYSTANDER = newKey();
const now = Math.floor(Date.now() / 1000);

// A comment that gets deleted while somebody else's reply hangs off it.
const deletedRoot = await sign(AUTHOR, { kind: 1111, created_at: now - 400, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'Root comment whose author deletes it.' });
const replyByOther = await sign(REPLIER, { kind: 1111, created_at: now - 300, tags: [['I', PAGE], ['K', 'web'], ['e', deletedRoot.id], ['k', '1111']], content: 'A reply written by somebody else entirely.' });
// A second deleted comment, this one with nothing hanging off it.
const lonelyRoot = await sign(AUTHOR, { kind: 1111, created_at: now - 250, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'A deleted comment nobody replied to.' });
// And one that is never touched, to prove the blast radius stops where it should.
const untouched = await sign(BYSTANDER, { kind: 1111, created_at: now - 200, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'An unrelated comment.' });

const delRoot = await sign(AUTHOR, { kind: 5, created_at: now - 100, tags: [['e', deletedRoot.id], ['k', '1'], ['r', PAGE]], content: '' });
const delLonely = await sign(AUTHOR, { kind: 5, created_at: now - 90, tags: [['e', lonelyRoot.id], ['k', '1'], ['r', PAGE]], content: '' });
stored.push(deletedRoot, replyByOther, lonelyRoot, untouched, delRoot, delLonely);

// One comment by the identity this test signs with, so the delete button is on screen and the
// request it publishes can be inspected.
const mine = await sign(ME, { kind: 1111, created_at: now - 180, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'My own comment, deleted through the UI.' });
stored.push(mine);

// Both held back: a comment that arrives while you are reading, and its deletion moments later.
// It is deliberately NOT on the relay at load time. The refetch subscription that walks the
// comment ids stays open, so deletions of comments present at load already came through — the gap
// was a comment that showed up afterwards, whose deletion matched no filter at all.
const lateTarget = await sign(BYSTANDER, { kind: 1111, created_at: now - 5, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'Posted and deleted while you are watching.' });
const lateDeletion = await sign(BYSTANDER, { kind: 5, created_at: now - 1, tags: [['e', lateTarget.id], ['k', '1'], ['r', PAGE]], content: '' });

const { wd, js, wait, goto, sid, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncdel-',
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
  return JSON.stringify(items.map(c => ({ text: c.textContent, tomb: c.classList.contains('tomb') })));`);
let items = JSON.parse(await read() || '[]');
const has = t => items.some(i => i.text.includes(t));
const tombs = () => items.filter(i => i.tomb);

console.log('\n=== a deleted comment that still has replies ===');
ok('the deleted comment itself is gone', !has('Root comment whose author deletes it'), items.map(i => i.text.slice(0, 40)));
// This is the regression: the reply was never deleted, and its author never asked for it to go.
ok('somebody else\'s reply survives its parent being deleted', has('A reply written by somebody else'), items.map(i => i.text.slice(0, 40)));
ok('a tombstone stands in for the deleted parent', tombs().length === 1 && /deleted by its author/i.test(tombs()[0].text), tombs());
ok('the tombstone names nobody', !/npub/i.test(tombs()[0]?.text || ''), tombs()[0]?.text);

console.log('\n=== the count on the button ===');
// It used to count the raw list, so a deleted comment still added to it: the button promised two
// comments and the thread showed one. Small, but it is the panel telling you something untrue.
const badge = () => js(`${BADGE}
  return JSON.stringify({ shown: ncShown(nc.red), text: ncText(nc.red) });`);
const drawn = JSON.parse(await js(`${ROOT}
  return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')].filter(c => !c.classList.contains('tomb')).length);`) || '0');
const b = JSON.parse(await badge() || '{}');
ok('the badge matches what is actually on screen', Number(b.text) === drawn, { badge: b.text, drawn });

console.log('\n=== a deleted comment with nothing hanging off it ===');
ok('it disappears completely, leaving no tombstone', !has('A deleted comment nobody replied to') && tombs().length === 1, items.map(i => i.text.slice(0, 40)));

console.log('\n=== everything else ===');
ok('an unrelated comment is untouched', has('An unrelated comment'), items.map(i => i.text.slice(0, 40)));
ok('the comment that arrives later is not here yet', !has('while you are watching'), items.map(i => i.text.slice(0, 40)));

console.log('\n=== a comment posted and then deleted while you read ===');
const fanOut = ev => {
    stored.push(ev);
    for (const c of conns) for (const [subid, filters] of c.subs)
        if (filters.some(f => matches(f, ev))) c.send(JSON.stringify(['EVENT', subid, ev]));
};
fanOut(lateTarget);
await wait(2500);
items = JSON.parse(await read() || '[]');
ok('a comment posted while you read shows up', has('while you are watching'), items.map(i => i.text.slice(0, 40)));

fanOut(lateDeletion);
await wait(3000);
items = JSON.parse(await read() || '[]');
// This one is in neither of the old filters: kind 5 was not in the live subscription, and the
// comment is too new to be in the id list the refetch asked about.
ok('deleting it takes it off the screen without a reload', !has('while you are watching'), items.map(i => i.text.slice(0, 40)));
ok('it took nothing else with it', has('An unrelated comment') && has('A reply written by somebody else'), items.map(i => i.text.slice(0, 40)));

console.log('\n=== deleting through the UI ===');
const before = published.length;
const armed = await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('My own comment'));
  if (!c) return 'no-comment';
  const b = [...c.querySelectorAll('button')].find(b => /Delete/i.test(b.textContent));
  if (!b) return 'no-button';
  b.click();
  return b.textContent;`);
ok('deleting is two-step, not one click', /Confirm/i.test(armed) && published.length === before, armed);
await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('My own comment'));
  [...c.querySelectorAll('button')].find(b => /Confirm/i.test(b.textContent)).click(); return 1;`);
await wait(2500);

const sent = published.slice(before).filter(e => e.kind === 5);
ok('confirming publishes a kind-5 deletion request', sent.length === 1, published.slice(before).map(e => e.kind));
if (sent.length) {
    const ev = sent[0];
    const tag = n => (ev.tags || []).filter(t => t[0] === n).map(t => t[1]);
    ok('it targets the comment being deleted', tag('e')[0] === mine.id, tag('e'));
    ok('it records the kind it deletes', tag('k')[0] === '1111', tag('k'));
    // Without this the request reaches nobody who already has the thread open.
    ok('it carries the page URL so open threads see it', tag('r')[0] === PAGE, tag('r'));
    ok('it is signed by the comment author', ev.pubkey === _secp.pubKey(ME), ev.pubkey);
    ok('the signature verifies', await verify(ev));
}
items = JSON.parse(await read() || '[]');
ok('the deleted comment leaves the list', !has('My own comment'), items.map(i => i.text.slice(0, 40)));

console.log('\n=== contrast of the tombstone ===');
const rgb = v => v.match(/\d+/g).slice(0, 3).map(Number);
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
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
      const b = s.getElementById('list').querySelector('.tomb');
      if (!b) return null;
      const cs = getComputedStyle(b);
      return JSON.stringify({ fg: cs.color, bg: bgOf(b) });`) || 'null');
    if (!c) { ok(`${theme}: a tombstone exists to measure`, false); continue; }
    const r = ratio(c.fg, c.bg);
    ok(`${theme}: tombstone contrast ${r.toFixed(2)}:1 (needs 4.5:1)`, r >= 4.5, `${c.fg} on ${c.bg}`);
}

console.log(`\n${state.fail === 0 ? '\u2713' : '\u2717'} deletion: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
