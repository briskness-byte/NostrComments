// The switch that decides whether what you publish says it was written here.
//
// Every event this extension signs carries ["client", "NostrComments"] unless you turn that off.
// The label is what makes it possible to count how many people actually post from here, which no
// download number can answer. It is also, unavoidably, something you disclose — so it is a choice,
// and the choice is the user's.
//
// WHY THIS SUITE EXISTS. The switch shipped with `parity.test.mjs` guarding it: that suite counts
// the places that push the tag and requires every one of them to ask `labelClient` first. That is a
// good guard and it catches a fourth site added later without the check. But it reads source text.
// It cannot see whether the checkbox starts in the right position, whether clicking it is written
// down, or — the one that matters — whether `labelClient` holds the *current* value at the moment
// something is signed rather than the value it had when the page loaded.
//
// That last one is the reason to write this at all. Somebody unticks the box, posts, and is
// labelled anyway. Nothing on screen is wrong. No error appears. The only evidence is on a relay,
// in an event they cannot unpublish. A regression with no symptoms is exactly the kind a browser
// has to catch, because a person never will.
//
// Three call sites are covered here and they are not the same code: a comment, a reply, and the
// Share note — that last one built its tag from a separate hard-coded literal, which is precisely
// the sort of thing that gets missed.
//
//   node tests/browser-clienttag.mjs
//   NC_BROWSER=firefox node tests/browser-clienttag.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9605);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8165);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8525);

const { _secp, normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const published = [];
const relay = await startRelay({ port: RELAY_PORT, onEvent: (ev, api) => { published.push(ev); api.accept(); } });
const { stored } = relay;
const site = await startSite({ port: SITE_PORT, heading: 'Client tag QA page' });
const PAGE = normalizeUrl(site.url);
const now = Math.floor(Date.now() / 1000);

const ME = newKey(), MY_PUB = _secp.pubKey(ME);
const THEM = newKey();

// Something to reply to, and something of my own to share — the two paths besides a plain comment.
stored.push(await sign(THEM, {
    kind: 1111, created_at: now - 300,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'A comment worth answering.',
}));
stored.push(await sign(ME, {
    kind: 1111, created_at: now - 200,
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: 'A comment of mine, worth sharing.',
}));

const { js, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncct-',
    onClose: () => { site.close(); relay.close(); },
});

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
await wait(1200);

// --- helpers -------------------------------------------------------------------------------------
const openSettings = () => js(`${ROOT}
  if (getComputedStyle(s.getElementById('settings')).display === 'none') s.getElementById('gear-btn').click();
  return 1;`);
const closeSettings = () => js(`${ROOT} s.getElementById('settings-close')?.click(); return 1;`);
const toggleState = () => js(`${ROOT} return s.getElementById('clienttag-toggle').checked;`);
const clickToggle = () => js(`${ROOT} s.getElementById('clienttag-toggle').click(); return 1;`);
const labelled = ev => (ev.tags || []).some(t => t[0] === 'client' && t[1] === 'NostrComments');

const postComment = async text => {
    published.length = 0;
    await closeSettings();
    await js(`${ROOT}
      const i = s.getElementById('input');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input', {bubbles:true}));
      return 1;`);
await nclick("s.getElementById('send')");
    await wait(3500);
    return published.filter(e => e.kind === 1111 && e.content === text)[0] || null;
};

// --- the default ------------------------------------------------------------------------------------
// On, like most Nostr apps. A default of off would make the measurement useless and would be a
// decision taken on the user's behalf in the other direction.
console.log('\n=== labelling is on unless you say otherwise ===');
await openSettings();
await wait(500);
ok('the box starts ticked', (await toggleState()) === true);

console.log('\n=== so a comment says where it came from ===');
let ev = await postComment('A first comment, labelled.');
ok('the comment is published', !!ev, published.map(e => e.kind));
ok('and it carries the client tag', !!ev && labelled(ev), ev && ev.tags);

// --- the assertion this suite was written for -----------------------------------------------------------
// No reload between the click and the post. If `labelClient` were captured at load time this would
// still be labelled, the panel would look right, and the only trace would be on a relay.
console.log('\n=== unticking it takes effect on the very next post, with no reload ===');
await openSettings();
await wait(400);
await clickToggle();
await wait(600);
ok('the box is now clear', (await toggleState()) === false);
ok('and it says what changed', /from now on/i.test(await js(`${ROOT} return s.getElementById('msg').textContent;`)),
   await js(`${ROOT} return s.getElementById('msg').textContent;`));

ev = await postComment('A second comment, unlabelled.');
ok('the comment is still published', !!ev, published.map(e => e.kind));
ok('and it carries no client tag', !!ev && !labelled(ev), ev && ev.tags);

// --- what turning it off does not do ------------------------------------------------------------------
// PRIVACY.md promises the label goes and says plainly that this is not a cloak. If the rest of the
// tagging ever disappeared with it, the honest wording would have quietly become an overclaim.
ok('the event still scopes itself to the page', !!ev && (ev.tags || []).some(t => t[0] === 'I' && t[1] === PAGE), ev && ev.tags);
ok('and still says what kind of thing it is about', !!ev && (ev.tags || []).some(t => t[0] === 'K' && t[1] === 'web'), ev && ev.tags);
ok('and is still signed by the same key', !!ev && ev.pubkey === MY_PUB, ev && ev.pubkey);

// --- the other two call sites -----------------------------------------------------------------------------
console.log('\n=== a reply obeys it too ===');
published.length = 0;
await closeSettings();
await js(`${ROOT}
  const c = [...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('A comment worth answering'));
  [...c.querySelectorAll('button')].find(b => /Reply/i.test(b.textContent)).click();
  const i = s.getElementById('input');
  i.value = 'An unlabelled answer.';
  i.dispatchEvent(new Event('input', {bubbles:true}));
  return 1;`);
await nclick("s.getElementById('send')");
await wait(3500);
const reply = published.find(e => e.kind === 1111 && (e.tags || []).some(t => t[0] === 'e'));
ok('the reply is published', !!reply, published.map(e => e.kind));
ok('and carries no client tag', !!reply && !labelled(reply), reply && reply.tags);

// The Share note builds its tags from a separate literal rather than from CLIENT_TAG, which is
// exactly why it is worth a browser assertion of its own.
console.log('\n=== and so does the shared note, which builds its tags separately ===');
published.length = 0;
await nclick("[...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('worth sharing')).querySelector('.share-btn')");
await wait(900);
await nclick("[...s.getElementById('list').querySelectorAll('.c')].find(c => c.textContent.includes('worth sharing')).querySelector('.share-btn')");
await wait(3000);
const note = published.find(e => e.kind === 1);
ok('the note is published', !!note, published.map(e => e.kind));
ok('and carries no client tag either', !!note && !labelled(note), note && note.tags);

// --- persistence ------------------------------------------------------------------------------------------
// Storage cannot be read from here — this runs in the page, not the extension — so persistence is
// asserted the way a user would see it: come back and look.
console.log('\n=== the choice survives a reload ===');
await goto(site.url);
await wait(3500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(1000);
await openSettings();
await wait(600);
ok('and the box comes back clear', (await toggleState()) === false);

ev = await postComment('A third comment, still unlabelled.');
ok('a post after reloading is still unlabelled', !!ev && !labelled(ev), ev && ev.tags);

// --- and back again ------------------------------------------------------------------------------------------
// A switch that only travels one way is half a switch, and this direction is the one nobody tries.
console.log('\n=== ticking it again starts labelling again ===');
await openSettings();
await wait(400);
await clickToggle();
await wait(600);
ok('the box is ticked once more', (await toggleState()) === true);

ev = await postComment('A fourth comment, labelled again.');
ok('and the next post carries the tag again', !!ev && labelled(ev), ev && ev.tags);

// Both directions have to survive, not just the one somebody thought to try.
await goto(site.url);
await wait(3500);
await js(`${ROOT} s.getElementById('m').style.display='grid'; return 1;`);
await wait(1000);
await openSettings();
await wait(600);
ok('and that survives a reload as well', (await toggleState()) === true);

console.log(`\n${state.fail === 0 ? '✓' : '✗'} client tag setting: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
