// Guards against drift: the security-critical snippets (secp/Schnorr, event verification,
// normalizeUrl) must be byte-identical across the Chrome and Firefox extensions, so a fix applied
// to one can never silently miss the other.
//
// The voting path is guarded here too. It is not security-critical, but browser-votes.mjs only
// ever loads the Chrome build, so this is the only thing standing between a vote fix and a
// silent miss in Firefox.
import fs from 'fs';

// The userscript was compared here too until 23.2.0, where it was frozen. It has no background
// context, so it could not follow the extensions onto the background relay transport, and a
// parity check against a file nobody edits any more would only stand in the way of fixes.
const FILES = {
    chrome:  new URL('../NostrComments-Chrome/content.js', import.meta.url),
    firefox: new URL('../NostrComments-FireFox/content.js', import.meta.url),
};

function snippet(src, start, endMarker) {
    const s0 = src.indexOf(start);
    if (s0 < 0) return null;
    const s1 = src.indexOf(endMarker, s0);
    if (s1 < 0) return null;
    return src.slice(s0, s1);
}

export async function run() {
    let p = 0, f = 0;
    const ok = (n, c) => { c ? p++ : f++; if (!c) console.log('  ✗ FAIL ' + n); };

    const srcs = Object.fromEntries(Object.entries(FILES).map(([k, u]) => [k, fs.readFileSync(u, 'utf8')]));

    const regions = [
        ['secp/Schnorr', 'const _secp = (() => {', '})();'],
        ['verifyEvent', 'async function verifyEvent(ev)', 'function queueVerify'],
        ['key encryption', 'const _b64 =', '// --- Event verification'],
        ['normalizeUrl', 'const _TRACKING', 'let pageUrl ='],
        // Which relays get retired out of a saved list. Wrong in one build means either a dead
        // relay nobody can reach kept alive, or somebody's own choice overwritten — and the three
        // builds do not share a storage API, so this is the part that can drift while the calls
        // around it look right.
        ['relay migration', 'const DEAD_RELAYS =', '        let RELAYS = (() => {'],
        ['bech32', 'function toBech32(hrp, hex) {', 'const toNpub ='],
        // Getting an event onto relays, and counting how many took it. Drift here is the difference
        // between a comment that survives one operator's spring clean and one that does not, and it
        // would be invisible in whichever build nobody happened to test.
        ['publishing', 'function publishOne(r, signed) {', '        // One place that turns that result'],
        // Publishing a reaction: the tags decide whether anyone can ever find the vote again.
        ['vote', 'async function vote(id, val) {', '// Fire a signed event at every configured relay'],
        // Reading them back: the live filter and the refetch that walks the comment ids.
        ['thread subscription', 'let _eoseCount = 0', '// Remember when the user last viewed'],
        // Publishing a NIP-09 request, and the two functions that decide what a reader sees —
        // including whether a deleted comment leaves a tombstone or takes its replies with it.
        // The userscript had quietly drifted here (a stray blank line in render) with nothing
        // watching, which is the whole argument for guarding these.
        ['deletion request', 'async function requestDeletion(ev) {', '// NIP-09 deletion requests, keyed by'],
        // Comment bodies, which is where a URL somebody else wrote becomes a request the reader's
        // browser makes. The referrer policy on those images is a privacy property, and one build
        // quietly missing it would leak the page address with nothing on screen to show it.
        ['renderMarkdown', 'function renderMarkdown(text) {', 'function makeItem(ev, sc, hidden'],
        ['makeItem', 'function makeItem(ev, sc, hidden, depth, reveal) {', 'function render() {'],
        ['render', 'function render() {', 'let renderTimer = null;'],
    ];
    for (const [name, start, end] of regions) {
        const chrome = snippet(srcs.chrome, start, end);
        ok(`${name} present in chrome`, !!chrome);
        const firefox = snippet(srcs.firefox, start, end);
        ok(`${name} identical in firefox`, firefox !== null && firefox === chrome);
    }

    // The onboarding links are the one place the two builds are meant to differ, so this guards
    // the divergence rather than the sameness. A signer has to be installed from the store of the
    // browser you are already in; a repository README is where somebody who just clicked "generate
    // a key" gives up.
    {
        const has = (k, t) => srcs[k].includes(t);
        ok('chrome sends people to the Chrome Web Store',
           has('chrome', 'chromewebstore.google.com/detail/nos2x/') && has('chrome', 'chromewebstore.google.com/detail/alby'));
        ok('chrome does not send them to the Firefox store', !has('chrome', 'addons.mozilla.org'));
        ok('firefox sends people to addons.mozilla.org',
           has('firefox', 'addons.mozilla.org/firefox/addon/attest/') && has('firefox', 'addons.mozilla.org/firefox/addon/alby/'));
        ok('firefox does not send them to the Chrome store', !has('firefox', 'chromewebstore.google.com'));
        // Firefox has no nos2x. It used to offer nos2x-fox, but since that project's issue #68 a web
        // page can read the PIN protecting the key and there is no fixed release upstream, so it is
        // no longer recommended at all — Attest, a fork with the hole closed, replaces it. The label
        // still has to name the thing the user will actually land on.
        ok('firefox labels it Attest, the extension that exists there', has('firefox', "'Attest'"));
        ok('firefox no longer recommends nos2x-fox', !has('firefox', 'addon/nos2x-fox'));
        // Attest is by the same developer, and the panel has to say so next to the link.
        ok('firefox says whose Attest is', has('firefox', 'Attest is by the same developer as this extension'));
        // Every place that names a signer has to name one that exists in this browser. nos2x is
        // Chrome-only — the Firefox port is nos2x-fox, which is the thing with the PIN hole — so a
        // Firefox panel saying "nos2x" sends people either nowhere or somewhere broken. Three
        // strings, and they drifted apart once already: the button, the connect failure, and the
        // refusal when nip07 is chosen with no signer present.
        ok('chrome names nos2x on the signer button', has('chrome', '>Alby / nos2x</button>'));
        ok('firefox names Attest there instead',
           has('firefox', '>Alby / Attest</button>') && !has('firefox', '>Alby / nos2x</button>'));
        ok('chrome names nos2x when no signer answers',
           has('chrome', 'Install Alby/nos2x') && has('chrome', 'install Alby or nos2x first'));
        ok('firefox names Attest there too',
           has('firefox', 'Install Alby/Attest') && has('firefox', 'install Alby or Attest first'));
        // Leaving to install one and coming back to a panel that still says nothing reads as
        // failure. Both say the same thing about it.
        for (const k of Object.keys(srcs))
            ok(`${k} tells them to reload after installing`, srcs[k].includes('Install it, then reload this page.'));
    }

    // Which signer button is lit is guarded as a property rather than as text, because the
    // extensions have to ask an asynchronous bridge for window.nostr and remember the answer — and
    // it guards a real drift, not a hypothetical one. The userscript, which reads window.nostr
    // straight off the page, had it right; both extensions decided the
    // highlight from signerPref alone, which is null until somebody presses a button, so anyone
    // signing through nos2x was shown "Key stored here" as their live choice.
    for (const [name, src] of Object.entries(srcs)) {
        const fn = snippet(src, 'function paintSignerChoice() {', '\n        }');
        ok(`${name}: paintSignerChoice is where the highlight is decided`, !!fn);
        ok(`${name}: the highlight is not decided from signerPref alone`,
           !!fn && /signerPref === null &&/.test(fn));
        ok(`${name}: and it still honours an explicit choice`,
           !!fn && /signerPref === 'nip07'/.test(fn));
    }

    // The client tag is a setting, and a setting nobody enforces is a setting that quietly stops
    // working. Somebody turning it off is asking not to be identifiable as a user of this extension
    // — so a refactor that writes the tag unconditionally is a privacy regression, in a spot where
    // the only symptom is an event nobody looks at. These assertions are the thing that notices.
    for (const [name, src] of Object.entries(srcs)) {
        const writes = src.match(/tags\.push\(CLIENT_TAG\)/g) || [];
        ok(`${name}: the tag is written where a comment is built`, writes.length === 2);
        // Every push guarded, counted rather than spot-checked, so a third one added later cannot
        // slip past by being somewhere this test did not look.
        const guarded = src.match(/if \(labelClient\) tags\.push\(CLIENT_TAG\)/g) || [];
        ok(`${name}: and every one of them asks first`, guarded.length === writes.length);
        // Sharing to your feed is a separate event with its own literal tag, and it was missed
        // once already by a change that only looked at buildEvent.
        ok(`${name}: sharing to your feed asks too`,
           src.includes("tags: labelClient ? [['client', 'NostrComments']] : [],"));
        ok(`${name}: the preference is read at startup, defaulting to on`,
           /let labelClient = _st\.(nostrcomments_)?clienttag !== false;/.test(src));
        ok(`${name}: and the checkbox writes it back`,
           /clienttagToggle\.onchange[\s\S]{0,200}?nostrcomments_clienttag/.test(src));
    }

    // One page can run this script twice: Firefox injects content scripts into already-open matching
    // tabs when an add-on is installed or updated. The second run used to append a second button on
    // top of the first, and what that looks like on screen is a badge sitting *behind* the button —
    // two buttons at the same coordinates, the older painted first and frozen at whatever count it
    // had. The ordering is the part worth pinning: clearing after appending would take the new host
    // away too, and the symptom of that is no button at all.
    for (const [name, src] of Object.entries(srcs)) {
        const clear = src.indexOf("if (el.shadowRoot && el.shadowRoot.getElementById('nc-btn')) el.remove();");
        const create = src.indexOf('document.documentElement.appendChild(host);');
        ok(`${name}: a host left by an earlier run is cleared`, clear >= 0);
        ok(`${name}: and cleared before the new host is added`, clear >= 0 && create >= 0 && clear < create);
    }

    // The toolbar entry. The popup sends nc-toggle and both builds have to listen for it — but the
    // ordering carries the feature: the pages worth reaching this way are the ones that deleted the
    // button, so the host goes back *before* anything tries to open it. Toggling first would act on
    // a panel that is not in the document, which looks like a toolbar button that does nothing.
    for (const [name, src] of Object.entries(srcs)) {
        const listen = src.indexOf("msg.t !== 'nc-toggle'");
        const reattach = src.indexOf('if (!host.isConnected) document.documentElement.appendChild(host);');
        const toggle = src.indexOf("if (modal.style.display === 'grid') closeModal(); else btn.onclick();");
        ok(`${name}: listens for the toolbar toggle`, listen >= 0);
        ok(`${name}: puts the host back when the page removed it`, reattach > listen && listen >= 0);
        ok(`${name}: and only then opens or closes the panel`, toggle > reattach && reattach >= 0);
    }

    // Chrome extension ids are fixed and public, so a page can fetch a web-accessible resource by
    // guessing its URL and learn whether the extension is installed — Google's own documentation
    // calls this out as fingerprinting. use_dynamic_url regenerates that id every session, which
    // takes the guess away. Firefox does not need it: its moz-extension UUID is already random per
    // profile, so the key is deliberately absent there rather than forgotten.
    {
        const mf = n => JSON.parse(fs.readFileSync(new URL(`../${n}/manifest.json`, import.meta.url), 'utf8'));
        const chrome = mf('NostrComments-Chrome'), firefox = mf('NostrComments-FireFox');
        const war = k => (k.web_accessible_resources || [])[0] || {};
        ok('chrome exposes only the bridge script', JSON.stringify(war(chrome).resources) === JSON.stringify(['injected.js']));
        ok('chrome rotates the resource url every session', war(chrome).use_dynamic_url === true);
        ok('firefox leaves it out, having a random uuid already', war(firefox).use_dynamic_url === undefined);
        // A rotating id is only survivable because the URL is asked for at runtime. Building it by
        // hand from a fixed id would break the bridge on the first session after this change.
        for (const [name, src] of Object.entries(srcs))
            ok(`${name}: the bridge url is asked for, not constructed`,
               !/chrome-extension:\/\//.test(src) && !/moz-extension:\/\//.test(src));
        ok('chrome asks the runtime for it', srcs.chrome.includes("runtime.getURL('injected.js')"));
        ok('firefox asks the runtime for it', srcs.firefox.includes("runtime.getURL('injected.js')"));
    }

    // Two prompts about the same key, one page. They cover opposite dangers — losing the key
    // yourself and somebody else on this computer taking it — so they stay separate, and the gate
    // is what keeps them from arriving together and being clicked away as a pair.
    for (const [name, src] of Object.entries(srcs)) {
        ok(`${name}: the password offer yields to the other prompt`,
           /async function offerEncryption[\s\S]{0,400}?if \(keyPromptShown\) return;/.test(src));
        ok(`${name}: the backup ask yields too`,
           /async function offerBackup[\s\S]{0,400}?if \(keyPromptShown\) return;/.test(src));
        ok(`${name}: and the backup ask is throttled by a stored timestamp`,
           /backupAskedAt/.test(src) && /rememberBackupAsked\(\)/.test(src));
    }

    // The badges are styled twice: inline at creation, and again in _cssText. Inline wins — over the
    // stylesheet and over anything the page tries — so editing only the rule changes nothing, which
    // is exactly what happened when the button was shrunk to 48px and the badges kept 68px spacing
    // and quietly overlapped. Both have to say the same thing.
    for (const [name, src] of Object.entries(srcs)) {
        const inline = /Object\.assign\(badge\.style, \{[^}]*?minWidth:'(\d+)px'[^}]*?\}/.exec(src);
        const rule = /#nc-badge,#nc-nbadge\{[^}]*?min-width:(\d+)px/.exec(src);
        ok(`${name}: the badge is styled inline and in the stylesheet`, !!inline && !!rule);
        ok(`${name}: and the two agree on its size`, !!inline && !!rule && inline[1] === rule[1],
           inline && rule ? [inline[1], rule[1]] : null);
    }

    // A backtick inside the stylesheet ends the template literal it lives in. The result is still
    // valid JavaScript — `node --check` says nothing — but everything after it stops being CSS, the
    // panel template never gets appended, and the extension injects a floating button that opens
    // nothing. That happened while writing a CSS comment about a class called `.own`. There is no
    // legitimate reason for a backtick in there, so the rule is simply that it must not appear.
    // Two wrong versions of this check were written before this one, and both passed against the
    // very bug they were added for. Scanning backwards from CSS content finds the stray backtick
    // and treats it as the opening; asking whether a backtick sits between the opening one and the
    // next one is answered by the stray itself being that next one. The anchor has to be the code
    // that opens the literal, not anything inside it.
    const literal = (src, openers, mustReach) => {
        const opener = openers.find(o => src.includes(o));
        if (!opener) return false;
        const open = src.indexOf(opener) + opener.length - 1;   // the backtick itself
        const close = src.indexOf('`', open + 1);
        return close > open && src.slice(open + 1, close).includes(mustReach);
    };
    for (const [name, src] of Object.entries(srcs)) {
        ok(`${name}: the stylesheet reaches its last rule in one literal`,
            literal(src, ['const _cssText = `', '_ss.replaceSync(`'], '#m.dark-mode .nc-nip05'));
        ok(`${name}: the panel template reaches its end in one literal`,
            literal(src, ['const _tpl = new DOMParser().parseFromString(`'], 'id="donate"'));
    }

    // Cheap proof that the two together still describe a working panel: these ids are what every
    // browser suite reaches for, and a truncated template drops the later ones silently.
    for (const [name, src] of Object.entries(srcs)) {
        for (const id of ['m', 'p', 'list', 'input', 'send', 'donate', 'reply-indicator', 'reply-hint']) {
            ok(`${name}: template still has #${id}`, src.includes(`id="${id}"`));
        }
    }

    return { name: 'cross-distribution parity', pass: p, fail: f };
}
