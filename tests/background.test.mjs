// The background relay pipe.
//
// The whole point of moving relay traffic there is that a page cannot reach it, which also means a
// browser test driving a page cannot reach it directly. So this suite does what popup.test.mjs
// does: take the real shipped file, lift the decision logic out of it, and exercise that. What
// needs a live socket is tests/browser-worker.mjs, which runs both transports against one relay
// and compares what comes back.
//
// The file under test is deliberately not a protocol participant — it carries frames verbatim.
// What it *does* decide is who a frame belongs to, and that is where the assertions are, because
// getting it wrong means one tab receiving another tab's events. On a shared socket that is a list
// of the pages the other tab is on.
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
    try { return (0, eval)(`(${src.slice(start, i)})`); }
    catch (e) { return null; }
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
    if (Object.values(srcs).some(v => v === null)) return { name: 'background relay pipe', pass: p, fail: f };

    ok('it is identical in both extension builds', srcs.chrome === srcs.firefox);
    ok('it picks the API object at runtime rather than hard-coding one',
       srcs.chrome.includes("typeof browser !== 'undefined' ? browser : chrome"));

    const src = srcs.chrome;

    // --- subscription ids: what keeps two tabs apart -------------------------------------------------
    // mint/forget/translate share three module-level maps and a counter, so they are lifted with a
    // scope that provides them. The maps are the real ones from the file's own declarations.
    const declared = src.slice(src.indexOf('function mint('), src.indexOf('// ------', src.indexOf('function translate(')));
    let mint = null, forget = null, translate = null, maps = null;
    try {
        const built = (0, eval)(`(() => {
            const subOwner = new Map(), subMine = new Map(), pubOwner = new Map();
            let subSeq = 0;
            const hkey = (port, sid) => port._ncId + ':' + sid;
            ${declared}
            return { mint, forget, translate, subOwner, subMine, pubOwner };
        })()`);
        ({ mint, forget, translate } = built);
        maps = built;
    } catch (e) { /* reported by the assertion below */ }

    ok('mint/forget/translate can be read out of the shipped file',
       typeof mint === 'function' && typeof forget === 'function' && typeof translate === 'function');

    if (typeof translate === 'function') {
        const A = { _ncId: 1 }, B = { _ncId: 2 };
        const S = 7;   // one socket handle; a tab has several

        // Two tabs on the same site pick their subscription ids the same way. If those reached the
        // relay unchanged they would collide on a shared socket, and each tab would be handed the
        // other's events.
        const a = translate(A, S, ['REQ', 'nc1', { kinds: [1] }]);
        const b = translate(B, S, ['REQ', 'nc1', { kinds: [1] }]);
        ok('two tabs asking under the same id get different wire ids', a[1] !== b[1], [a[1], b[1]]);
        ok('the filter is passed through untouched', JSON.stringify(a[2]) === JSON.stringify({ kinds: [1] }));
        ok('the frame verb is left alone', a[0] === 'REQ');

        // Asking again under the same id must not mint a second one, or the CLOSE that follows
        // would only ever cancel the newest and leave the rest running on the relay forever.
        const again = translate(A, S, ['REQ', 'nc1', { kinds: [7] }]);
        ok('the same tab and id keeps one wire id', again[1] === a[1], [a[1], again[1]]);

        // An event arriving for a wire id must go back carrying the id its owner chose, or the
        // content script will not recognise its own subscription.
        const owner = maps.subOwner.get(a[1]);
        ok('the wire id is owned by the tab that asked', owner && owner.port === A);
        ok('and remembers what that tab called it', owner && owner.theirs === 'nc1');
        ok('and which socket handle it belongs to', owner && owner.sid === S);

        // Closing translates back and forgets, so a later frame for that id has nowhere to go.
        const closed = translate(A, S, ['CLOSE', 'nc1']);
        ok('CLOSE is translated to the wire id', closed && closed[1] === a[1], closed);
        ok('and the mapping is dropped', !maps.subOwner.has(a[1]));
        // Closing something that was never opened must not invent a frame to send to a relay.
        ok('closing an unknown subscription sends nothing', translate(A, S, ['CLOSE', 'nope']) === null);

        // A publish is remembered by event id so the relay's OK reaches the tab that is waiting on
        // it rather than every tab on that socket.
        translate(B, S, ['EVENT', { id: 'abc123', kind: 1 }]);
        ok('a published event is owned by the tab that sent it', maps.pubOwner.get('abc123')?.port === B);
        // The event itself must not be rewritten on the way out: the id is signed over, so any
        // change to it invalidates the signature.
        const ev = { id: 'deadbeef', kind: 1, content: 'x' };
        const outEv = translate(A, S, ['EVENT', ev]);
        ok('the signed event is passed through unchanged', outEv[1] === ev && JSON.stringify(outEv[1]) === JSON.stringify(ev));

        // Anything the pipe does not recognise goes out as it came in. That is what lets NIP-42,
        // and anything added to the protocol later, work here without a change to this file.
        const auth = translate(A, S, ['AUTH', { id: 'sig', kind: 22242 }]);
        ok('an unrecognised frame is passed through verbatim', auth[0] === 'AUTH' && auth[1].kind === 22242);
        const count = translate(A, S, ['COUNT', 'x1', {}]);
        ok('and so is a verb this file has never heard of', count[0] === 'COUNT' && count[1] === 'x1');
    }

    // --- routing --------------------------------------------------------------------------------------
    // deliver() decides who receives an incoming frame. Reading it as source rather than running it
    // (it closes over the socket pool) — these are the two rules that matter.
    const deliver = src.slice(src.indexOf('function deliver('), src.indexOf('// ---', src.indexOf('function deliver(')));
    ok('subscription traffic is routed to its owner',
       /EVENT[\s\S]{0,120}subOwner\.get/.test(deliver), deliver.slice(0, 80));
    // Handing a frame to a handle that has since been released would be handing it to whichever
    // socket reused that number.
    ok('and only if that handle is still on this socket', /!r\.handles\.has\(hkey\(owner\.port, owner\.sid\)\)/.test(deliver));
    // Routing by relay URL alone was the phase-2 bug: one tab opens several sockets to the same
    // relay, so the second silently replaced the first and the thread went quiet. Frames are
    // addressed to a handle, and this is what stops that coming back.
    ok('a frame is addressed to a socket handle, not a relay', /sid: owner\.sid/.test(deliver));
    ok('the id is translated back before it goes out', /out\[1\] = owner\.theirs/.test(deliver));
    ok('a publish answer goes to the tab waiting on that event', /OK[\s\S]{0,120}pubOwner\.get/.test(deliver));

    // --- the consent gate -------------------------------------------------------------------------------
    // The content script asks nothing before consent. This checks again, from storage, so a content
    // script that has been tampered with cannot talk this into opening a socket.
    const handler = src.slice(src.indexOf('port.onMessage.addListener'), src.indexOf('port.onDisconnect.addListener'));
    ok('the message handler was found', handler.length > 0);
    // Gating only the first message would leave every later frame ungated, so the check has to sit
    // above the dispatch rather than inside any one branch.
    const gate = handler.indexOf('if (!consent)');
    ok('consent is checked in the handler', gate >= 0);
    for (const verb of ['open', 'send', 'close']) {
        ok(`the gate is above '${verb}'`, gate >= 0 && gate < handler.indexOf(`msg.t === '${verb}'`));
    }
    // A relay address arrives from the content script and goes straight into a WebSocket, so it is
    // checked here too rather than trusted.
    ok('only ws:// and wss:// are dialled', /\^wss\?:\\\/\\\//.test(handler));
    // A port may only send on a handle it owns; otherwise one tab could push frames onto another
    // tab's socket. hkey() namespaces the handle by port, so a guessed number is not enough.
    ok('a tab can only send on a handle it owns', /const h = handles\.get\(hkey\(port, msg\.sid\)\);/.test(handler));
    ok('and an unknown handle sends nothing', /if \(!h \|\| !Array\.isArray\(msg\.frame\)\) return;/.test(handler));
    // Opening the same handle twice would leave the first registration unreachable and its socket
    // never released.
    ok('a handle cannot be opened twice', /if \(handles\.has\(k\)\) return;/.test(handler));
    ok('withdrawing consent tears down what is already open', /if \(!consent\) dropEverything/.test(src));

    const disconnect = src.slice(src.indexOf('port.onDisconnect.addListener'), src.indexOf('function release('));
    ok('a closed tab releases every handle it held', /release\(port, h\.sid\)/.test(disconnect));
    const release = src.slice(src.indexOf('function release('), src.indexOf('function cancelClose('));
    ok('releasing closes the subscription on the relay', /raw\(r, \['CLOSE', wire\]\)/.test(release));
    ok('and leaves no subscription mappings behind', /subOwner\.delete/.test(release) && /subMine\.delete/.test(release));
    ok('and no publish mappings either', /pubOwner\.delete/.test(release));
    ok('and lets the socket go once nothing holds it', /maybeClose\(h\.url, r\)/.test(release));

    // --- what stays in the page, and must not appear here --------------------------------------------------
    // Signing needs window.nostr, which only exists in the page. If a key ever turns up in this
    // file the whole argument for the split has gone.
    //
    // Comments are stripped first, and that is not a loophole: the header of the file under test
    // explains the split, so it names the very things the split forbids. What must stay clean is
    // the code.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    ok('stripping comments left the code behind', code.includes('api.runtime.onConnect'));
    for (const forbidden of ['nostrcomments_privkey', 'window.nostr', 'getPublicKey', 'signEvent', 'nsec']) {
        ok(`no sign of the key path: ${forbidden}`, !code.includes(forbidden));
    }
    // A pipe that inspected event contents would be a pipe with opinions, and the next person to
    // add one would not know they were not supposed to.
    ok('it does not read event contents', !/\.content/.test(code));

    // --- wiring -----------------------------------------------------------------------------------------------
    const mfs = {
        chrome:  JSON.parse(fs.readFileSync(new URL('../NostrComments-Chrome/manifest.json', import.meta.url), 'utf8')),
        firefox: JSON.parse(fs.readFileSync(new URL('../NostrComments-FireFox/manifest.json', import.meta.url), 'utf8')),
    };
    ok('chrome registers it as an MV3 service worker', mfs.chrome.background?.service_worker === 'background.js', mfs.chrome.background);
    // Firefox MV3 takes a scripts array; service_worker is not the portable spelling there.
    ok('firefox registers it as an event page', mfs.firefox.background?.scripts?.[0] === 'background.js', mfs.firefox.background);
    // A background page needs no new permission. If one appears it belongs in a store listing
    // explanation before it belongs in a manifest — this account has had two rejections already.
    for (const [name, mf] of Object.entries(mfs))
        ok(`${name} still asks for nothing but storage`, JSON.stringify(mf.permissions) === JSON.stringify(['storage']), mf.permissions);

    const build = fs.readFileSync(new URL('../build.sh', import.meta.url), 'utf8');
    ok('the build packs it', /PACKED=.*background\.js/.test(build));

    // The test harness builds its own .xpi, and it used to carry its own copy of that list. The two
    // drifted the moment background.js was added: Firefox got an archive whose manifest announced a
    // background script that was not inside it, the background never ran, and every port the content
    // script opened disconnected immediately with no error. That reads as a broken feature, not as a
    // missing file, and it cost a round of debugging before the archive was looked at.
    //
    // The harness now derives the list. This is what says so, because a derivation that quietly
    // stops deriving looks identical from the outside.
    const harness = fs.readFileSync(new URL('./harness.mjs', import.meta.url), 'utf8');
    ok('the harness reads the packing list from build.sh', /PACKED="\(\[\^"\]\+\)"/.test(harness));
    ok('and does not keep a second copy of it',
       !/execFileSync\('zip', \['-qrX', xpi, '/.test(harness), 'a literal file list is back in packXpi');
    ok('and refuses to build an archive missing a packed file', /is in neither/.test(harness));

    // --- one name, three builds -----------------------------------------------------------------------------------
    // Every caller goes through ncSocket(), including in the userscript, which has no background
    // context and defines it as a plain WebSocket. That is what keeps the protocol logic above the
    // transport byte-identical in all three builds while the transport itself differs — which is
    // exactly the property the parity guard exists to protect.
    const builds = {
        chrome:     read(new URL('../NostrComments-Chrome/content.js', import.meta.url)),
        firefox:    read(new URL('../NostrComments-FireFox/content.js', import.meta.url)),
        userscript: read(new URL('../NostrComments-Userscript/NostrComments.js', import.meta.url)),
    };
    for (const [name, cs] of Object.entries(builds)) {
        ok(`${name} was found`, cs !== null);
        if (cs === null) continue;
        ok(`${name} opens sockets through ncSocket`, cs.includes('ncSocket(r)'));
        // A stray direct construction is a caller the flag cannot reach, and it would be the one
        // that keeps failing on a strict-CSP site after the rest was fixed.
        // Exactly one, and it is the ncSocket definition itself. A second would be a caller the
        // flag cannot reach — the one that keeps failing on a strict-CSP site after the rest is fixed.
        const stray = (cs.match(/new WebSocket\(/g) || []).length;
        ok(`${name} has exactly one direct construction, in ncSocket`, stray === 1, stray);
    }
    ok('the userscript keeps its sockets in the page', /const ncSocket = url => new WebSocket\(url\);/.test(builds.userscript));
    ok('and never tries to open a port', !builds.userscript.includes("runtime.connect({name: 'nc-relay'})"));

    // --- default off -------------------------------------------------------------------------------------------------
    // Phase 2 still ships dark. Every user is on the in-page path, and a build where that flipped
    // by accident is a build where an untested transport went to the stores.
    for (const name of ['chrome', 'firefox']) {
        const cs = builds[name];
        ok(`${name} reads the flag from storage`, cs.includes('_st.nostrcomments_worker === true'));
        ok(`${name} defaults it to off`, !/nostrcomments_worker\s*:\s*true/.test(cs));
        ok(`${name} picks the transport from the flag`,
           /const ncSocket = url => useWorker \? _workerSocket\(url\) : new WebSocket\(url\);/.test(cs));
    }

    return { name: 'background relay pipe', pass: p, fail: f };
}
