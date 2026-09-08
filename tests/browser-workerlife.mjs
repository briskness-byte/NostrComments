// Does the background transport survive being left alone?
//
// This is the one question standing between the worker and being switched on by default, and it is
// the reason the flag has stayed off since v23.2.0.
//
// Chrome stops an MV3 service worker after about 30 seconds of inactivity. WebSocket traffic resets
// that timer and so does a connected port, which is why the transport works at all — but a relay
// with nothing to say sends nothing, and a reader on a quiet page does nothing either. If the
// worker is collected in that silence, the subscription goes with it, and the next reply never
// arrives. Nobody would see an error: the panel would simply stop being current, which is a worse
// failure than the empty panel this transport was built to fix. The in-page transport cannot fail
// this way, because a page that is open is alive.
//
// So: open a page, let it go completely quiet for longer than the browser's patience, then publish
// from outside and see whether the panel still hears it.
//
//   node tests/browser-workerlife.mjs                  # 5 minutes of silence, the real question
//   NC_IDLE_S=45 node tests/browser-workerlife.mjs     # past the 30s limit, for a quick pass
//   NC_BROWSER=firefox node tests/browser-workerlife.mjs
//
// Deliberately NOT in the release gate: it spends its whole runtime waiting, and what it measures
// is a property of the browser rather than of a change being released. Run it when the transport
// changes, or before turning the flag on.
//
// Requires: chromium (or Chrome) and chromedriver, or Firefox and geckodriver; openssl; Node 18+.
import { extensionCode, reporter, startRelay, startSite, startBrowser, configureScript, ROOT, BROWSER } from './harness.mjs';

const CD_PORT    = Number(process.env.QA_PORT       || 9610);
const SITE_PORT  = Number(process.env.QA_SITE_PORT  || 8170);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8530);
// Chrome's limit is ~30s. Five minutes is what the plan asked for: long enough that a worker which
// only survives by luck has stopped being lucky.
const IDLE_S     = Number(process.env.NC_IDLE_S     || 300);

const { normalizeUrl, sign, newKey, toBech32 } = extensionCode();
const { ok, state } = reporter();

const relay = await startRelay({ port: RELAY_PORT });
const site  = await startSite({ port: SITE_PORT, heading: 'Worker lifetime QA page' });

const MINE   = newKey();
const AUTHOR = newKey();
const PAGE   = normalizeUrl(site.url);

const comment = async text => sign(AUTHOR, {
    kind: 1111, created_at: Math.floor(Date.now() / 1000),
    tags: [['I', PAGE], ['K', 'web'], ['i', PAGE], ['k', 'web']],
    content: text,
});

// One comment already on the relay, so "the thread loaded" is settled before anything is timed.
relay.stored.push(await comment('Seeded before the browser started.'));

const { js, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncwl-',
    onClose: () => { site.close(); relay.close(); },
});

const thread = () => js(`${ROOT}
  s.getElementById('m').style.display='grid';
  s.getElementById('settings-close')?.click();
  return JSON.stringify([...s.getElementById('list').querySelectorAll('*')]
      .filter(e => e.children.length === 0)
      .map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(t => /Seeded before|while the page was busy|after the silence/.test(t))
      .filter((t, i, a) => a.indexOf(t) === i)
      .sort());`);

const setWorker = want => js(`${ROOT}
  s.getElementById('m').style.display='grid';
  s.getElementById('gear-btn').click();
  const t = s.getElementById('worker-toggle');
  if (!t) return 'no toggle';
  if (t.checked !== ${want}) t.click();
  s.getElementById('settings-close')?.click();
  return String(t.checked);`);

/** Push an event at whoever is subscribed, the way another client's comment would arrive. */
const arrives = async (text, waitMs = 6000) => {
    relay.fanOut(await comment(text));
    await wait(waitMs);
    return JSON.parse(await thread()).some(t => t.includes(text.slice(0, 24)));
};

console.log(`\nrelay: ${relay.url}\npage:  ${PAGE}\nidle:  ${IDLE_S}s\n`);

await goto(site.url);
await wait(3000);
const injected = await js(`${ROOT} return !!s;`);
ok('extension injects into the page', injected === true, injected);
if (!injected) { console.log('\nNothing to test; aborting.'); await finish(1); }

await js(configureScript({ relayUrl: `wss://127.0.0.1:${RELAY_PORT}`, nsec: toBech32('nsec', MINE) }));
await wait(2000);
ok('the background transport can be turned on', (await setWorker(true)) === 'true');

// The setting only takes hold on a page that has not opened its sockets yet.
await goto(site.url);
await wait(4500);

const loaded = JSON.parse(await thread());
ok('the thread loads over the background transport', loaded.length === 1, loaded);

console.log('\n=== while the page is being read ===');
ok('a comment published elsewhere arrives', await arrives('A reply that came in while the page was busy.'));

console.log(`\n=== then ${IDLE_S}s of complete silence ===`);
// Nothing is asked of the relay, nothing is clicked, nothing is loaded. This is a reader who has
// left the tab open and gone to make coffee, and it is the state the transport has to survive.
const quietFrom = relay.published.length;
const started = Date.now();
for (let left = IDLE_S; left > 0; left -= 30) {
    await wait(Math.min(30, left) * 1000);
    process.stdout.write(`  ${Math.round((Date.now() - started) / 1000)}s\r`);
}
console.log(`  ${IDLE_S}s of silence elapsed`);
ok('nothing was sent during the silence', relay.published.length === quietFrom,
   relay.published.length - quietFrom);

console.log('\n=== and now somebody replies ===');
// Longer grace here than above: if Chrome did stop the worker, a port message may wake it again,
// and a transport that recovers is a different answer from one that never hears the reply at all.
const heard = await arrives('A reply that came in after the silence.', 15000);
ok(`the subscription is still live after ${IDLE_S}s idle`, heard);
if (!heard) {
    console.log(`
  This is the finding the flag was waiting for: on ${BROWSER} the background transport does not
  survive ${IDLE_S}s of silence. Do not switch nostrcomments_worker on by default — a thread that
  quietly stops updating is worse than the empty panel this was built to fix. The fix belongs in
  the worker: keep the connection warm, or re-subscribe when it comes back.`);
}

console.log(`\n${state.fail === 0 ? '✓' : '✗'} worker lifetime: ${state.pass} passed, ${state.fail} failed`);
await finish(state.fail ? 1 : 0);
