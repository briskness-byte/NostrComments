// The toolbar popup, which is the only thing that still works when the extension has no host
// permissions — and therefore the only thing that can ask for them.
//
// Manifest V3 makes host permissions revocable, and Firefox lists them as optional, so "installed
// and granted nothing" is a state real users reach: by declining the install prompt, by turning it
// off later, or by installing a build by hand. In that state the content script never runs, so the
// extension draws nothing at all. Not broken — invisible, which is worse, because there is nothing
// to click and no explanation.
//
// The popup's whole job is one decision, so that decision is a pure function and is tested here
// rather than in a browser. Driving a real popup means resolving an extension's internal UUID,
// which is random per Firefox profile; the parts that would need a browser are the two lines that
// call the permissions API, and those are exercised by hand.
import fs from 'fs';

const FILES = {
    chrome:  new URL('../NostrComments-Chrome/popup.js', import.meta.url),
    firefox: new URL('../NostrComments-FireFox/popup.js', import.meta.url),
};

// Same trick the other suites use: take the real shipped source, not a copy that can drift.
function loadView(src) {
    const start = src.indexOf('function view(');
    if (start < 0) return null;
    const end = src.indexOf('\nfunction paint(', start);
    if (end < 0) return null;
    return (0, eval)(`(${src.slice(start, end)})`);
}

export async function run() {
    let p = 0, f = 0;
    const ok = (n, c, extra) => {
        c ? p++ : f++;
        if (!c) console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
    };

    // A file that is not there is a finding, not a crash. This suite is what stands between a
    // missing popup and a released build, so it has to say which file and which build.
    const read = u => { try { return fs.readFileSync(u, 'utf8'); } catch (e) { return null; } };
    const srcs = Object.fromEntries(Object.entries(FILES).map(([k, u]) => [k, read(u)]));
    for (const [k, v] of Object.entries(srcs)) ok(`the ${k} build has popup.js`, v !== null);
    if (Object.values(srcs).some(v => v === null)) return { name: 'permission popup', pass: p, fail: f };

    // The popup is not browser-specific: it picks the API object at runtime, so the two builds ship
    // the same file. If they ever diverge, one of them stops getting fixes.
    ok('the popup is identical in both extension builds', srcs.chrome === srcs.firefox);
    ok('it picks the API object at runtime rather than hard-coding one',
       srcs.chrome.includes("typeof browser !== 'undefined' ? browser : chrome"));

    const view = loadView(srcs.chrome);
    ok('view() can be read out of the shipped file', typeof view === 'function');
    if (typeof view !== 'function') return { name: 'permission popup', pass: p, fail: f };

    // --- nothing granted: the state where the extension is otherwise silent -----------------------
    const none = view(false, false);
    ok('with no access it offers the button', none.grant === true, none);
    ok('and says why nothing is showing up', /cannot see any page/i.test(none.status), none.status);
    ok('it says what the access is for', /which comments belong/i.test(none.hint), none.hint);
    // Somebody unwilling to grant everything should not leave thinking that is the only option.
    ok('and names the narrower option', /single sites/i.test(none.hint), none.hint);

    // --- granted -----------------------------------------------------------------------------------
    const yes = view(true, false);
    ok('once granted the button is gone', yes.grant === false, yes);
    ok('and it confirms the extension is live', /active/i.test(yes.status), yes.status);
    ok('with no leftover instruction', yes.hint === '', yes.hint);

    // --- granted just now ---------------------------------------------------------------------------
    // A grant does not reach pages that are already open; the content script arrives on the next
    // load. Without this line the user clicks Allow, looks at the page behind the popup, sees no
    // change, and concludes it did not work.
    const fresh = view(true, true);
    ok('granting just now asks for a reload', /reload/i.test(fresh.hint), fresh.hint);
    ok('and still hides the button', fresh.grant === false, fresh);
    ok('the reload line is only for the moment it happened', view(true, false).hint !== fresh.hint);

    // --- the wiring the popup depends on -------------------------------------------------------------
    for (const [name, dir] of [['chrome', 'NostrComments-Chrome'], ['firefox', 'NostrComments-FireFox']]) {
        const mf = JSON.parse(fs.readFileSync(new URL(`../${dir}/manifest.json`, import.meta.url), 'utf8'));
        ok(`${name} declares a toolbar action`, !!mf.action, mf.action);
        ok(`${name} points it at the popup`, mf.action?.default_popup === 'popup.html', mf.action?.default_popup);
        ok(`${name} still asks for the hosts up front`, (mf.host_permissions || []).includes('<all_urls>'));
        // An action needs no host permission — that is the entire reason this exists.
        ok(`${name} adds no new permission for it`, JSON.stringify(mf.permissions) === JSON.stringify(['storage']), mf.permissions);
        const html = read(new URL(`../${dir}/popup.html`, import.meta.url));
        ok(`${name} build has popup.html`, html !== null);
        if (html === null) continue;
        ok(`${name} popup loads its script from a file`, html.includes('<script src="popup.js">'));
        // Extension pages forbid inline script; a popup that tried would silently do nothing.
        ok(`${name} popup has no inline script`, !/<script>(?!\s*<\/script>)/.test(html));
    }

    // The build packs a fixed list of files, and a file that is not on it does not ship. That has
    // gone wrong before, with a whole feature missing from a released .xpi.
    const build = fs.readFileSync(new URL('../build.sh', import.meta.url), 'utf8');
    ok('the build packs the popup markup', /PACKED=.*popup\.html/.test(build));
    ok('the build packs the popup script', /PACKED=.*popup\.js/.test(build));

    return { name: 'permission popup', pass: p, fail: f };
}
