// What one hostile relay among several can and cannot do to what the reader sees.
//
// A signature covers an event's serialisation, not its shape, and an event's id is a claim until
// it has been checked against the content. Three things followed from taking either on trust:
//
//   - an event whose `content` is not a string is signed correctly and passes verification, then
//     throws in render() — after which no comment on that page is drawn for anybody who reads it;
//   - the seen-set was written before verification, so a forged copy carrying a real comment's id
//     and arriving first made the extension ignore the genuine copy from every honest relay. One
//     relay was enough to hide any comment it knew the id of, which is the failure that reading
//     from several relays exists to prevent;
//   - the profile merged into a "Change name" publish was taken from whichever relay answered,
//     unchecked, so a relay could write fields into the reader's own profile and have them
//     published under the reader's key.
//
// Each case has a control on a page where the hostile relay does nothing, so a pass cannot mean
// the page never loaded.
//
//   node tests/browser-hostilerelay.mjs
//   NC_BROWSER=firefox node tests/browser-hostilerelay.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9701);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8701);
const EVIL_PORT = Number(process.env.QA_EVIL_PORT || 8702);
const HONEST_PORT = Number(process.env.QA_HONEST_PORT || 8703);

const { _secp, normalizeUrl, toBech32, sign, newKey } = extensionCode();
const { ok, state } = reporter();

const evil = await startRelay({ port: EVIL_PORT });
const honest = await startRelay({ port: HONEST_PORT, replyDelay: 1500 });   // the slower one, as in life
const site = await startSite({ port: SITE_PORT, heading: 'Hostile relay QA page' });

const ME = newKey(), ME_PUB = _secp.pubKey(ME);
const OTHER = newKey();
const now = Math.floor(Date.now() / 1000);
const pg = p => normalizeUrl(site.url + p);
const tags = page => [['I', page], ['K', 'web'], ['i', page], ['k', 'web']];

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'nchr-', onClose: () => { site.close(); evil.close(); honest.close(); },
});
const thread = () => js(`${ROOT} return JSON.stringify([...s.getElementById('list').querySelectorAll('.c')].map(c => c.textContent.replace(/\\s+/g,' ').slice(0,80)));`);

await goto(site.url); await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }
await js(configureScript({ relayUrl: [evil.url, honest.url], nsec: toBech32('nsec', ME) }));
await wait(2500);

console.log('\n=== an event whose content is not a string ===');
const okC = await sign(OTHER, { kind: 1111, created_at: now - 50, tags: tags(pg('c-control')), content: 'an ordinary comment' });
const okC2 = await sign(OTHER, { kind: 1111, created_at: now - 50, tags: tags(pg('c-attack')), content: 'an ordinary comment' });
const nonString = await sign(OTHER, { kind: 1111, created_at: now - 40, tags: tags(pg('c-attack')), content: 5 });
const badTags = await sign(OTHER, { kind: 1111, created_at: now - 39, tags: [...tags(pg('c-attack')), 'not-a-tag', null], content: 'tags that are not arrays' });
evil.stored.push(okC, okC2, nonString, badTags);
await goto(site.url + 'c-control'); await wait(7000);
const c0 = await thread();
ok('control: the ordinary comment is shown', /ordinary comment/.test(c0 || ''), c0);
await goto(site.url + 'c-attack'); await wait(7000);
const c1 = await thread();
ok('with a non-string-content event on the page the ordinary comment is still shown', /ordinary comment/.test(c1 || ''), c1);
ok('the malformed events themselves are not drawn', !/tags that are not arrays/.test(c1 || ''), c1);

console.log('\n=== a forged copy of a real comment, served first ===');
const real = await sign(OTHER, { kind: 1111, created_at: now - 30, tags: tags(pg('d-attack')), content: 'the honest comment' });
const real2 = await sign(OTHER, { kind: 1111, created_at: now - 30, tags: tags(pg('d-control')), content: 'the honest comment' });
honest.stored.push(real, real2);
evil.stored.push({ ...real, content: 'forged replacement' });           // same id, same signature, other words
await goto(site.url + 'd-control'); await wait(7000);
const d0 = await thread();
ok('control: without a forged copy the comment is shown', /honest comment/.test(d0 || ''), d0);
await goto(site.url + 'd-attack'); await wait(7000);
const d1 = await thread();
ok('with a forged copy served first the honest relay\'s comment is still shown', /honest comment/.test(d1 || ''), d1);
ok('and the forged words are never shown', !/forged replacement/.test(d1 || ''), d1);

console.log('\n=== a profile a relay made up, merged into the reader\'s own ===');
// The reader has no profile of their own on the honest relay. The hostile one answers the profile
// lookup with a kind 0 for the reader's key — an invalid signature, and a lightning address that is
// not theirs. Publishing a name merges whatever was found into what goes out under the reader's key.
evil.stored.push({ kind: 0, pubkey: ME_PUB, created_at: now + 5000, tags: [], id: 'a'.repeat(64), sig: 'b'.repeat(128),
    content: JSON.stringify({ name: 'Made Up', lud16: 'thief@evil.example' }) });
await goto(site.url + 'e'); await wait(6000);
await js(`${ROOT} s.getElementById('m').style.display='grid'; const g=s.getElementById('gear-btn'); if (s.getElementById('settings').style.display!=='block') g.click(); return 1;`);
await wait(1500);
await js(`${ROOT} s.getElementById('setname-input').value='Robin'; return 1;`);
await nclick("s.getElementById('setname-btn')");
await wait(9000);
const named = [...evil.published, ...honest.published].filter(e => e.kind === 0 && e.pubkey === ME_PUB);
ok('the name was published', named.length >= 1, named.length);
ok('nothing the hostile relay invented went out under the reader\'s key', named.every(e => !/thief@evil/.test(e.content)), named.map(e => e.content));

console.log(`\n${state.fail === 0 ? '✓' : '✗'} hostile relay: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
