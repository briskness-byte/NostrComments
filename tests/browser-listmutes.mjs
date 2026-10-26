// Two things other Nostr apps already know, respected here too (27 Oct 2026).
//
// Content warnings (NIP-36): a comment tagged ["content-warning", reason] is folded behind its reason
// until the reader asks; nothing in it is drawn, so no picture in it is fetched, before then.
//
// The reader's mute list from other apps (NIP-51, kind 10000): its public p and word entries hide
// those people and words here too. Read from the reader's own relays, never written; a setting,
// on by default; Settings says how many came from there.
//
//   node tests/browser-listmutes.mjs
//   NC_BROWSER=firefox node tests/browser-listmutes.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, setToggle, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9696);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8696);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8697);

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();
const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Mute-list and content-warning QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);
const ME = newKey(), A = newKey(), B = newKey(), C = newKey();
const comment = (key, content, extra = [], ago = 300) => sign(key, { kind: 1111, created_at: now - ago, content,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web'], ...extra] });

relay.stored.push(await comment(A, 'An ordinary comment.', [], 400));
relay.stored.push(await comment(B, 'The ending is that the butler did it.', [['content-warning', 'spoilers']], 350));
relay.stored.push(await comment(C, 'From someone muted in another app.', [], 300));
relay.stored.push(await comment(A, 'This one mentions flurble, a word muted elsewhere.', [], 250));
// The reader's own mute list, as Primal or Damus would publish it.
relay.stored.push(await sign(ME, { kind: 10000, created_at: now - 1000, content: '',
    tags: [['p', _secp.pubKey(C)], ['word', 'flurble']] }));

const browser = await startBrowser({ cdPort: CD_PORT, prefix: 'nclm-', onClose: () => { site.close(); relay.close(); } });
const { js, wait, goto, finish, nclick } = browser;
await goto(site.url);
await wait(2500);
await js(configureScript({ relayUrl: relay.url, nsec: toBech32('nsec', ME) }));
await wait(1500);
await goto(site.url);
await wait(3500);
await nclick("s.getElementById('nc-btn')");
await wait(4000);

const listText = () => js(`${ROOT} return s.getElementById('list').textContent;`);

console.log('\n=== a content warning folds the comment ===');
const cw = await js(`${ROOT} const b = s.querySelector('#list .nc-cw'); return b ? b.textContent : null;`);
ok('the comment shows its warning instead of its text', !!cw && /spoilers/.test(cw), cw);
ok('and the text itself is not on screen', !(await listText()).includes('butler did it'));
await nclick("s.querySelector('#list .nc-cw')");
await wait(600);
ok('one tap shows it', (await listText()).includes('butler did it'));

console.log('\n=== the mute list from other apps is respected ===');
const t = await listText();
ok('an ordinary comment is shown', t.includes('An ordinary comment.'));
ok('someone on the reader\'s Nostr mute list is hidden', !t.includes('From someone muted in another app.'));
ok('a word on that list hides its comment too', !t.includes('mentions flurble'));
await js(`${ROOT} if (s.getElementById('settings').style.display !== 'block') s.getElementById('gear-btn').click(); return 1;`);
await wait(800);
const note = await js(`${ROOT} return s.getElementById('listmutes-note').textContent;`);
ok('Settings says how many came from that list', /1 person and 1 word/.test(note || ''), note);

console.log('\n=== and can be switched off ===');
const off = await setToggle(browser, 'listmutes-toggle', false);
ok('the setting can be switched off', off === false, off);
await wait(800);
const t2 = await listText();
ok('then that person is shown again', t2.includes('From someone muted in another app.'));
ok('and so is the comment with that word', t2.includes('mentions flurble'));
ok('nothing was published: the list is only read', !relay.published.some(e => e.kind === 10000));

await finish(state.fail ? 1 : 0);
