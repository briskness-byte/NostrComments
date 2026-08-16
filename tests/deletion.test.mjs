// NIP-09 deletion handling, extracted from the shipped source and exercised directly.
//
// The property that matters is authorisation: a deletion request only counts when it is signed by
// the author of the event it targets. Without that check, publishing a kind 5 naming someone
// else's comment would erase it for every reader — a censorship hole in a tool whose entire point
// is resisting censorship. That is worth a test rather than a careful reading.
import fs from 'fs';

const SRC = new URL('../NostrComments-Chrome/content.js', import.meta.url);

export async function run() {
    const src = fs.readFileSync(SRC, 'utf8');
    const start = src.indexOf('        // NIP-09 deletion requests, keyed by');
    const end = src.indexOf('        function render()');
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };
    if (start < 0 || end < 0 || end < start) {
        ok('deletion handling found in source', false);
        return { name: 'NIP-09 deletion', pass, fail };
    }

    // queueVerify normally checks the signature before running the callback. Here it is stubbed so
    // the test isolates the authorisation logic; signature verification has its own suite.
    let verifyCalls = 0;
    const makeModule = ({ verifies = true } = {}) => {
        const queueVerify = (ev, cb) => { verifyCalls++; if (verifies) cb(); };
        const scheduleRender = () => {};
        return new Function('queueVerify', 'scheduleRender',
            src.slice(start, end) + '; return { deletionRequests, isDeleted, noteDeletionRequest };')(queueVerify, scheduleRender);
    };

    const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
    const note = (id, pubkey) => ({ id, pubkey, kind: 1, content: 'hi', tags: [] });
    const del = (pubkey, ...ids) => ({ id: 'dd'.repeat(32), pubkey, kind: 5, tags: ids.map(i => ['e', i]) });

    // The author deletes their own comment.
    let m = makeModule();
    const mine = note('11'.repeat(32), A);
    ok('a comment is visible before any deletion', !m.isDeleted(mine));
    m.noteDeletionRequest(del(A, mine.id));
    ok('author deleting their own comment hides it', m.isDeleted(mine));

    // Someone else tries to delete it. This is the one that must not work.
    m = makeModule();
    const victim = note('22'.repeat(32), A);
    m.noteDeletionRequest(del(B, victim.id));
    ok('a deletion signed by a DIFFERENT pubkey does NOT hide the comment', !m.isDeleted(victim), { targetAuthor: 'A', deletedBy: 'B' });

    // ...and the rightful author can still delete it afterwards.
    m.noteDeletionRequest(del(A, victim.id));
    ok('the real author can still delete after a forged attempt', m.isDeleted(victim));

    // A deletion can arrive before the comment it refers to; the check happens at compare time.
    m = makeModule();
    const late = note('33'.repeat(32), A);
    m.noteDeletionRequest(del(A, late.id));
    ok('a deletion received before its comment still applies', m.isDeleted(late));

    // One request naming several events deletes only the ones by that author.
    m = makeModule();
    const ownA = note('44'.repeat(32), A), ownB = note('55'.repeat(32), B);
    m.noteDeletionRequest(del(A, ownA.id, ownB.id));
    ok('a multi-target request deletes the sender\'s own event', m.isDeleted(ownA));
    ok('a multi-target request does not reach someone else\'s event', !m.isDeleted(ownB));

    // Malformed input must be ignored rather than throwing or matching loosely.
    m = makeModule();
    const good = note('66'.repeat(32), A);
    for (const bad of [
        { pubkey: A, tags: [] },
        { pubkey: A, tags: [['e']] },
        { pubkey: A, tags: [['e', 'not-hex']] },
        { pubkey: A, tags: [['p', good.id]] },
        { pubkey: A },
    ]) {
        let threw = false;
        try { m.noteDeletionRequest(bad); } catch { threw = true; }
        ok('malformed deletion request is ignored without throwing', !threw, bad.tags);
    }
    ok('malformed requests did not delete anything', !m.isDeleted(good));

    // An unverifiable request must never take effect.
    m = makeModule({ verifies: false });
    const unsigned = note('77'.repeat(32), A);
    m.noteDeletionRequest(del(A, unsigned.id));
    ok('a request that fails verification does not hide the comment', !m.isDeleted(unsigned));

    ok('every request went through signature verification', verifyCalls > 0, verifyCalls);

    return { name: 'NIP-09 deletion', pass, fail };
}
