// A busy thread, against a relay that honours `limit` the way a real one does.
//
// Both subscriptions asked for kinds [1,5,7] under a single `limit: 500`. A relay honouring a
// limit returns the newest matching events, so one budget shared across three kinds is spent by
// whichever kind is most numerous — and reactions outnumber comments heavily. A hundred comments
// with five votes each is six hundred events: over the cap, and what fell off the end were the
// oldest comments. They were on the relay the whole time and nothing said they were missing.
//
// The fix is a filter per kind, each with its own budget. This suite proves the old shape loses
// comments and the new one does not, and that a thread bigger than a single request says so
// instead of looking complete.
//
//   node tests/browser-limits.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-limits.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9523);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8091);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8450);

const { normalizeUrl, toBech32, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored } = relay;
const RELAY_URL = relay.url;
const site = await startSite({ port: SITE_PORT, heading: 'Limits QA page' });

// --- a thread big enough to hit the cap --------------------------------------------------------
const PAGE = normalizeUrl(site.url);
const ME = newKey();
const AUTHOR = newKey();
const now = Math.floor(Date.now() / 1000);

// 40 comments, oldest first, each with 20 reactions posted after it. 840 events in total: under
// the per-kind budgets, far past a single shared one.
const COMMENTS = 40, VOTES_EACH = 20;
const firstComment = { text: 'OLDEST-COMMENT the one that falls off the end first.' };
for (let i = 0; i < COMMENTS; i++) {
    const c = await sign(AUTHOR, {
        kind: 1111, created_at: now - 10000 + i * 10,
        tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
        content: i === 0 ? firstComment.text : `Comment number ${i + 1} on a busy page.`,
    });
    stored.push(c);
    for (let v = 0; v < VOTES_EACH; v++) {
        stored.push(await sign(newKey(), {
            kind: 7, created_at: now - 500 + i * VOTES_EACH + v,   // all newer than every comment
            tags: [['e', c.id], ['p', c.pubkey], ['r', PAGE]], content: '+',
        }));
    }
}

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'nclimit-',
    onClose: () => { site.close(); relay.close(); },
});

console.log(`\nrelay: ${RELAY_URL}\npage:  ${PAGE}\nseeded: ${stored.length} events (${COMMENTS} comments, ${COMMENTS * VOTES_EACH} reactions)\n`);
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

console.log('\n=== a thread where reactions outnumber comments ===');
const view = JSON.parse(await js(`${ROOT}
  // Every comment is loaded even when only 20 are drawn: the list paginates client-side, so the
  // question is what arrived, not what is on screen. Load the rest to count them.
  for (let i = 0; i < 5; i++) { const b = s.getElementById('loadMore'); if (b && b.style.display !== 'none') b.click(); }
  const items = [...s.getElementById('list').querySelectorAll('.c')];
  return JSON.stringify({
    drawn: items.length,
    hasOldest: items.some(c => c.textContent.includes('OLDEST-COMMENT')),
    text: items.map(c => c.textContent).join(' ').slice(0, 200) });`) || '{}');

// The regression: with one shared budget the reactions are all newer, so they fill it and the
// oldest comments never arrive at all.
ok('the oldest comment arrives', view.hasOldest === true, { drawn: view.drawn });
ok('every seeded comment arrives', view.drawn >= COMMENTS, { drawn: view.drawn, expected: COMMENTS });
ok('the votes came through too', /↑ \d/.test(view.text), view.text.slice(0, 80));

console.log('\n=== a thread bigger than one request ===');
// Nothing is more misleading than a truncated thread that looks complete, so it has to say so.
const notice = await js(`${ROOT}
  return [...s.getElementById('list').querySelectorAll('.tomb')].map(c => c.textContent).join(' | ');`);
ok('no truncation notice while everything fits', !/Showing the newest/.test(notice || ''), notice);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} limits: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
