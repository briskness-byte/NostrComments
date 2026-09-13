// The relay layer, moved out of the page.
//
// Firefox applies the *page's* CSP to WebSockets opened from a content script. A site with a
// strict connect-src therefore gets no relay traffic at all, and the panel sits there empty with
// nothing to say about why. x.com is the well-known case; any site can do it, on purpose or by
// accident, and more of them do every year. Nothing inside the page can fix that — the socket has
// to be opened somewhere the page has no say over, and this is that place. The extension's own
// CSP applies here, not the site's.
//
// The second thing it buys was the original reason this was on the backlog: today every tab opens
// its own sockets to every relay, so ten tabs is dozens of connections and the page address goes
// out dozens of times. Here there is one real socket per relay for the whole browser.
//
// THIS FILE IS A PIPE, NOT A PROTOCOL PARTICIPANT. It carries frames verbatim and does not read
// them, beyond the subscription id it needs in order to know who a frame belongs to. That is
// deliberate, and it is what makes the rest work:
//
//   - NIP-42 needs no special handling. An AUTH challenge arrives as a frame, the content script
//     signs it exactly as it does today, and ["AUTH", signed] goes back as a frame. Signing stays
//     where window.nostr is, and this file never sees a key.
//   - The content script's relay logic — backoff, relay state, the refetch, the auth dance — runs
//     unchanged whichever transport is underneath, so the two paths are genuinely comparable.
//   - Anything added to the protocol later works here without a change.
//
// What this file does decide, because a pipe shared between tabs has to:
//
//   - Every socket the content script asks for gets its own handle. One tab opens several sockets
//     to the same relay — the thread, the notifications and the relay health check have three
//     different lifetimes — so keying by relay URL alone would let the second silently replace the
//     first. Measured, not guessed: it did, and the subscription that went quiet was the thread.
//   - Subscription ids are rewritten on the way out and back, so two tabs that pick the same id do
//     not collide, and so one tab can never be handed another tab's events. On a shared socket
//     that would be a list of the pages the other tab is on.
//   - Real sockets are reference-counted with a grace period, so an ordinary link click does not
//     close six connections and reopen them a second later.
//   - Consent is checked here as well as in the content script. Two gates, one decision, and
//     neither trusts the other.
//
// Known property, written down rather than hidden: NIP-42 authenticates a *connection*. Handles
// sharing one real socket share its authenticated identity. With one user and one key that is what
// you want anyway; if a NIP-07 signer switches account mid-session the socket keeps the identity it
// authenticated with until it closes. The in-page path has the same edge.

const api = typeof browser !== 'undefined' ? browser : chrome;

const CONSENT_KEY = 'nostrcomments_consent';

// A relay nobody is using is not closed straight away. Navigating within a site tears the port
// down and builds a new one a moment later; without this, every link click would cycle every
// socket.
const GRACE_MS = 30000;

// url -> { ws, ready, queue, handles:Set<handle>, closeTimer }
const pool = new Map();
// handle key -> { port, sid, url }
const handles = new Map();

let portSeq = 0, subSeq = 0;

// Consent is read here as well as in the content script, on purpose. A content script that has
// been tampered with cannot talk this into opening a socket the user never agreed to.
//
// The read is asynchronous and the gate has to wait for it. An MV3 worker is started *by* the first
// port message after an idle shutdown, so without the wait that first message is answered from the
// initial `false` — a user who consented long ago gets a denial, the socket is torn down, and the
// panel reconnects a beat later for no reason. Every message awaits this, and awaiting an already
// settled promise keeps them in arrival order.
let consent = false;
const consentReady = api.storage.local.get(CONSENT_KEY).then(st => { consent = st[CONSENT_KEY] === true; }, () => {});
api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(CONSENT_KEY in changes)) return;
    consent = changes[CONSENT_KEY].newValue === true;
    // Withdrawing consent has to stop traffic that is already flowing, not merely refuse new
    // traffic. Otherwise a subscription opened before the change outlives the decision.
    if (!consent) dropEverything();
});

const hkey = (port, sid) => port._ncId + ':' + sid;

// ---------------------------------------------------------------------------------------------
// real sockets
// ---------------------------------------------------------------------------------------------

function socket(url) {
    let r = pool.get(url);
    // A pooled record whose socket has gone is not a socket. The relay closing the connection —
    // a restart, a laptop waking, an idle timeout — leaves the record in place while handles are
    // still attached, and the content script's reconnect then asks for this relay again. Returning
    // the dead record handed it something that would never open: retries fired on schedule, no
    // connection was ever made, and comments and notifications stopped for the life of the page
    // with nothing on screen to say so. Dial again instead.
    if (r && !r.ws && !r.ready) { dial(url, r); return r; }
    if (r) return r;
    r = { ws: null, ready: false, queue: [], handles: new Set(), closeTimer: null };
    pool.set(url, r);
    dial(url, r);
    return r;
}

function dial(url, r) {
    try { r.ws = new WebSocket(url); }
    catch (e) {
        // Nothing is listening yet — the handle that asked for this socket is registered by the
        // caller, after this returns. So record the failure and let the caller report it, and take
        // the dead record out of the pool so the next attempt dials again instead of inheriting it.
        r.failed = true;
        pool.delete(url);
        return;
    }

    r.ws.onopen = () => {
        r.ready = true;
        for (const frame of r.queue.splice(0)) raw(r, frame);
        each(r, h => post(h.port, { t: 'open', sid: h.sid }));
    };
    r.ws.onmessage = m => {
        let frame;
        try { frame = JSON.parse(m.data); } catch (e) { return; }
        deliver(r, frame);
    };
    r.ws.onerror = () => { each(r, h => post(h.port, { t: 'error', sid: h.sid })); };
    r.ws.onclose = () => {
        r.ready = false; r.ws = null;
        each(r, h => post(h.port, { t: 'closed', sid: h.sid }));
        // Reconnecting is the content script's job — it already has the backoff, and it is the only
        // side that knows whether the page it was for is still the page on screen.
        if (!r.handles.size) pool.delete(url);
    };
}

function each(r, fn) {
    for (const k of r.handles) { const h = handles.get(k); if (h) fn(h); }
}

// A socket that never opens must not accumulate frames for the life of the worker. The queue exists
// to cover the moment between dialling and onopen, which is a handful of frames; anything past that
// is a relay that is not answering, and the content script's own backoff is what handles that.
const QUEUE_MAX = 200;

function raw(r, frame) {
    if (r.ready && r.ws) { try { r.ws.send(JSON.stringify(frame)); } catch (e) {} }
    else if (r.queue.length < QUEUE_MAX) r.queue.push(frame);
}

// Who gets a frame. Subscription traffic goes to the one handle that asked for it; a publish answer
// to the one waiting on that event id; anything else to every handle on this socket, because it is
// about the connection rather than about a page.
function deliver(r, frame) {
    const kind = frame[0];

    if (kind === 'EVENT' || kind === 'EOSE' || kind === 'CLOSED') {
        const owner = subOwner.get(frame[1]);
        if (!owner || !r.handles.has(hkey(owner.port, owner.sid))) return;
        const out = frame.slice();
        out[1] = owner.theirs;                       // hand back the id the content script chose
        return post(owner.port, { t: 'frame', sid: owner.sid, frame: out });
    }

    if (kind === 'OK') {
        const o = pubOwner.get(frame[1]);
        if (o && r.handles.has(hkey(o.port, o.sid))) post(o.port, { t: 'frame', sid: o.sid, frame });
        // No owner means whoever published it has gone. Falling through to the broadcast below would
        // hand every other tab on this socket an event id somebody else published, plus whatever the
        // relay said about it. An answer addressed to nobody is dropped.
        return;
    }

    each(r, h => post(h.port, { t: 'frame', sid: h.sid, frame }));
}

// ---------------------------------------------------------------------------------------------
// subscription ids
// ---------------------------------------------------------------------------------------------
//
// Two tabs on the same site pick their subscription ids the same way, so on a shared socket they
// would collide — and worse, each would receive the other's events, which is a list of the pages
// that tab is on. Every outgoing id is therefore replaced with one minted here.

const subOwner = new Map();     // wire id -> { port, sid, theirs }
const subMine  = new Map();     // handle key + ' ' + their id -> wire id
const pubOwner = new Map();     // event id -> { port, sid }

// A publish is remembered until its OK arrives or the handle is released. A relay that simply never
// answers leaves the entry behind, so the map is bounded and the oldest goes first — Map iteration
// is insertion-ordered. Losing the oldest entry costs one OK notice, not a comment.
const PUB_MAX = 500;

function mint(port, sid, theirs) {
    const k = hkey(port, sid) + ' ' + theirs;
    let wire = subMine.get(k);
    if (!wire) { wire = 'nc' + (++subSeq).toString(36); subMine.set(k, wire); }
    subOwner.set(wire, { port, sid, theirs });
    return wire;
}

function forget(port, sid, theirs) {
    const k = hkey(port, sid) + ' ' + theirs;
    const wire = subMine.get(k);
    if (!wire) return null;
    subMine.delete(k);
    subOwner.delete(wire);
    return wire;
}

// The content script's frame, with anything that names a subscription translated on the way out.
function translate(port, sid, frame) {
    const kind = frame[0];
    if (kind === 'REQ' && typeof frame[1] === 'string') {
        const out = frame.slice();
        out[1] = mint(port, sid, frame[1]);
        return out;
    }
    if (kind === 'CLOSE' && typeof frame[1] === 'string') {
        const wire = forget(port, sid, frame[1]);
        return wire ? ['CLOSE', wire] : null;
    }
    if (kind === 'EVENT' && frame[1] && typeof frame[1].id === 'string') {
        if (pubOwner.size >= PUB_MAX) pubOwner.delete(pubOwner.keys().next().value);
        pubOwner.set(frame[1].id, { port, sid });
    }
    return frame;
}

// ---------------------------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------------------------

api.runtime.onConnect.addListener(port => {
    if (port.name !== 'nc-relay') return;
    // Who is allowed to hold this pipe. A web page cannot reach runtime.onConnect at all — another
    // extension arrives at onConnectExternal, which has no listener here — so this is a second wall
    // rather than the only one. It is here because the flaw this project just fixed in another
    // signer was precisely a handler that never asked who was calling.
    if (!port.sender || (port.sender.id && port.sender.id !== api.runtime.id)) return port.disconnect();
    port._ncId = ++portSeq;

    port.onMessage.addListener(async msg => {
        if (!msg || typeof msg.t !== 'string') return;
        if (msg.t === 'ping') return post(port, { t: 'pong' });
        await consentReady;
        // Every request that would touch a relay passes the gate, not only the first one.
        if (!consent) return post(port, { t: 'denied', sid: msg.sid });
        if (typeof msg.sid !== 'number') return;

        if (msg.t === 'open') {
            // wss only. The panel refuses to add anything else, and this is the side that is not
            // bound by the page's CSP, so it must not be the looser of the two. A rejection is
            // reported rather than dropped, so a bad address shows up as a relay that failed
            // instead of one that hangs.
            if (typeof msg.relay !== 'string' || !/^wss:\/\//i.test(msg.relay))
                return post(port, { t: 'error', sid: msg.sid });
            const k = hkey(port, msg.sid);
            if (handles.has(k)) return;
            handles.set(k, { port, sid: msg.sid, url: msg.relay });
            const r = socket(msg.relay);
            r.handles.add(k);
            cancelClose(r);
            if (r.failed) return post(port, { t: 'error', sid: msg.sid });
            if (r.ready) post(port, { t: 'open', sid: msg.sid });
            return;
        }
        if (msg.t === 'send') {
            const h = handles.get(hkey(port, msg.sid));
            if (!h || !Array.isArray(msg.frame)) return;
            const r = pool.get(h.url);
            if (!r) return;
            const out = translate(port, msg.sid, msg.frame);
            if (out) raw(r, out);
            return;
        }
        if (msg.t === 'close') return release(port, msg.sid);
    });

    // A closed tab must not leave a relay subscribed on its behalf. Without this the pool grows for
    // the life of the browser, still asking relays about pages nobody is looking at.
    port.onDisconnect.addListener(() => {
        for (const h of [...handles.values()]) if (h.port === port) release(port, h.sid);
    });
});

function release(port, sid) {
    const k = hkey(port, sid);
    const h = handles.get(k);
    if (!h) return;
    handles.delete(k);
    const r = pool.get(h.url);
    for (const [wire, o] of [...subOwner]) {
        if (o.port !== port || o.sid !== sid) continue;
        if (r) raw(r, ['CLOSE', wire]);
        subOwner.delete(wire);
        subMine.delete(k + ' ' + o.theirs);
    }
    for (const [id, o] of [...pubOwner]) if (o.port === port && o.sid === sid) pubOwner.delete(id);
    if (!r) return;
    r.handles.delete(k);
    maybeClose(h.url, r);
}

function cancelClose(r) { if (r.closeTimer) { clearTimeout(r.closeTimer); r.closeTimer = null; } }

function maybeClose(url, r) {
    if (r.handles.size || r.closeTimer) return;
    r.closeTimer = setTimeout(() => {
        const cur = pool.get(url);
        if (!cur || cur !== r) return;
        if (cur.handles.size) { cur.closeTimer = null; return; }
        pool.delete(url);
        try { cur.ws && cur.ws.close(); } catch (e) {}
    }, GRACE_MS);
}

function post(port, frame) { try { port.postMessage(frame); } catch (e) {} }

function dropEverything() {
    for (const h of [...handles.values()]) post(h.port, { t: 'denied', sid: h.sid });
    handles.clear();
    for (const [url, r] of [...pool]) {
        pool.delete(url);
        try { r.ws && r.ws.close(); } catch (e) {}
    }
    subOwner.clear(); subMine.clear(); pubOwner.clear();
}
