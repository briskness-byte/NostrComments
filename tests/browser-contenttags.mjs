// Hashtags and quotes, end to end (GitHub issues #3 and #4, Oct 2026).
//
// contenttags.test.mjs checks the functions. This checks what a relay actually receives when a
// person types them into the panel, and what the panel draws: a comment with #hashtags and a
// nostr:nevent goes out with t and q tags, a reply to it too, the note "Share" posts carries the same
// tags, and the thread shows the hashtag marked and the quote as a short link — while a page anchor
// in a URL stays part of the link and never becomes a tag.
//
//   node tests/browser-contenttags.mjs
//   NC_BROWSER=firefox node tests/browser-contenttags.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9613);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8173);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8533);

const { normalizeUrl, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const NEVENT = 'nevent1qvzqqqqy2upzq3hnc7an8npsryzfkaku38dmjm35cfrmmkngk6kcvvngy7fllzs6qy88wumn8ghj7mn0wvhxcmmv9uq3wamnwvaz7tmjv4kxz7fwwpexjmtpdshxuet59uqzqgzxryf57ez3uzwj9v27zkza725nt7p4knatj3ktvzrh5u8rru5m4klnsa';
const NEVENT_ID = '204619134f6451e09d22b15e1585df2a935f835b4fab946cb60877a70e31f29b';

const published = [];
const relay = await startRelay({ port: RELAY_PORT, onEvent: (ev, api) => { published.push(ev); api.accept(); } });
const site = await startSite({ port: SITE_PORT, heading: 'Hashtag and quote QA page' });
const PAGE = normalizeUrl(site.url);
const ME = newKey();

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncctags-',
    onClose: () => { site.close(); relay.close(); },
});

await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);
await goto(site.url);
await wait(3500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(1200);

const tags = (ev, k) => (ev?.tags || []).filter(t => t[0] === k);
const TEXT = `Beware of possible #VPS #scam, see https://example.com/terms#refunds and issue #3.\n\nnostr:${NEVENT}`;

console.log('\n=== a comment with hashtags and a quote ===');
published.length = 0;
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = ${JSON.stringify(TEXT)};
  i.dispatchEvent(new Event('input', {bubbles:true}));
  return 1;`);
await nclick("s.getElementById('send')");
await wait(3500);
const ev = published.find(e => e.kind === 1111 && e.content === TEXT);
ok('the comment is published', !!ev, published.map(e => e.kind));
ok('with a t tag per hashtag, lowercase', JSON.stringify(tags(ev, 't').map(t => t[1])) === '["vps","scam"]', tags(ev, 't'));
ok('the URL anchor and the issue number are not tags', !tags(ev, 't').some(t => /refunds|^3$/.test(t[1])), tags(ev, 't'));
ok('with a q tag for the quoted note, id only', tags(ev, 'q').length === 1 && tags(ev, 'q')[0][1] === NEVENT_ID && tags(ev, 'q')[0].length === 2, tags(ev, 'q'));
ok('and still scoped to the page', tags(ev, 'I')[0]?.[1] === PAGE, tags(ev, 'I'));
ok('the text itself is unchanged', ev && ev.content === TEXT);

console.log('\n=== how the thread draws it ===');
// The relay stores what was accepted, so the panel shows the comment back from there.
const drawn = await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Beware of possible'));
  if (!c) return null;
  return {
    hashtags: [...c.querySelectorAll('.nc-hashtag')].map(e => e.textContent),
    quote: [...c.querySelectorAll('a.nc-quote')].map(a => ({ text: a.textContent, href: a.href, rel: a.rel })),
    links: [...c.querySelectorAll('a:not(.nc-quote)')].map(a => a.href),
    rawRef: c.textContent.includes('nostr:${NEVENT}'),
  };`);
ok('the comment is drawn', !!drawn, drawn);
ok('the hashtags are marked', drawn && JSON.stringify(drawn.hashtags) === '["#VPS","#scam"]', drawn && drawn.hashtags);
ok('the issue number is not', drawn && !drawn.hashtags.includes('#3'));
ok('the URL keeps its anchor as part of the link', drawn && drawn.links.some(h => h === 'https://example.com/terms#refunds'), drawn && drawn.links);
ok('the quote is a short link to the viewer', drawn && drawn.quote.length === 1 && drawn.quote[0].href === 'https://njump.me/' + NEVENT && drawn.quote[0].text.length < 40, drawn && drawn.quote);
ok('opened without a referrer', drawn && drawn.quote[0]?.rel === 'noopener noreferrer');
ok('and the long nostr: string is gone from view', drawn && drawn.rawRef === false);

console.log('\n=== a reply carries its own hashtags ===');
published.length = 0;
await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Beware of possible'));
  [...c.querySelectorAll('button')].find(b => /Reply/i.test(b.textContent)).click();
  const i = s.getElementById('input');
  i.value = 'Same here, #hosting';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  return 1;`);
await nclick("s.getElementById('send')");
await wait(3500);
const reply = published.find(e => e.kind === 1111 && tags(e, 'e').length);
ok('the reply is published', !!reply, published.map(e => e.kind));
ok('with its own t tag', JSON.stringify(tags(reply, 't').map(t => t[1])) === '["hosting"]', tags(reply, 't'));

console.log('\n=== the shared note carries the same tags ===');
published.length = 0;
const shareSel = "[...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Beware of possible')).querySelector('.nc-tofeed')";
await nclick(shareSel);
await wait(900);
await nclick(shareSel);
await wait(3000);
const note = published.find(e => e.kind === 1);
ok('the note is published', !!note, published.map(e => e.kind));
ok('with the comment\'s hashtags', JSON.stringify(tags(note, 't').map(t => t[1])) === '["vps","scam"]', tags(note, 't'));
ok('and its quote', tags(note, 'q')[0]?.[1] === NEVENT_ID, tags(note, 'q'));
ok('and still the client label', tags(note, 'client').length === 1, note && note.tags);

await finish(state.fail ? 1 : 0);
