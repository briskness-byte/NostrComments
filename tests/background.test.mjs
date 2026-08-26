// The background relay client — phase 1, where it exists but nothing uses it.
//
// The whole point of moving relay traffic here is that a page cannot reach it, which also means a
// browser test driving a page cannot reach it directly either. So this suite does what
// popup.test.mjs does: take the real shipped file, lift the decision logic out of it, and exercise
// that. What needs a live socket — the service worker's lifetime, a real REQ round trip — is phase
// 2, next to the in-page path it has to agree with.
//
// The assertions below are about properties that would each cost something real if they broke:
// two tabs colliding on one subscription id, one relay counted twice, a socket closed out from
// under a publish, or the consent gate applying to the first message only.
import fs from 'fs';

const FILES = {
    chrome:  new URL('../NostrComments-Chrome/background.js', import.meta.url),
    firefox: new URL('../NostrComments-FireFox/background.js', import.meta.url),
};

// Lift a top-level `function name(...) {...}` out of the source by brace matching, so the test
// runs the shipped code rather than a copy that can drift away from it.
function lift(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) return null;
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { i++; break; }
    }
    try { return (0, eval)(`(${src.slice(start, i)})`); } catch (e) { return null; }
}

export async function run() {
    let p = 0, f = 0;
    const ok = (n, c, extra) => {
        c ? p++ : f++;
        if (!c) console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
    };

    const read = u => { try { return fs.readFileSync(u, 'utf8'); } catch (e) { return null; } };
    const srcs = Object.fromEntries(Object.entries(FILES).map(([k, u]) => [k, read(u)]));
    for (const [k, v] of Object.entries(srcs)) ok(`the ${k} build has background.js`, v !== null);
    if (Object.values(srcs).some(v => v === null)) return { name: 'background relay client', pass: p, fail: f };

    ok('it is identical in both extension builds', srcs.chrome === srcs.firefox);
    ok('it picks the API object at runtime rather than hard-coding one',
       srcs.chrome.includes("typeof browser !== 'undefined' ? browser : chrome"));

    const src = srcs.chrome;

    // --- subscription keys: what stops two tabs colliding -----------------------------------------
    const subKey = lift(src, 'subKey');
    const wireId = lift(src, 'wireId');
    ok('subKey can be read out of the shipped file', typeof subKey === 'function');
    ok('wireId can be read out of the shipped file', typeof wireId === 'function');
    if (typeof subKey === 'function' && typeof wireId === 'function') {
        // Two tabs both call their first subscription "s1". If those collapsed to one key, the
        // second tab's REQ would replace the first tab's and one page would go quiet.
        ok('the same sub id from two ports is two different keys', subKey(1, 's1') !== subKey(2, 's1'));
        ok('and two ids on one port are different too', subKey(1, 's1') !== subKey(1, 's2'));
        ok('the same port and id are stable', subKey(3, 's7') === subKey(3, 's7'));

        const w = wireId(subKey(1, 's1'));
        ok('the wire id is different for different subs', wireId(subKey(1, 's1')) !== wireId(subKey(2, 's1')));
        // Relays take a string, and NIP-01 caps it at 64 characters. Longer is a protocol error
        // that would show up as a subscription that silently never returns anything.
        ok('the wire id fits what NIP-01 allows', w.length > 0 && w.length <= 64, w);
        ok('and carries nothing but letters and digits', /^[a-zA-Z0-9]+$/.test(w), w);
        // The id goes to a third party on every subscription. It is built from a local port number
        // and a counter, so there is nothing in it to learn — this pins that.
        ok('a page address never reaches the wire id',
           !wireId(subKey(9, 's1')).includes('example') && !/[./:]/.test(wireId(subKey(9, 's1'))));
    }

    // --- relay lists: one relay, counted once ------------------------------------------------------
    const dedupe = lift(src, 'dedupe');
    ok('dedupe can be read out of the shipped file', typeof dedupe === 'function');
    if (typeof dedupe === 'function') {
        ok('a trailing slash is the same relay',
           dedupe(['wss://nos.lol', 'wss://nos.lol/']).length === 1, dedupe(['wss://nos.lol', 'wss://nos.lol/']));
        ok('so is a difference in case',
           dedupe(['wss://Nos.LOL', 'wss://nos.lol']).length === 1);
        // Collapsing duplicates must not rewrite the survivor: a relay is addressed by the string
        // it was given, and lowercasing a path can change where it points.
        ok('the first spelling is what survives',
           dedupe(['wss://Nos.LOL', 'wss://nos.lol'])[0] === 'wss://Nos.LOL', dedupe(['wss://Nos.LOL', 'wss://nos.lol']));
        ok('different relays are all kept',
           dedupe(['wss://nos.lol', 'wss://relay.damus.io']).length === 2);
        ok('order is preserved', dedupe(['wss://b.example', 'wss://a.example'])[0] === 'wss://b.example');
        ok('rubbish in the list is dropped rather than dialled', dedupe([null, 42, {}, 'wss://ok.example']).length === 1);
        ok('an empty list stays empty', dedupe([]).length === 0);
    }

    // --- when a socket may be closed ----------------------------------------------------------------
    const isIdle = lift(src, 'isIdle');
    ok('isIdle can be read out of the shipped file', typeof isIdle === 'function');
    if (typeof isIdle === 'function') {
        ok('no subscribers and no publishes is idle', isIdle({ subs: new Set(), pubs: new Set() }) === true);
        ok('a subscriber keeps it open', isIdle({ subs: new Set(['a']), pubs: new Set() }) === false);
        // This is the one that matters most: a publish is in flight and the last subscription has
        // just gone. Closing here loses the comment and reports it as "closed without answering".
        ok('a publish in flight keeps it open with no subscribers left',
           isIdle({ subs: new Set(), pubs: new Set(['evid']) }) === false);
    }

    // --- the consent gate ------------------------------------------------------------------------------
    // The content script asks nothing before consent. This checks again, from storage, so a content
    // script that has been tampered with cannot talk this into opening a socket.
    const handler = src.slice(src.indexOf('port.onMessage.addListener'), src.indexOf('port.onDisconnect.addListener'));
    ok('the message handler was found', handler.length > 0);
    ok('consent is checked in the handler', /if \(!consent\)/.test(handler));
    // Gating only the first message would leave every later sub and publish ungated. The check has
    // to sit above the dispatch, so assert it comes before all three verbs rather than after any.
    for (const verb of ['sub', 'unsub', 'pub']) {
        ok(`the gate is above '${verb}'`,
           handler.indexOf('if (!consent)') >= 0 && handler.indexOf('if (!consent)') < handler.indexOf(`msg.t === '${verb}'`));
    }
    ok('withdrawing consent tears down what is already open', /if \(!consent\) dropEverything/.test(src));
    ok('a closed tab takes its subscriptions with it',
       /onDisconnect[\s\S]{0,200}removeSub/.test(src));

    // --- what stays in the page, and must not appear here ------------------------------------------------
    // Signing needs window.nostr, which only exists in the page. If a key ever turns up in this
    // file the whole argument for the split has gone.
    //
    // Comments are stripped first, and that is not a loophole: the header of the file under test
    // explains the split, so it names the very things the split forbids. Asserting against the raw
    // text would mean the file could not describe its own design. What must stay clean is the code.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    ok('stripping comments left the code behind', code.includes('api.runtime.onConnect'));
    for (const forbidden of ['nostrcomments_privkey', 'window.nostr', 'getPublicKey', 'signEvent']) {
        ok(`no sign of the key path: ${forbidden}`, !code.includes(forbidden));
    }

    // --- wiring ---------------------------------------------------------------------------------------
    const mfs = {
        chrome:  JSON.parse(fs.readFileSync(new URL('../NostrComments-Chrome/manifest.json', import.meta.url), 'utf8')),
        firefox: JSON.parse(fs.readFileSync(new URL('../NostrComments-FireFox/manifest.json', import.meta.url), 'utf8')),
    };
    ok('chrome registers it as an MV3 service worker', mfs.chrome.background?.service_worker === 'background.js', mfs.chrome.background);
    // Firefox MV3 takes a scripts array; service_worker is not the portable spelling there.
    ok('firefox registers it as an event page', mfs.firefox.background?.scripts?.[0] === 'background.js', mfs.firefox.background);
    // A background page needs no new permission. If one appears, it belongs in a store listing
    // explanation before it belongs in a manifest — this account has had two rejections already.
    for (const [name, mf] of Object.entries(mfs))
        ok(`${name} still asks for nothing but storage`, JSON.stringify(mf.permissions) === JSON.stringify(['storage']), mf.permissions);

    const build = fs.readFileSync(new URL('../build.sh', import.meta.url), 'utf8');
    ok('the build packs it', /PACKED=.*background\.js/.test(build));

    // --- the deliberate divergence ------------------------------------------------------------------------
    // A userscript has no background context, so it keeps the in-page sockets and keeps the CSP
    // limitation with them. That is a decision, not an oversight, and asserting it here is what
    // stops it being quietly "fixed" by copying the file across.
    const user = read(new URL('../NostrComments-Userscript/NostrComments.js', import.meta.url));
    ok('the userscript was found', user !== null);
    if (user !== null) {
        ok('the userscript does not try to open a port', !user.includes("runtime.connect({name: 'nc-relay'})"));
        ok('and keeps its own sockets', user.includes('new WebSocket'));
    }

    // --- default off ---------------------------------------------------------------------------------------
    // Phase 1 ships this dark. Every user is still on the in-page path, and a build where that
    // flipped by accident is a build where an untested architecture went out to the stores.
    for (const [name, u] of [['chrome', '../NostrComments-Chrome/content.js'], ['firefox', '../NostrComments-FireFox/content.js']]) {
        const cs = read(new URL(u, import.meta.url));
        ok(`${name} reads the flag from storage`, cs.includes("_st.nostrcomments_worker === true"));
        ok(`${name} defaults it to off`, !/nostrcomments_worker\s*:\s*true/.test(cs));
        // Nothing may call it yet — that is what makes phase 1 safe to ship next to a release.
        const calls = (cs.match(/workerRelay\.(sub|publish)\(/g) || []);
        ok(`${name} has no caller yet`, calls.length === 0, calls);
    }

    return { name: 'background relay client', pass: p, fail: f };
}
