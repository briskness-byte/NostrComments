// The badge on a fresh tab, reflecting what was already unread before this tab ever opened.
//
// unreadReplies used to start at 0 on every load regardless of what notifLog already held, so
// three unread replies from yesterday showed nothing until the next one streamed in live or the
// reader happened to open the panel. init() now reconstructs it from notifLog with the same filter
// a live arrival already used (has a page, not yet seen) and paints the badge once from that,
// instead of leaving it to the first of the four places that already called updateNotifBadge()
// reactively.
//
//   node tests/browser-notifinit.mjs
//   NC_BROWSER=firefox node tests/browser-notifinit.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { reporter, startRelay, startSite, startBrowser, seedStorage, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9564);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8128);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8492);

const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Notification-init QA page' });

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncni-',
    onClose: () => { site.close(); relay.close(); },
});

const badgeState = () => js(`${ROOT}
  const b = s.getElementById('nc-nbadge');
  return JSON.stringify({ text: b.textContent, shown: getComputedStyle(b).display !== 'none' });`);

// Four kinds of entry, so the count has to be genuinely filtered, not just a length: two unread
// with a page (the only ones that should count), one unread with no page (a bare mention — kept in
// the list, deliberately never in the badge, see the comment on unreadReplies in content.js), and
// one already seen with a page (read already, should not come back).
const NOTIFS = [
    { id: 'a', pub: 'p'.repeat(64), at: 1, txt: 'unread, has a page', where: 'https://example.com/one', seen: false },
    { id: 'b', pub: 'p'.repeat(64), at: 2, txt: 'unread, has a page too', where: 'https://example.com/two', seen: false },
    { id: 'c', pub: 'p'.repeat(64), at: 3, txt: 'unread, no page — a bare mention', where: '', seen: false },
    { id: 'd', pub: 'p'.repeat(64), at: 4, txt: 'already seen', where: 'https://example.com/three', seen: true },
];

console.log('=== a fresh profile with nothing stored shows nothing ===');
await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }
let st = JSON.parse(await badgeState());
ok('the badge starts empty, nothing seeded yet', st.shown === false, st);

console.log('=== seeding unread history from "before this tab existed", then loading fresh ===');
await js(seedStorage({ nostrcomments_notifs: NOTIFS }));
await wait(300);
await goto(site.url); // a fresh load — content.js reads notifLog once, at init
await wait(2500);

st = JSON.parse(await badgeState());
ok('the badge shows on the very first paint, no live reply needed', st.shown === true, st);
ok('it counts only the two unread, page-scoped replies — not the bare mention, not the seen one',
   st.text === '2', st);

console.log(`\n${state.fail ? '✗' : '✓'} notification init: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
