// Being told that somebody replied, and being able to find out who and where.
//
// Reported from real use: the panel showed "1 new reply on your comments" and nothing else. The
// banner does build page links, but only when the reply carries a page — an uppercase I tag on a
// comment, or an r tag on a note. A reply to one of your own Nostr notes has neither, so the count
// went up and there was nowhere to go and nothing to read.
//
// Two things were wrong underneath that. Nothing kept the reply itself, only a counter and a tally
// per page, so there was nothing to show even if there had been somewhere to show it. And neither
// survived a reload, so a list in Settings would have been empty by the time anybody opened it.
//
//   node tests/browser-notiflist.mjs
//   NC_BROWSER=firefox node tests/browser-notiflist.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9562);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8121);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8491);

const { _secp, normalizeUrl, toBech32, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Notification QA page' });
const PAGE = normalizeUrl(site.url);

const ME = newKey(), ME_PUB = _secp.pubKey(ME);
const FRIEND = newKey(), FRIEND_PUB = _secp.pubKey(FRIEND);
const OTHER_PAGE = 'https://example.com/an-article';

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncnf-',
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
await wait(2500);

// The gear toggles, so clicking it blindly closes Settings as often as it opens them. Close first,
// then open, or the assertions belowprove nothing.
const openSettings = async () => {
    await js(`${ROOT}
      s.getElementById('m').style.display='grid';
      if (s.getElementById('settings').style.display === 'block') s.getElementById('settings-close').click();
      return 1;`);
    await wait(500);
    await js(`${ROOT} s.getElementById('gear-btn').click(); return 1;`);
    await wait(1800);
};
const list = () => js(`${ROOT}
  const box = s.getElementById('notiflist');
  if (!box) return JSON.stringify({ missing: true });
  return JSON.stringify({
    text: box.textContent,
    rows: [...box.querySelectorAll('.nf-row')].map(r => ({
      who: (r.querySelector('.nf-who') || {}).textContent || '',
      txt: (r.querySelector('.nf-txt') || {}).textContent || '',
      href: (r.querySelector('a') || {}).href || '',
      link: (r.querySelector('a') || {}).textContent || '',
      unread: r.classList.contains('nf-new') })) });`);
const banner = () => js(`${ROOT}
  const b = s.getElementById('notif-banner');
  return JSON.stringify({ shown: getComputedStyle(b).display !== 'none', text: b.textContent,
                          links: [...b.querySelectorAll('a')].map(a => ({ href: a.href, text: a.textContent })) });`);

// The subscription only takes events published after it opened, so both replies are sent live.
const now = () => Math.floor(Date.now() / 1000);
const reply = async (content, tags) => {
    const ev = await sign(FRIEND, { kind: 1111, created_at: now(), content, tags });
    relay.stored.push(ev); relay.fanOut(ev);
    await wait(2500);
    return ev;
};

console.log('\n=== a reply about a page ===');
await reply('this one is about the article', [['I', OTHER_PAGE], ['K', 'web'], ['p', ME_PUB]]);
let b = JSON.parse(await banner());
ok('the banner appears', b.shown === true, b.shown);
ok('and names who replied rather than only counting', /this one is about the article/.test(b.text), b.text);
ok('with a link back to the page', b.links.some(l => l.href.includes('example.com')), b.links);

console.log('\n=== a reply with no page at all ===');
// This is the case the report was about: an answer to one of your notes carries no page.
const noteReply = await reply('replying to your note, not to a page', [['e', 'ab'.repeat(32)], ['p', ME_PUB]]);
b = JSON.parse(await banner());
ok('it is still announced', b.shown === true, b.shown);
ok('and it still has somewhere to go', b.links.length > 0, b.links);
ok('pointed at a nostr client, not at a page', b.links.some(l => /njump\.me\/note1/.test(l.href)), b.links);

console.log('\n=== the list in settings ===');
await openSettings();
let l = JSON.parse(await list());
ok('the list exists', !l.missing, l);
ok('both replies are in it', l.rows.length === 2, l.rows.length);
ok('each says who', l.rows.every(r => r.who.length > 0), l.rows.map(r => r.who));
ok('each shows what was said', l.rows.some(r => /about the article/.test(r.txt)) && l.rows.some(r => /replying to your note/.test(r.txt)), l.rows.map(r => r.txt));
// The whole point of the distinction: one is a page, the other is not, and the label says so.
ok('the page reply links to the page', l.rows.some(r => r.href.includes('example.com')), l.rows.map(r => r.href));
ok('the note reply is labelled as being on nostr', l.rows.some(r => r.link === 'on Nostr'), l.rows.map(r => r.link));

console.log('\n=== looking at it is what marks it read ===');
const badge = () => js(`
  const hosts = [...document.documentElement.children].filter(e => e.shadowRoot);
  for (const h of hosts) { const n = h.shadowRoot.getElementById('nc-nbadge');
    if (n) return JSON.stringify({ shown: getComputedStyle(n).display !== 'none', text: n.textContent }); }
  return JSON.stringify({ missing: true });`);
ok('the badge is cleared once the list has been opened', JSON.parse(await badge()).shown === false, await badge());
l = JSON.parse(await list());
ok('and nothing is left marked unread', l.rows.every(r => !r.unread), l.rows.map(r => r.unread));

// Without persistence a list in Settings is empty by the time anybody opens it, which is most of
// why the original report happened at all.
console.log('\n=== and it survives a reload ===');
await goto(site.url);
await wait(3500);
await openSettings();
l = JSON.parse(await list());
ok('the replies are still listed after a reload', l.rows.length === 2, l.rows.length);
ok('with their text intact', l.rows.some(r => /replying to your note/.test(r.txt)), l.rows.map(r => r.txt));
ok('and their destinations intact', l.rows.some(r => /njump\.me\/note1/.test(r.href)), l.rows.map(r => r.href));

console.log(`\n${state.fail ? '✗' : '✓'} reply notifications: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
