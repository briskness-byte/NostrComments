// Replies to you: the badge, and the thread that has to show them.
//
// Two subscriptions match a reply to your comment on the page you are reading — it carries your p
// tag for the notification sub and the page's r tag for the thread sub. They shared one seen-set,
// so whichever socket delivered it first marked it seen for the other. Delivered to notifications
// first, the thread skipped it entirely: the badge counted a reply that was never drawn, and only
// a reload brought it back. The relay here delivers in that order on purpose, because the bug only
// appears in that order.
//
// Nothing covered this path before — the badge, the banner and the subscription behind them had no
// test of any kind.
//
//   node tests/browser-notifications.mjs
//   CHROMIUM=/path/to/chrome node tests/browser-notifications.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { BADGE, extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, matches, ROOT, EXT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9522);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8092);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8449);

const { _secp, normalizeUrl, toBech32, sign, verify, newKey } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored, published, conns } = relay;
const RELAY_URL = relay.url;
const site = await startSite({ port: SITE_PORT, heading: 'Notification QA page' });

// --- the page and the events already on the relay --------------------------------------------

const PAGE = normalizeUrl(site.url);
const ELSEWHERE = site.url + 'another-article';
const ME = newKey();
const MY_PUB = _secp.pubKey(ME);
const SECOND = newKey();                 // the identity switched to later
const SECOND_PUB = _secp.pubKey(SECOND);
const REPLIER = newKey();
const now = Math.floor(Date.now() / 1000);

// A comment of mine, so that replies to it carry my p tag and reach the notification subscription.
const mine = await sign(ME, { kind: 1111, created_at: now - 300, tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']], content: 'My comment, the one people reply to.' });
stored.push(mine);

// Split a matching event across the two subscriptions in a chosen order. Notifications first is
// the order that used to lose the reply.
function deliver(ev, { notificationsFirst = true } = {}) {
    const notif = [], thread = [];
    for (const c of conns) for (const [subid, filters] of c.subs) {
        if (!filters.some(f => matches(f, ev))) continue;
        (filters.some(f => f['#p']) ? notif : thread).push([c, subid]);
    }
    const first = notificationsFirst ? notif : thread;
    const second = notificationsFirst ? thread : notif;
    first.forEach(([c, id]) => c.send(JSON.stringify(['EVENT', id, ev])));
    stored.push(ev);
    return new Promise(r => setTimeout(() => {
        second.forEach(([c, id]) => c.send(JSON.stringify(['EVENT', id, ev])));
        r({ notif: notif.length, thread: thread.length });
    }, 500));
}

const { wd, js, wait, goto, sid, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncnotif-',
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
await wait(5000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(2500);

const thread = () => js(`${ROOT} return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')].map(c => c.textContent));`);
const badge = () => js(`${BADGE}
  return JSON.stringify({ shown: ncShown(nc.orange), text: ncText(nc.orange) });`);

ok('my comment is in the thread', /the one people reply to/.test(await thread() || ''), await thread());

console.log('\n=== a reply delivered to notifications before the thread ===');
const reply = await sign(REPLIER, {
    kind: 1111, created_at: Math.floor(Date.now() / 1000),
    tags: [['I', PAGE], ['K', 'web'], ['e', mine.id], ['k', '1111'], ['p', MY_PUB]],
    content: 'A reply that must not disappear.',
});
const routed = await deliver(reply, { notificationsFirst: true });
// Without a live notification subscription the rest of this proves nothing.
ok('a notification subscription is listening for replies to me', routed.notif >= 1, routed);
ok('the thread subscription matches it too', routed.thread >= 1, routed);
await wait(3000);
ok('the reply is drawn in the thread', /must not disappear/.test(await thread() || ''), await thread());

console.log('\n=== a reply on a page you are not reading ===');
const before = JSON.parse(await badge() || '{}');
// Deliberately an ordinary kind-1 note, not a NIP-22 comment: a mention somewhere else is the
// case the notification filter keeps kind 1 for, and it should still raise the badge.
// It must not reference a comment in this thread: an event tagging one of them is a reply to it,
// and the extension draws it here whatever page its author was on. That is deliberate — a reply
// belongs under its parent — so the mention has to hang off something this page has never seen.
const elsewhere = await sign(REPLIER, {
    kind: 1, created_at: Math.floor(Date.now() / 1000),
    tags: [['r', ELSEWHERE], ['e', 'f'.repeat(64), '', 'reply'], ['p', MY_PUB]],
    content: 'A reply somewhere else entirely.',
});
const routed2 = await deliver(elsewhere, { notificationsFirst: true });
ok('only the notification subscription matches it', routed2.notif >= 1 && routed2.thread === 0, routed2);
await wait(3000);
const after = JSON.parse(await badge() || '{}');
ok('the badge counts it', after.shown === true && Number(after.text) === Number(before.text || 0) + 1, { before, after });
ok('it stays out of this page\'s thread', !/somewhere else entirely/.test(await thread() || ''), await thread());

console.log('\n=== after the socket drops ===');
// The thread subscription reconnects with capped backoff; this one had nothing at all, so a
// sleeping laptop or a restarted relay ended notifications silently for the rest of the session.
const subsBefore = [...conns].reduce((n, c) => n + [...c.subs.values()].filter(f => f.some(x => x['#p'])).length, 0);
ok('a notification subscription is open to begin with', subsBefore >= 1, subsBefore);
for (const c of conns) c.close();
await wait(4000);
const subsAfter = [...conns].reduce((n, c) => n + [...c.subs.values()].filter(f => f.some(x => x['#p'])).length, 0);
ok('it comes back on its own after the socket is dropped', subsAfter >= 1, { subsBefore, subsAfter });

console.log('\n=== after switching identity ===');
await js(`${ROOT}
  s.getElementById('gear-btn').click();
  s.getElementById('privkey-import').value=${JSON.stringify(toBech32('nsec', SECOND))};
  s.getElementById('privkey-import-btn').click();
  return 1;`);
await wait(1000);
// Importing over a stored key asks first; this is the same dialog browser-identity.mjs covers.
await js(`${ROOT}
  const ov=[...s.getElementById('p').children].find(c=>c.style.zIndex==='30');
  if (ov) [...ov.querySelectorAll('button')].find(b=>/^Replace it$/i.test(b.textContent))?.click();
  return 1;`);
await wait(2500);
const identity = await js(`${ROOT} return s.getElementById('status').textContent;`);
ok('the panel reports the new identity', /Connected as/.test(identity), identity);

const forOld = await sign(REPLIER, {
    kind: 1, created_at: Math.floor(Date.now() / 1000),
    tags: [['r', ELSEWHERE], ['e', 'e'.repeat(64), '', 'reply'], ['p', MY_PUB]],
    content: 'Addressed to the identity you left.',
});
const forNew = await sign(REPLIER, {
    kind: 1, created_at: Math.floor(Date.now() / 1000),
    tags: [['r', ELSEWHERE], ['e', 'd'.repeat(64), '', 'reply'], ['p', SECOND_PUB]],
    content: 'Addressed to the identity you now use.',
});
const beforeSwitch = JSON.parse(await badge() || '{}');
const oldRouted = await deliver(forOld, { notificationsFirst: true });
await wait(2000);
const midway = JSON.parse(await badge() || '{}');
ok('nothing is still listening for the identity you left', oldRouted.notif === 0 && midway.text === beforeSwitch.text, { oldRouted, beforeSwitch, midway });
const newRouted = await deliver(forNew, { notificationsFirst: true });
await wait(2500);
const afterSwitch = JSON.parse(await badge() || '{}');
ok('replies to the identity you now use do arrive', newRouted.notif >= 1, newRouted);
ok('and the badge counts them', Number(afterSwitch.text) === Number(midway.text || 0) + 1, { midway, afterSwitch });

console.log(`\n${state.fail === 0 ? '\u2713' : '\u2717'} notifications: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
