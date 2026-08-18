// The same key saying the same thing over and over.
//
// Reported from real use on x.com: a thread of twenty near-identical lines, which is not a
// discussion but does look like one until you read it. The alternative considered and rejected was
// a spam check before posting — that runs on the honest reader and on nobody else, since the bot
// does not use this extension.
//
// So this is presentation and nothing else. Nothing is blocked, nothing is hidden from anybody, and
// every folded comment is one click away. The suite spends as much effort on what must NOT be
// folded as on what must: two people writing the same short thing is not the pattern, and neither
// is somebody posting twice.
//
//   node tests/browser-repeats.mjs
//   NC_BROWSER=firefox node tests/browser-repeats.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9595);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8155);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8515);

const { normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const { stored } = relay;
const site = await startSite({ port: SITE_PORT, heading: 'Repeats QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);

const ME = newKey();
const SPAM = newKey(), TWICE = newKey(), A = newKey(), B = newKey();
const tags = [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']];
let t = now - 2000;
const post = async (key, content) => stored.push(await sign(key, { kind: 1111, created_at: t++, tags, content }));

// Five from one key, varied the way a pitch varies: different campaign link, different punctuation.
await post(SPAM, 'Buy my thing, it is the best!! https://spam.example/a?utm_source=1');
await post(SPAM, 'Buy my thing — it is the best. https://spam.example/a?utm_source=2');
await post(SPAM, 'BUY MY THING, IT IS THE BEST!!! https://spam.example/b');
await post(SPAM, 'Buy my thing... it is the best? https://spam.example/c');
await post(SPAM, 'buy my thing it is the best https://spam.example/d');
// Twice is a double post, not a campaign. Below the threshold on purpose.
await post(TWICE, 'I said this twice by accident.');
await post(TWICE, 'I said this twice by accident.');
// Two different people, same short phrase. Grouping is per author, so neither folds.
await post(A, 'Thanks!');
await post(B, 'Thanks!');
// And something ordinary, to be sure the thread still works.
await post(A, 'A genuine remark about the article itself.');

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncrep-',
    onClose: () => { site.close(); relay.close(); },
});

const look = () => js(`${ROOT}
  const l = s.getElementById('list');
  return JSON.stringify({
    cards: l.querySelectorAll('.c').length,
    folds: [...l.querySelectorAll('.nc-same')].map(b => b.textContent),
    text: l.textContent,
  });`);

console.log(`\nrelay: ${relay.url}\npage:  ${PAGE}\n`);
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

let r;
for (let i = 0; i < 25; i++) {
    r = JSON.parse(await look());
    if (r.cards >= 5) break;
    await wait(600);
}
ok('the thread rendered', r.cards >= 5, r.cards);
if (!r.cards) { console.log('\nNothing rendered; aborting.'); await finish(1); }

console.log('\n=== the campaign is folded to one ===');
ok('exactly one fold appeared', r.folds.length === 1, r.folds);
ok('and it counts the four it put away', /4 more like this/.test(r.folds[0] || ''), r.folds);
ok('one of the five is still on screen', /Buy my thing/i.test(r.text), r.text.slice(0, 120));
// Five near-identical, four folded, plus the four that must not fold = six cards.
ok('six comments are drawn, not ten', r.cards === 6, r.cards);

console.log('\n=== what must not be folded ===');
// Two is a double post. Folding it would call somebody a spammer for pressing Post twice.
ok('a comment posted twice is left alone', (r.text.match(/twice by accident/g) || []).length === 2, r.text);
// Grouping is per author: the same phrase from two people is a coincidence, not a campaign.
ok('the same short phrase from two people is left alone', (r.text.match(/Thanks!/g) || []).length === 2, r.text);
ok('an ordinary comment is untouched', /genuine remark/.test(r.text), r.text);

console.log('\n=== nothing is hidden, only put away ===');
await js(`${ROOT} s.getElementById('list').querySelector('.nc-same').click(); return 1;`);
await wait(900);
const after = JSON.parse(await look());
ok('clicking brings all of them back', after.cards === 10, after.cards);
ok('and the fold is gone', after.folds.length === 0, after.folds);
ok('every one of the five is readable', (after.text.match(/it is the best/gi) || []).length === 5, after.text.slice(0, 200));

console.log(`\n${state.fail === 0 ? '✓' : '✗'} repeats: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
