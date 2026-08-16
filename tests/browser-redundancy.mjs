// How many relays actually end up holding a comment.
//
// publishToRelays resolves on the first acceptance, which is what keeps posting quick — and meant
// one relay and nine looked identical from the outside. They are not. Measured 14 Aug 2026 over the
// previous 180 days, counting only the tag shape this extension writes (the wider NIP-22 web corpus
// on those relays is mostly one CLI client): of 86 such comments from 27 keys, 20% sat on exactly
// one relay and 34% on two. One in five is one operator's decision away from gone, which is the
// single thing this extension exists not to be. It happened for real on 20min.ch: a vote survives
// naming a comment that no relay serves any more, and no deletion request was ever published.
//
// Two behaviours are pinned here. A relay that refuses for a reason worth retrying — busy, timed
// out, socket dropped — is asked once more, so a transient no does not silently cost redundancy.
// And when the dust settles on exactly one relay, the panel says so instead of looking successful.
//
//   node tests/browser-redundancy.mjs
//   NC_BROWSER=firefox node tests/browser-redundancy.mjs
//
// Requires: chromium (or Chrome), a matching chromedriver on PATH, openssl, Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9533);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8099);
const A_PORT = Number(process.env.QA_RELAY_PORT || 8461);
const B_PORT = A_PORT + 1;
const C_PORT = A_PORT + 2;

const { normalizeUrl, newKey, _secp } = extensionCode();
const { ok, state } = reporter();

// A: always accepts.
const A = await startRelay({ port: A_PORT });
// B: refuses the first time it sees an event, accepts the second. That is the transient case the
// retry exists for — "rate-limited" is what a busy strfry actually says.
const seenByB = new Map();
const B = await startRelay({
    port: B_PORT,
    onEvent: (ev, api) => {
        const n = (seenByB.get(ev.id) || 0) + 1;
        seenByB.set(ev.id, n);
        if (n === 1) api.refuse('rate-limited: slow down');
        else api.accept();
    },
});
// C: refuses on policy, every time. Nothing to retry there, and asking again would only be noise.
const C = await startRelay({ port: C_PORT, onEvent: (ev, api) => api.refuse('blocked: not accepting events from this key') });

const site = await startSite({ port: SITE_PORT, heading: 'Redundancy QA page' });
const PAGE = normalizeUrl(site.url);
const KEY = newKey();

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncred-',
    onClose: () => { site.close(); A.close(); B.close(); C.close(); },
});

const nsec = (() => {   // the import box wants an nsec
    const { toBech32 } = extensionCode();
    return toBech32('nsec', KEY);
})();

console.log(`\nA (accepts):        ${A.url}\nB (refuses once):   ${B.url}\nC (refuses always): ${C.url}\n`);
await goto(site.url);
await wait(3000);

const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

console.log('=== a transient refusal is retried ===');
await js(configureScript({ relayUrl: [A.url, B.url], nsec }));
await wait(1500);
await goto(site.url);
await wait(2500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(2000);

await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'Worth asking twice.';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);

// The first pass, then the 2s pause, then the second ask.
await wait(9000);

const onA = A.published.filter(e => e.kind === 1111 && e.content === 'Worth asking twice.');
// `stored`, not `published`: the harness records everything it is sent under `published`, so that
// would count the refused first attempt and pass against code that never retried at all.
const keptByB = B.stored.filter(e => e.kind === 1111 && e.content === 'Worth asking twice.');
ok('the relay that accepts has it', onA.length === 1, onA.length);
ok('the relay that refused once was asked twice', (seenByB.get(onA[0]?.id) || 0) >= 2, seenByB.get(onA[0]?.id));
ok('and it kept the comment after the retry', keptByB.length >= 1, keptByB.length);

// One acceptance out of two is exactly the state that used to look like a clean success.
console.log('\n=== landing on one relay is reported ===');
await js(configureScript({ relayUrl: [A.url, C.url] }));
await wait(1500);
await goto(site.url);
await wait(2500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(2000);

await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'Only one relay took this.';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);
await wait(9000);

const thin = JSON.parse(await js(`${ROOT}
  const m = s.getElementById('msg');
  return JSON.stringify({ text: m.textContent, shown: m.style.display !== 'none' });`) || '{}');
ok('the comment was published', A.published.some(e => e.content === 'Only one relay took this.'), A.published.length);
ok('and the panel says it reached only one relay', /only one relay/i.test(thin.text || ''), thin.text);
ok('the message stays on screen', thin.shown === true, thin);

// The counterpart: two acceptances is the ordinary case and must stay quiet, or the warning is
// noise and gets ignored on the day it matters.
console.log('\n=== two relays is not worth mentioning ===');
await js(configureScript({ relayUrl: [A.url, B.url] }));
await wait(1500);
await goto(site.url);
await wait(2500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(2000);
await js(`${ROOT}
  const i = s.getElementById('input');
  i.value = 'Two relays took this one.';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  s.getElementById('send').click(); return 1;`);
await wait(9000);
const quiet = await js(`${ROOT} return s.getElementById('msg').textContent;`);
ok('no thin-publish warning when two relays accepted', !/only one relay/i.test(quiet || ''), quiet);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} redundancy: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
