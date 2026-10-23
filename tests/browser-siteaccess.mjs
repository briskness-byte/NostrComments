// Site access restricted by the browser: Chrome's "On specific sites".
//
// A reader asked for a whitelist mode (Sep 2026). The browser already has one: right-click the icon,
// "This can read and change site data", "On specific sites". This checks that NostrComments behaves
// under it, using Chrome's own setting rather than an edited manifest: chrome://extensions exposes
// developerPrivate, which is what that menu calls.
//
// Confirms: with access withheld, nothing is injected on a site that was not allowed — no panel, no
// button, so no relay hears about the page; on the allowed site the panel injects and opens; and the
// popup's "open" message to a tab without access rejects rather than hanging, so the popup can say so.
//
//   node tests/browser-siteaccess.mjs
//
// Chromium only: Firefox's equivalent (Permissions tab in about:addons) has no scriptable switch.
// Requires: chromium (or Chrome) and chromedriver; openssl; Node 18+.
import { reporter, startRelay, startSite, startBrowser, BROWSER, ROOT } from './harness.mjs';

if (BROWSER === 'firefox') { console.log('Chromium only; skipped under Firefox.'); process.exit(0); }

const CD_PORT = Number(process.env.QA_PORT || 9611);
const SITE_PORT = Number(process.env.QA_SITE_PORT || 8171);
const RELAY_PORT = Number(process.env.QA_RELAY_PORT || 8531);

const { ok, state } = reporter();
const relay = await startRelay({ port: RELAY_PORT });
const site = await startSite({ port: SITE_PORT, heading: 'Site-access QA page' });
// One server, two origins: the extension is allowed on localhost and not on 127.0.0.1.
const ALLOWED = `http://localhost:${SITE_PORT}/allowed`;
const BLOCKED = `http://127.0.0.1:${SITE_PORT}/not-allowed`;

const { jsRaw: js, nclick, wait, goto, finish } = await startBrowser({
    cdPort: CD_PORT, prefix: 'ncaccess-',
    onClose: () => { site.close(); relay.close(); },
});
const injected = () => js(`${ROOT} return !!s;`);

console.log('=== before: all sites ===');
await goto(BLOCKED);
await wait(2500);
ok('with the default access the extension injects everywhere', await injected() === true);

console.log('\n=== restrict to one site ===');
await goto('chrome://extensions');
await wait(1500);
const ext = await js(`
    window.__r = null;
    chrome.developerPrivate.getExtensionsInfo(list => {
        const e = list.find(x => x.name === 'NostrComments');
        if (!e) { window.__r = { err: 'not found: ' + list.map(x => x.name).join(',') }; return; }
        chrome.developerPrivate.updateExtensionConfiguration({ extensionId: e.id, hostAccess: 'ON_SPECIFIC_SITES' }, () => {
            chrome.developerPrivate.addHostPermission(e.id, 'http://localhost:${SITE_PORT}/*', () => {
                chrome.developerPrivate.getExtensionInfo(e.id, info => {
                    window.__r = { id: e.id, access: info.permissions?.runtimeHostPermissions?.hostAccess,
                                   hosts: (info.permissions?.runtimeHostPermissions?.hosts || []).filter(h => h.granted).map(h => h.host),
                                   err: chrome.runtime.lastError?.message };
                });
            });
        });
    });
    return 1;`);
let r = null;
for (let i = 0; i < 20 && !r; i++) { await wait(250); r = await js('return window.__r;'); }
ok('Chrome took the "On specific sites" setting', r && r.access === 'ON_SPECIFIC_SITES', r);
ok('with localhost as the one allowed site', r && r.hosts.some(h => h.includes('localhost')), r && r.hosts);
const ID = r && r.id;

console.log('\n=== a site that was not allowed ===');
await goto(BLOCKED);
await wait(3000);
ok('nothing is injected: no panel, no button', await injected() === null);
ok('the page has no NostrComments element at all', await js(`return document.documentElement.querySelectorAll(':scope > *').length;`) <= 2);

console.log('\n=== the allowed site ===');
await goto(ALLOWED);
await wait(3000);
ok('the extension injects on the allowed site', await injected() === true);
await nclick("s.getElementById('nc-btn')");
await wait(800);
ok('and the panel opens', await js(`${ROOT} return s.getElementById('m').style.display;`) === 'grid');

console.log('\n=== the popup on a site without access ===');
// Ask the way popup.js does, from an extension page, at a tab on the site without access.
await goto(`chrome-extension://${ID}/popup.html`);
await wait(1000);
await js(`
    window.__m = null;
    (async () => {
        const nt = await chrome.tabs.create({ url: '${BLOCKED}', active: false });
        await new Promise(res => setTimeout(res, 2500));
        try { await chrome.tabs.sendMessage(nt.id, { t: 'nc-toggle' }); window.__m = 'delivered'; }
        catch (e) { window.__m = 'rejected: ' + e.message; }
    })();
    return 1;`);
let m = null;
for (let i = 0; i < 30 && !m; i++) { await wait(250); m = await js('return window.__m;'); }
ok('the popup\'s message to a tab without access rejects (so the popup shows its hint)', typeof m === 'string' && m.startsWith('rejected'), m);
const hint = await js(`return document.getElementById('open') ? 'has open button' : 'no open button';`);
ok('the popup itself loads normally', hint === 'has open button', hint);

// The popup tells "allowed here" from "allowed elsewhere" with these two calls (singleSites()).
await js(`
    window.__p = null;
    (async () => {
        const allowed = await chrome.permissions.contains({ origins: ['http://localhost:${SITE_PORT}/*'] });
        const blocked = await chrome.permissions.contains({ origins: ['http://127.0.0.1:${SITE_PORT}/*'] });
        const every = await chrome.permissions.contains({ origins: ['<all_urls>'] });
        const all = await chrome.permissions.getAll();
        window.__p = { allowed, blocked, every, origins: all.origins };
    })();
    return 1;`);
let p = null;
for (let i = 0; i < 20 && !p; i++) { await wait(250); p = await js('return window.__p;'); }
ok('the browser confirms the allowed site to the popup', p && p.allowed === true, p);
ok('  and denies the other one', p && p.blocked === false, p);
ok('  and reports no access to all sites', p && p.every === false, p);
ok('  and lists the allowed site among its origins', p && (p.origins || []).some(o => o.includes('localhost')), p);
// Opened as a tab, the popup's own tab is the active one: an extension page, so "elsewhere".
await goto(`chrome-extension://${ID}/popup.html`);
await wait(1500);
const status = await js(`return document.getElementById('status').textContent;`);
ok('the popup shows the "not allowed on this site" view there', /not allowed on this site/i.test(status), status);

await finish(state.fail ? 1 : 0);
