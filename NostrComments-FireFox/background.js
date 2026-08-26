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
// its own socket to every relay, so ten tabs is sixty connections and the page address goes out
// sixty times. Here there is one socket per relay for the whole browser, shared by every tab, and
// "connect" stops being a per-page cost at all.
//
// PHASE 1: this file ships but nothing uses it yet. content.js only opens a port when
// `nostrcomments_worker` is true in extension storage, and that defaults to false. The existing
// in-page socket code is untouched and is still what every user runs.
//
// What deliberately did NOT move here:
//   - Signing. NIP-07 needs `window.nostr`, which only exists in the page. The content script
//     signs and hands over a finished event; this file never sees a key.
//   - Drawing. Same reason the panel is where it is.
//   - Policy. Per-site disable is a decision the content script can see and this file cannot, so
//     it stays there. A background that guessed at policy would be a background that gets it
//     wrong on the page it cannot look at.
//
// The pure helpers at the bottom are separated out so tests/background.test.mjs can exercise the
// refcounting and the consent gate without a browser.

const api = typeof browser !== 'undefined' ? browser : chrome;

const CONSENT_KEY = 'nostrcomments_consent';

// A relay with no subscribers left is not closed straight away. Navigating within a site tears the
// port down and builds a new one a moment later, and without this every link click would close
// six sockets and reopen them.
const GRACE_MS = 30000;

// How long to wait for a relay to answer OK on a publish before calling it a timeout. Matches the
// figure the in-page path has used since the beginning, so the two are comparable in phase 2.
const PUBLISH_TIMEOUT_MS = 8000;

// url -> { ws, ready, subs:Set<subKey>, pubs:Set<eventId>, closeTimer }
const pool = new Map();
// subKey -> { port, filter, relays:string[] }
const subs = new Map();

let portSeq = 0;

// Consent is read here as well as in the content script, on purpose. The content script asks
// nothing before consent, and this checks again from storage — so a content script that has been
// tampered with cannot talk a relay into anything the user never agreed to. Two gates, one
// decision, and neither trusts the other.
let consent = false;
api.storage.local.get(CONSENT_KEY).then(st => { consent = st[CONSENT_KEY] === true; }, () => {});
api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(CONSENT_KEY in changes)) return;
    consent = changes[CONSENT_KEY].newValue === true;
    // Consent withdrawn mid-session must actually stop traffic, not just stop new traffic.
    if (!consent) dropEverything('consent withdrawn');
});

// ---------------------------------------------------------------------------------------------
// the socket pool
// ---------------------------------------------------------------------------------------------

function relay(url) {
    let r = pool.get(url);
    if (r) return r;
    r = { ws: null, ready: false, subs: new Set(), pubs: new Set(), closeTimer: null, queue: [] };
    pool.set(url, r);
    openSocket(url, r);
    return r;
}

function openSocket(url, r) {
    try { r.ws = new WebSocket(url); }
    catch (e) { fanout(url, { t: 'relayerror', relay: url, reason: 'could not connect' }); return; }

    r.ws.onopen = () => {
        r.ready = true;
        for (const frame of r.queue.splice(0)) send(r, frame);
        // A socket that opened after its subscribers arrived still owes them their REQ.
        for (const key of r.subs) {
            const s = subs.get(key);
            if (s) send(r, ['REQ', wireId(key), s.filter]);
        }
    };
    r.ws.onmessage = m => {
        let d;
        try { d = JSON.parse(m.data); } catch (e) { return; }
        route(url, d);
    };
    r.ws.onerror = () => { fanout(url, { t: 'relayerror', relay: url, reason: 'unreachable' }); };
    r.ws.onclose = () => {
        r.ready = false;
        r.ws = null;
        fanout(url, { t: 'relayclosed', relay: url });
        // Anyone still subscribed wants the socket back. Nobody left means it closed because we
        // asked it to, and reopening would defeat the point.
        if (r.subs.size) setTimeout(() => { if (pool.get(url) === r && r.subs.size && !r.ws) openSocket(url, r); }, 3000);
        else pool.delete(url);
    };
}

function send(r, frame) {
    if (r.ready && r.ws) { try { r.ws.send(JSON.stringify(frame)); } catch (e) {} }
    else r.queue.push(frame);
}

// A relay message carries the wire subscription id, which encodes which port asked. Publish
// answers (OK) carry an event id instead, so those go to whoever is waiting on that event.
function route(url, d) {
    const kind = d[0];
    if (kind === 'EVENT' || kind === 'EOSE' || kind === 'CLOSED') {
        const key = keyFromWire(d[1]);
        const s = subs.get(key);
        if (!s) return;
        if (kind === 'EVENT') post(s.port, { t: 'event', id: s.id, relay: url, event: d[2] });
        else if (kind === 'EOSE') post(s.port, { t: 'eose', id: s.id, relay: url });
        else post(s.port, { t: 'subclosed', id: s.id, relay: url, reason: d[2] || '' });
        return;
    }
    if (kind === 'OK' || kind === 'NOTICE' || kind === 'AUTH') fanout(url, { t: kind.toLowerCase(), relay: url, data: d });
}

// ---------------------------------------------------------------------------------------------
// subscriptions
// ---------------------------------------------------------------------------------------------

function addSub(port, msg) {
    const key = subKey(port._ncId, msg.id);
    removeSub(key);                                   // resubscribing under the same id supersedes
    const relays = dedupe(msg.relays || []);
    subs.set(key, { port, id: msg.id, filter: msg.filter || {}, relays });
    for (const url of relays) {
        const r = relay(url);
        r.subs.add(key);
        cancelClose(r);
        send(r, ['REQ', wireId(key), msg.filter || {}]);
    }
}

function removeSub(key) {
    const s = subs.get(key);
    if (!s) return;
    subs.delete(key);
    for (const url of s.relays) {
        const r = pool.get(url);
        if (!r) continue;
        r.subs.delete(key);
        send(r, ['CLOSE', wireId(key)]);
        maybeClose(url, r);
    }
}

function cancelClose(r) {
    if (r.closeTimer) { clearTimeout(r.closeTimer); r.closeTimer = null; }
}

// Idle means no subscriptions and no publish waiting on an answer. The grace period is what stops
// an ordinary link click from cycling every socket.
function maybeClose(url, r) {
    if (!isIdle(r) || r.closeTimer) return;
    r.closeTimer = setTimeout(() => {
        const cur = pool.get(url);
        if (!cur || cur !== r) return;
        if (!isIdle(cur)) { cur.closeTimer = null; return; }
        pool.delete(url);
        try { cur.ws && cur.ws.close(); } catch (e) {}
    }, GRACE_MS);
}

// ---------------------------------------------------------------------------------------------
// publishing
// ---------------------------------------------------------------------------------------------

// The event arrives already signed. This waits for each relay's OK and reports every answer back,
// rather than resolving on the first acceptance — how many relays hold a comment is the difference
// between it surviving somebody's spring clean and not, and the caller wants to be able to say so.
//
// NIP-42 is not handled here yet, on purpose. Answering an auth challenge means signing, signing
// needs the page, and a round trip back through the content script mid-publish is a design
// decision rather than a detail. Until phase 2 settles it, an auth-required refusal is reported
// as what it is instead of being silently swallowed.
function publish(port, msg) {
    const ev = msg.event;
    if (!ev || typeof ev.id !== 'string') return post(port, { t: 'pubdone', id: msg.id, results: [] });
    const targets = dedupe(msg.relays || []);
    const results = [];
    let left = targets.length;
    if (!left) return post(port, { t: 'pubdone', id: msg.id, results: [] });

    for (const url of targets) {
        const r = relay(url);
        r.pubs.add(ev.id);
        cancelClose(r);

        let settled = false;
        const settle = (ok, reason) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            r.pubs.delete(ev.id);
            off();
            results.push({ relay: url, ok, reason });
            post(port, { t: 'ok', id: msg.id, relay: url, ok, reason });
            maybeClose(url, r);
            if (--left === 0) post(port, { t: 'pubdone', id: msg.id, results });
        };

        const listener = frame => {
            if (frame.t === 'relayclosed') return settle(false, 'closed without answering');
            if (frame.t === 'relayerror') return settle(false, frame.reason || 'unreachable');
            if (frame.t !== 'ok') return;
            const d = frame.data;
            if (d[1] !== ev.id) return;                      // OK is per event id
            settle(d[2] === true, d[3] || (d[2] === true ? '' : 'refused without a reason'));
        };
        const off = () => watchers.get(url)?.delete(listener);
        watch(url, listener);

        const timer = setTimeout(() => settle(false, 'timed out'), PUBLISH_TIMEOUT_MS);
        send(r, ['EVENT', ev]);
    }
}

// Relay-wide messages (OK, NOTICE, AUTH, and the socket's own life events) have no subscription id
// to route by, so anything interested registers here.
const watchers = new Map();
function watch(url, fn) {
    if (!watchers.has(url)) watchers.set(url, new Set());
    watchers.get(url).add(fn);
}
function fanout(url, frame) {
    const set = watchers.get(url);
    if (set) for (const fn of [...set]) { try { fn(frame); } catch (e) {} }
}

// ---------------------------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------------------------

api.runtime.onConnect.addListener(port => {
    if (port.name !== 'nc-relay') return;
    port._ncId = ++portSeq;

    port.onMessage.addListener(msg => {
        if (!msg || typeof msg.t !== 'string') return;
        if (msg.t === 'ping') return post(port, { t: 'pong' });
        // Every request that would touch a relay passes the gate, not just the first one.
        if (!consent) return post(port, { t: 'denied', id: msg.id, reason: 'no consent' });
        if (msg.t === 'sub') return addSub(port, msg);
        if (msg.t === 'unsub') return removeSub(subKey(port._ncId, msg.id));
        if (msg.t === 'pub') return publish(port, msg);
    });

    // A closed tab must not leave a relay subscribed on its behalf. Without this the pool would
    // grow for the life of the browser and keep asking relays for pages nobody is looking at.
    port.onDisconnect.addListener(() => {
        for (const key of [...subs.keys()]) if (subs.get(key).port === port) removeSub(key);
    });
});

function post(port, frame) { try { port.postMessage(frame); } catch (e) {} }

function dropEverything(why) {
    for (const key of [...subs.keys()]) {
        const s = subs.get(key);
        post(s.port, { t: 'denied', id: s.id, reason: why });
        removeSub(key);
    }
    for (const [url, r] of [...pool]) { pool.delete(url); try { r.ws && r.ws.close(); } catch (e) {} }
}

// ---------------------------------------------------------------------------------------------
// pure helpers — tests/background.test.mjs reads these straight out of this file
// ---------------------------------------------------------------------------------------------

// The wire id goes to a relay, so it must be short, unique per (tab, subscription), and must not
// carry anything about the page. The port number is local and meaningless off this machine.
function subKey(portId, id) { return portId + ' ' + String(id); }
function wireId(key) { return 'nc' + key.replace(' ', 'x').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40); }
function keyFromWire(wire) {
    for (const key of subs.keys()) if (wireId(key) === wire) return key;
    return null;
}

function dedupe(list) {
    const seen = new Set(), out = [];
    for (const u of list) {
        if (typeof u !== 'string') continue;
        const k = u.replace(/\/+$/, '').toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(u);
    }
    return out;
}

function isIdle(r) { return r.subs.size === 0 && r.pubs.size === 0; }
