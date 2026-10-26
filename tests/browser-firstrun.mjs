// The first run, as a new reader meets it (OpenSats feedback and a walkthrough, 26 Oct 2026).
//
// A funder who tried the extension found "significant friction in basic flows (e.g. the NIP-07
// connection process)". Walking it showed why: the signer's own prompt names the website, because
// NIP-07 is asked from inside the page, while the panel said "Not connected" in red; a refusal read
// as an error with no way on; typing a comment before having a key ended at "Connect first!"; and
// the first comment was immediately covered by a "Save your key?" dialog.
//
// What must hold now:
//   - while the signer is being asked, the panel says it is waiting and what to do;
//   - after a "no", it says so plainly, makes "a key made here" the main way on, and does not ask
//     the signer again by itself when the panel is closed and opened;
//   - "Ask my signer again" does ask again;
//   - with no identity at all, Post offers to make a key and post, and posts the text typed;
//   - the header's Connect button is not doubled up next to the welcome block;
//   - the backup ask after a first comment is a bar under the box, not a dialog over the thread;
//   - who is posting is said as "Posting as …".
//
//   node tests/browser-firstrun.mjs
//   NC_BROWSER=firefox node tests/browser-firstrun.mjs
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, seedStorage, ROOT } from './harness.mjs';

const CD_PORT = Number(process.env.QA_PORT || 9694);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8694);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8695);

const { _secp, newKey } = extensionCode();
const { ok, state } = reporter();
const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'First-run QA page' });
const SIGNER_PUB = _secp.pubKey(newKey());

const { js, jsRaw, wait, goto, finish, nclick } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncfirst-',
    onClose: () => { site.close(); relay.close(); },
});

// A signer that takes `ms` to answer and then approves or refuses, counting how often it is asked.
const signer = (ms, refuse) => jsRaw(`window.__asked = window.__asked || 0; window.__refuse = ${refuse ? 'true' : 'false'};
  window.nostr = { getPublicKey: () => { window.__asked++; return new Promise((r, j) => setTimeout(() =>
      window.__refuse ? j(new Error('User rejected')) : r(${JSON.stringify(SIGNER_PUB)}), ${ms})); },
    signEvent: async () => { throw new Error('not needed here'); } }; return 1;`);
const asked = () => jsRaw('return window.__asked || 0;');
const status = () => js(`${ROOT} return s.getElementById('status').textContent;`);
const pitch = () => js(`${ROOT} return s.querySelector('.ob-pitch')?.textContent || '';`);
const button = re => js(`${ROOT} const b = [...s.querySelectorAll('#onboard button')].find(x => x.getClientRects().length && ${re}.test(x.textContent));
  return b ? { text: b.textContent, cls: b.className, disabled: b.disabled } : null;`);
const consent = async () => {
    await nclick("s.getElementById('nc-btn')");
    await wait(800);
    await nclick("[...s.querySelectorAll('button')].find(b => /I understand/.test(b.textContent))");
};
const openFresh = async () => { await js(`${ROOT} s.getElementById('m').style.display='none'; return 1;`); await wait(400); await nclick("s.getElementById('nc-btn')"); };

await goto(site.url);
await wait(2000);
await jsRaw(seedStorage({ nostrcomments_relays: [relay.url], nostrcomments_widepublish: false }));
await wait(800);

console.log('\n=== waiting for a signer that takes its time ===');
await goto(site.url);
await signer(6000, true);
await wait(2500);
await consent();
await wait(2000);
ok('the status says it is waiting for the signer', /Waiting for your signer/.test(await status()), await status());
ok('the welcome block says to approve it, and why it names the website', /approve the request in its window/.test(await pitch()) && /names this website/.test(await pitch()), await pitch());
ok('the connect button waits too', (await button('/signer/i'))?.disabled === true, await button('/signer/i'));
ok('the header Connect button is not doubled up', await js(`${ROOT} return getComputedStyle(s.getElementById('connect')).display;`) === 'none');

console.log('\n=== declining in the signer ===');
await wait(6000);
ok('the status says it was declined, plainly', (await status()) === 'You declined in your signer', await status());
ok('and not in red', await js(`${ROOT} return s.getElementById('status').className;`) !== 'err');
ok('the welcome block says what to do next', /declined/.test(await pitch()) && /key made here/.test(await pitch()), await pitch());
const again = await button('/ask my signer again/i');
ok('the signer button now offers to ask again, as the second choice', !!again && /secondary/.test(again.cls), again);
const gen = await button('/generate your key/i');
ok('and making a key here is the main way on', !!gen && /primary/.test(gen.cls), gen);
const n1 = await asked();
await openFresh();
await wait(2500);
ok('closing and opening the panel does not ask the signer again', (await asked()) === n1, { before: n1, after: await asked() });

console.log('\n=== asking again, on purpose ===');
await jsRaw('window.__refuse = false; return 1;');
await nclick("[...s.querySelectorAll('#onboard button')].find(b => /ask my signer again/i.test(b.textContent))");
await wait(800);
ok('pressing it asks the signer', (await asked()) === n1 + 1, await asked());
await wait(6500);
ok('and once approved the panel says who is posting', /^Posting as /.test(await status()), await status());

console.log('\n=== no identity at all: Post offers to make a key and post ===');
await jsRaw(`delete window.nostr; return 1;`);
await jsRaw(seedStorage({ nostrcomments_signer_pub: null, nostrcomments_signer: null }));
await wait(500);
await goto(site.url + 'second-page');
await wait(3000);
await nclick("s.getElementById('nc-btn')");
await wait(1500);
const TEXT = 'Typed before having any key.';
await js(`${ROOT} const i = s.getElementById('input'); i.value = ${JSON.stringify(TEXT)}; i.dispatchEvent(new Event('input', {bubbles:true})); return 1;`);
await nclick("s.getElementById('send')");
await wait(1200);
const dlg = await js(`${ROOT} const y = s.getElementById('ask-yes'); return y && y.getClientRects().length ? { yes: y.textContent, body: y.closest('div').parentElement.textContent } : null;`);
ok('Post asks whether to make a key and post', !!dlg && /Make a key and post/.test(dlg.yes), dlg);
await nclick("s.getElementById('ask-no')");
await wait(600);
ok('"Not now" keeps the text in the box', await js(`${ROOT} return s.getElementById('input').value;`) === TEXT);
ok('and posts nothing', !relay.published.some(e => e.content === TEXT));
await nclick("s.getElementById('send')");
await wait(1200);
await nclick("s.getElementById('ask-yes')");
await wait(4000);
ok('"Make a key and post" posts the comment', relay.published.some(e => e.content === TEXT), relay.published.map(e => e.content));
ok('and the panel says who is posting', /^Posting as /.test(await status()), await status());

console.log('\n=== the backup ask is a bar, not a dialog ===');
const bar = await js(`${ROOT} const b = s.getElementById('backup-bar'); return b ? getComputedStyle(b).display : null;`);
ok('a bar under the box offers the backup', bar === 'flex', bar);
ok('and no dialog covers the thread', await js(`${ROOT} const y = s.getElementById('ask-yes'); return !!(y && y.getClientRects().length);`) === false);
await nclick("s.getElementById('backup-later')");
await wait(500);
ok('"Later" puts it away', await js(`${ROOT} return getComputedStyle(s.getElementById('backup-bar')).display;`) === 'none');

await finish(state.fail ? 1 : 0);
