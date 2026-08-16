// Guards against drift: the security-critical snippets (secp/Schnorr, event verification,
// normalizeUrl) must be byte-identical across the Chrome extension, Firefox extension, and
// the userscript, so a fix applied to one can never silently miss another.
//
// The voting path is guarded here too. It is not security-critical, but browser-votes.mjs only
// ever loads the Chrome build, so this is the only thing standing between a vote fix and a
// silent miss in the other two distributions.
import fs from 'fs';

const FILES = {
    chrome:     new URL('../NostrComments-Chrome/content.js', import.meta.url),
    firefox:    new URL('../NostrComments-FireFox/content.js', import.meta.url),
    userscript: new URL('../NostrComments-Userscript/NostrComments.js', import.meta.url),
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
        for (const other of ['firefox', 'userscript']) {
            const s = snippet(srcs[other], start, end);
            ok(`${name} identical in ${other}`, s !== null && s === chrome);
        }
    }

    // The onboarding links are the one place the three builds are meant to differ, so this guards
    // the divergence rather than the sameness. A signer has to be installed from the store of the
    // browser you are already in; a repository README is where somebody who just clicked "generate
    // a key" gives up. The userscript runs in both browsers and cannot know which, and its users
    // went looking for a script manager to begin with, so it keeps the vendor sites.
    {
        const has = (k, t) => srcs[k].includes(t);
        ok('chrome sends people to the Chrome Web Store',
           has('chrome', 'chromewebstore.google.com/detail/nos2x/') && has('chrome', 'chromewebstore.google.com/detail/alby'));
        ok('chrome does not send them to the Firefox store', !has('chrome', 'addons.mozilla.org'));
        ok('firefox sends people to addons.mozilla.org',
           has('firefox', 'addons.mozilla.org/firefox/addon/nos2x-fox/') && has('firefox', 'addons.mozilla.org/firefox/addon/alby/'));
        ok('firefox does not send them to the Chrome store', !has('firefox', 'chromewebstore.google.com'));
        // Firefox has no nos2x. What is there is a separate port by a different author, so the
        // label has to say the name of the thing the user will actually land on.
        ok('firefox labels it nos2x-fox, the extension that exists there', has('firefox', "'nos2x-fox'"));
        ok('the userscript keeps the vendor sites', has('userscript', 'https://getalby.com') && has('userscript', 'github.com/fiatjaf/nos2x'));
        ok('the userscript picks neither store', !has('userscript', 'chromewebstore.google.com') && !has('userscript', 'addons.mozilla.org'));
        // Leaving to install one and coming back to a panel that still says nothing reads as
        // failure. All three say the same thing about it.
        for (const k of Object.keys(srcs))
            ok(`${k} tells them to reload after installing`, srcs[k].includes('Install it, then reload this page.'));
    }

    // Which signer button is lit cannot be byte-identical across the three: the userscript reads
    // window.nostr straight off the page, the extensions have to ask an asynchronous bridge and
    // remember the answer. So this guards the property rather than the text — and it guards a real
    // drift, not a hypothetical one. The userscript had it right; both extensions decided the
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
