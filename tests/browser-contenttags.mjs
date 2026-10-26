// Hashtags and quotes, end to end (GitHub issues #3 and #4, Oct 2026).
//
// contenttags.test.mjs checks the functions. This checks what a relay actually receives when a
// person types them into the panel, and what the panel draws: a comment with #hashtags and a
// nostr:nevent goes out with t and q tags, a reply to it too, the note "Share" posts carries the same
// tags, and the thread shows the hashtag marked and the quote as a short link — while a page anchor
// in a URL stays part of the link and never becomes a tag.
//
// Then step 2 of #4: a quoted note that the reader's relays hold is drawn inline as a card, fetched
// only once the panel is open, never from the relay named inside the nevent, and hidden behind a
// line when its words are muted. A quoted note nobody holds stays a short link — or, when the nevent
// names a relay, a button to look it up there, which nothing presses on the reader's behalf.
// (That last part needs a test hostname mapped onto loopback, which only Chromium can do.)
//
//   node tests/browser-contenttags.mjs
//   NC_BROWSER=firefox node tests/browser-contenttags.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT, BROWSER } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9613);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8173);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8533);
// The relay a quoting author names inside the nevent. Nothing may ever connect to it.
const DECOY_PORT = Number(process.env.QA_DECOY_PORT || 8534);
// A relay with a proper name, holding a note the reader's relay does not: what "look it up" asks.
const HINT_PORT = Number(process.env.QA_HINT_PORT || 8536);
const HINT_HOST = 'hint.nctest';

const { normalizeUrl, newKey, toBech32, sign } = extensionCode();
const { ok, state } = reporter();

const NEVENT = 'nevent1qvzqqqqy2upzq3hnc7an8npsryzfkaku38dmjm35cfrmmkngk6kcvvngy7fllzs6qy88wumn8ghj7mn0wvhxcmmv9uq3wamnwvaz7tmjv4kxz7fwwpexjmtpdshxuet59uqzqgzxryf57ez3uzwj9v27zkza725nt7p4knatj3ktvzrh5u8rru5m4klnsa';
const NEVENT_ID = '204619134f6451e09d22b15e1585df2a935f835b4fab946cb60877a70e31f29b';

const published = [];
const relay = await startRelay({ port: RELAY_PORT, onEvent: (ev, api) => { published.push(ev); api.accept(); } });
const site = await startSite({ port: SITE_PORT, heading: 'Hashtag and quote QA page' });
const PAGE = normalizeUrl(site.url);
const ME = newKey();
const THEM = newKey();

// The note that gets quoted: on the reader's relay, not on the page, so only a lookup by id finds it.
const QUOTED = await sign(THEM, { kind: 1, created_at: Math.floor(Date.now() / 1000) - 3600, tags: [],
    content: 'Their speed test files sit behind the Cloudflare proxy, so the numbers say nothing. flurble' });
relay.stored.push(QUOTED);
// A name for THEM, so a mention of them can be drawn as @name.
relay.stored.push(await sign(THEM, { kind: 0, created_at: Math.floor(Date.now() / 1000) - 7200, tags: [], content: JSON.stringify({ name: 'Mira' }) }));
// Counts every time a relay answer includes it: that is the lookup happening.
let quotedAsked = 0;
const realFilter = relay.stored.filter;
relay.stored.filter = function (...a) { const r = realFilter.apply(this, a); if (r.some(e => e.id === QUOTED.id)) quotedAsked++; return r; };
const decoy = await startRelay({ port: DECOY_PORT });
// An nevent with the decoy as its relay hint (TLV 0: id, TLV 1: relay).
const tlv = [0, 32, ...Buffer.from(QUOTED.id, 'hex'), 1, ...[Buffer.from(decoy.url).length], ...Buffer.from(decoy.url)];
const QUOTE_REF = toBech32('nevent', Buffer.from(tlv).toString('hex'));

const hint = await startRelay({ port: HINT_PORT });
const ELSEWHERE = await sign(THEM, { kind: 1, created_at: Math.floor(Date.now() / 1000) - 1800, tags: [],
    content: 'Only the relay named in the quote has this one.' });
hint.stored.push(ELSEWHERE);
const HINT_URL = `wss://${HINT_HOST}:${HINT_PORT}`;
const tlv2 = [0, 32, ...Buffer.from(ELSEWHERE.id, 'hex'), 1, Buffer.from(HINT_URL).length, ...Buffer.from(HINT_URL)];
const HINT_REF = toBech32('nevent', Buffer.from(tlv2).toString('hex'));

const { js, wait, goto, finish, nclick, wd, sid } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncctags-',
    onClose: () => { site.close(); relay.close(); decoy.close(); hint.close(); },
    resolverRules: [`MAP ${HINT_HOST} 127.0.0.1`],
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

console.log('\n=== a quoted note the relays hold becomes a card (step 2) ===');
published.length = 0;
const QTEXT = `Proof, quoted: nostr:${QUOTE_REF}`;
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = ${JSON.stringify(QTEXT)};
  i.dispatchEvent(new Event('input', {bubbles:true}));
  return 1;`);
await nclick("s.getElementById('send')");
await wait(3000);
ok('the quoting comment is published', published.some(e => e.content === QTEXT));

// Reload with the panel closed: the thread loads, but nobody is looking, so nothing is looked up.
quotedAsked = 0;
await goto(site.url);
await wait(5000);
ok('with the panel closed the quoted note is not looked up', quotedAsked === 0, quotedAsked);

await nclick("s.getElementById('nc-btn')");
await wait(4000);
const card = await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Proof, quoted'));
  const k = c && c.querySelector('.nc-qcard');
  return k ? { body: k.querySelector('.nc-qbody').textContent, links: k.querySelectorAll('a').length,
               href: k.querySelector('a').href, imgs: k.querySelectorAll('img').length, hidden: k.classList.contains('nc-qhidden') } : null;`);
ok('opening the panel looks it up', quotedAsked > 0, quotedAsked);
ok('and draws it as a card', !!card && card.body.includes('speed test files'), card);
ok('the card links to the quoted note, and has no other links or pictures', card && card.links === 1 && card.imgs === 0 && card.href.startsWith('https://njump.me/nevent1'), card);
ok('the relay named inside the nevent was never contacted', decoy.conns.size === 0, decoy.conns.size);
const stillLink = await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Beware of possible'));
  return c ? { cards: c.querySelectorAll('.nc-qcard').length, links: c.querySelectorAll('a.nc-quote').length } : null;`);
ok('a quoted note no relay holds stays a short link', stillLink && stillLink.cards === 0 && stillLink.links === 1, stillLink);

// NC_SHOT=file.png saves what the card looks like, for a person to check.
if (process.env.NC_SHOT && wd) {
    await js(`${ROOT} [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Proof, quoted'))?.scrollIntoView(); return 1;`);
    await wait(500);
    const png = (await wd('GET', `/session/${sid}/screenshot`)).value;
    if (png) (await import('fs')).writeFileSync(process.env.NC_SHOT, Buffer.from(png, 'base64'));
}

if (BROWSER === 'chromium') {
    console.log('\n=== a quote only the named relay holds: a button, pressed by the reader ===');
    await js(`${ROOT} s.getElementById('m').style.display='none'; return 1;`);
    published.length = 0;
    await nclick("s.getElementById('nc-btn')");
    await wait(800);
    const HTEXT = `Elsewhere: nostr:${HINT_REF}`;
    await js(`${ROOT}
      const i = s.getElementById('input');
      i.value = ${JSON.stringify(HTEXT)};
      i.dispatchEvent(new Event('input', {bubbles:true}));
      return 1;`);
    await nclick("s.getElementById('send')");
    await wait(12000);   // the reader's relays are asked first, and given time to say no
    const before = await js(`${ROOT}
      const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Elsewhere:'));
      const b = c && c.querySelector('.nc-qlookup');
      return c ? { button: b ? b.textContent : null, cards: c.querySelectorAll('.nc-qcard').length } : null;`);
    ok('not on the reader\'s relays: a button offers the named relay', before && before.button === `Look it up on ${HINT_HOST}:${HINT_PORT}` && before.cards === 0, before);
    ok('and nothing has asked that relay yet', hint.conns.size === 0, hint.conns.size);
    await nclick("[...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Elsewhere:')).querySelector('.nc-qlookup')");
    await wait(4000);
    const after = await js(`${ROOT}
      const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Elsewhere:'));
      const k = c && c.querySelector('.nc-qcard');
      return k ? k.querySelector('.nc-qbody').textContent : null;`);
    ok('and draws the note it holds', typeof after === 'string' && after.includes('Only the relay named'), after);
    ok('the relay hint inside the first quote (an address literal) was still never used', decoy.conns.size === 0, decoy.conns.size);
} else {
    console.log('\n(look-up button: Chromium only, it needs a test hostname on loopback)');
}

console.log('\n=== a mention notifies the person and reads as @name (NIP-27) ===');
published.length = 0;
const MTEXT = `Worth asking nostr:${toBech32('npub', QUOTED.pubkey)} about this.`;
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = ${JSON.stringify(MTEXT)};
  i.dispatchEvent(new Event('input', {bubbles:true}));
  return 1;`);
await nclick("s.getElementById('send')");
await wait(4000);
const mev = published.find(e => e.content === MTEXT);
ok('the comment carries a p tag for the person mentioned', !!mev && tags(mev, 'p').some(t => t[1] === QUOTED.pubkey), mev && mev.tags);
const mdrawn = await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Worth asking'));
  const a = c && c.querySelector('a.nc-mention');
  return a ? { text: a.textContent, href: a.href } : null;`);
ok('and it reads as @name', mdrawn && mdrawn.text === '@Mira', mdrawn);
ok('linking to their profile', mdrawn && /^https:\/\/njump\.me\/npub1/.test(mdrawn.href), mdrawn);

console.log('\n=== mutes apply to the card ===');
await js(`${ROOT} s.getElementById('gear-btn').click(); s.getElementById('muteword-input').value = 'flurble'; return 1;`);
await nclick("s.getElementById('muteword-add-btn')");
await wait(800);
await js(`${ROOT} s.getElementById('settings-close')?.click(); return 1;`);
await wait(800);
const muted = await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('Proof, quoted'));
  const k = c && c.querySelector('.nc-qcard');
  return k ? { hidden: k.classList.contains('nc-qhidden'), body: k.querySelector('.nc-qbody').textContent } : null;`);
ok('a muted word hides the quoted text behind a line', muted && muted.hidden && !muted.body.includes('speed test'), muted);

await finish(state.fail ? 1 : 0);
