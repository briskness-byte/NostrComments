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

// The entire popup is one decision. Kept as a pure function of the two things that matter, so it
// can be tested without a browser — see tests/popup.test.mjs.
function view(granted, justGranted) {
    if (!granted) {
        return {
            status: 'NostrComments cannot see any page yet, so nothing appears on them.',
            grant: true,
            hint: 'It needs access to the pages you visit to know which comments belong to them. You can also grant single sites from the browser’s extensions button instead.',
        };
    }
    return {
        status: 'Active. A comment button appears in the corner of every page.',
        grant: false,
        // Granting does not reach into pages that are already open; the script arrives on the next
        // load. Saying so beats letting somebody conclude the button did nothing.
        hint: justGranted ? 'Reload the page you were on to see it there.' : '',
    };
}

function paint(v) {
    document.getElementById('status').textContent = v.status;
    document.getElementById('hint').textContent = v.hint;
    document.getElementById('grant').hidden = !v.grant;
}

async function held() {
    // A browser that answers neither way is treated as not granted: offering the button costs a
    // click, hiding it strands the user with no way forward.
    try { return await api.permissions.contains(HOSTS) === true; } catch (e) { return false; }
}

async function refresh(justGranted) {
    const granted = await held();
    paint(view(granted, justGranted === true && granted));
    return granted;
}

document.getElementById('grant').onclick = async () => {
    let asked = false;
    try { asked = await api.permissions.request(HOSTS) === true; } catch (e) {}
    // Ask the browser again rather than trusting what request() returned: the user can dismiss the
    // prompt, and on some builds the answer arrives before the grant is recorded.
    await refresh(asked);
};

refresh(false);
