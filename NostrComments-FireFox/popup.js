// The one part of this extension that runs when nothing else can.
//
// Host permissions are the extension's whole surface: everything the user sees is drawn by the
// content script, and the content script does not run on a page the user has not granted access
// to. Manifest V3 makes those permissions revocable at any time, and Firefox lists them as
// optional — so "installed but granted nothing" is a reachable state, not a hypothetical.
//
// In that state the extension is not broken, it is invisible. No button, no panel, no message,
// nothing to click and nothing explaining why. This popup exists so there is always one thing that
// is reachable, because a toolbar action needs no host permission at all.
//
// It is also the only place the permission can be asked for: permissions.request() requires a user
// gesture, and the script that would normally provide one is precisely the script that is not
// running.

const api = typeof browser !== 'undefined' ? browser : chrome;
const HOSTS = { origins: ['<all_urls>'] };

// The entire popup is one decision. Kept as a pure function of the things that matter, so it can
// be tested without a browser — see tests/popup.test.mjs. `off` is the switch at the top: off
// everywhere, the way a signer's own switch works, for somebody who wants it quiet for a while
// without uninstalling it.
function view(granted, justGranted, off) {
    if (granted && off) {
        return {
            status: 'Off. Nothing appears on any page, nothing connects to a relay, and your signer is not asked for anything.',
            grant: false,
            open: false,
            hint: 'Switch it back on here whenever you like. Your key, settings and history are kept.',
        };
    }
    if (!granted) {
        return {
            status: 'NostrComments cannot see any page yet, so nothing appears on them.',
            grant: true,
            // Nothing to open: without host permissions no content script is running on any page.
            open: false,
            hint: 'It needs access to the pages you visit to know which comments belong to them. You can also grant single sites from the browser’s extensions button instead.',
        };
    }
    return {
        status: 'Active. A comment button appears in the corner of every page.',
        grant: false,
        // A page can delete the floating button — see COUNTERMEASURES.md, three ways it happens in
        // the wild — and nothing inside the page can stop it. A toolbar button is browser chrome,
        // so this is the one way in that no site can take away.
        open: true,
        // Granting does not reach into pages that are already open; the script arrives on the next
        // load. Saying so beats letting somebody conclude the button did nothing.
        hint: justGranted ? 'Reload the page you were on to see it there.' : '',
    };
}

function paint(v, off) {
    document.getElementById('enabled').checked = !off;
    document.getElementById('enabled-label').textContent = off ? 'Off' : 'On';
    document.getElementById('status').textContent = v.status;
    document.getElementById('hint').textContent = v.hint;
    document.getElementById('grant').hidden = !v.grant;
    document.getElementById('open').hidden = !v.open;
}

async function held() {
    // A browser that answers neither way is treated as not granted: offering the button costs a
    // click, hiding it strands the user with no way forward.
    try { return await api.permissions.contains(HOSTS) === true; } catch (e) { return false; }
}

async function isOff() {
    try { return (await api.storage.local.get('nostrcomments_off')).nostrcomments_off === true; } catch (e) { return false; }
}

async function refresh(justGranted) {
    const granted = await held();
    const off = await isOff();
    paint(view(granted, justGranted === true && granted, off), off);
    return granted;
}

// Pages that are open follow at once: each one listens for this key (content.js, nostrcomments_off).
document.getElementById('enabled').onchange = async e => {
    try { await api.storage.local.set({ nostrcomments_off: !e.target.checked }); } catch (err) {}
    await refresh(false);
};

// The web reader shows a page's thread with no extension at all, so it still works on the pages a
// browser keeps every extension off — its own add-on store above all. Respecting that block and
// still answering "what has been said about this page" is the reader's job, not a workaround.
// Only http(s): about: and the like have no thread. The reader normalises the address itself,
// with the same normalizeUrl, so the raw tab URL is what it should be given.
function readerLink(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        return 'https://briskness-byte.github.io/thread/?url=' + encodeURIComponent(u.href);
    } catch (e) { return null; }
}

// Toggle the panel on whatever tab is in front. tabs.query returns the id without the "tabs"
// permission, and the message rides on the host permission the extension already has, so this
// costs no new permission — which is the difference between shipping and another store review.
//
// The tabs where this cannot work are the ones no extension may touch: about:, the add-on sites,
// the Chrome Web Store. There the message has no listener and rejects, and saying so is better
// than a button that looks broken.
document.getElementById('open').onclick = async () => {
    let tab;
    try {
        [tab] = await api.tabs.query({ active: true, currentWindow: true });
        if (!tab) throw new Error('no active tab');
        await api.tabs.sendMessage(tab.id, { t: 'nc-toggle' });
        window.close();
    } catch (e) {
        document.getElementById('hint').textContent =
            'This page does not allow extensions to run, so there is nothing to open here.';
        // tab.url is only there when the host permission covers the page; without it the link
        // stays hidden and the sentence above is the whole answer, as before.
        const link = tab && readerLink(tab.url);
        const a = document.getElementById('reader');
        if (link) {
            a.hidden = false;
            a.onclick = async e => { e.preventDefault(); try { await api.tabs.create({ url: link }); } catch (err) {} window.close(); };
        }
    }
};

// The pages where the panel was opened, on an extension page no web page can read. Opening a tab
// of the extension's own needs no permission.
document.getElementById('history').onclick = async () => {
    try { await api.tabs.create({ url: api.runtime.getURL('history.html') }); } catch (e) {}
    window.close();
};

document.getElementById('grant').onclick = async () => {
    let asked = false;
    try { asked = await api.permissions.request(HOSTS) === true; } catch (e) {}
    // Ask the browser again rather than trusting what request() returned: the user can dismiss the
    // prompt, and on some builds the answer arrives before the grant is recorded.
    await refresh(asked);
};

refresh(false);
