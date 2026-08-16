// Verifies migrateRelays(): the one-time retirement of relays that were dropped from the defaults
// because they stopped answering.
//
// A saved relay list wins over DEFAULT_RELAYS, which is right — it is a choice somebody made — but
// saveRelays() only runs when a relay is added or removed, so the choice froze on the day it was
// made. Anyone who touched the list before v22.59 still carries relay.nostr.band and offchain.pub,
// and pays both timeouts on every page they read.
//
// The interesting cases are the ones where it must NOT act: a list that has already been migrated,
// a user who never saved one, and a relay somebody chose to remove. Getting those wrong means
// overwriting a preference, which is worse than the dead relay it would be fixing.
import fs from 'fs';

const SRC = new URL('../NostrComments-Chrome/content.js', import.meta.url);

export async function run() {
    const src = fs.readFileSync(SRC, 'utf8');
    const t0 = src.indexOf('        const DEFAULT_RELAYS =');
    const t1 = src.indexOf('        let RELAYS = (() => {', t0);
    const n0 = src.indexOf('        function normRelay(u) {');
    const n1 = src.indexOf('        function saveRelays()', n0);
    const snippet = src.slice(t0, t1) + src.slice(n0, n1);
    const { migrateRelays, DEFAULT_RELAYS, DEAD_RELAYS } =
        eval(snippet + '; ({migrateRelays, DEFAULT_RELAYS, DEAD_RELAYS})');

    let p = 0, f = 0;
    const ok = (n, c, got) => { c ? p++ : f++; if (!c) console.log('  ✗ FAIL ' + n + (got !== undefined ? '  → ' + JSON.stringify(got) : '')); };

    // The list a v22.58 user is still carrying, unchanged since the day they added one relay.
    const OLD = ['wss://nos.lol','wss://relay.damus.io','wss://relay.nostr.band','wss://relay.primal.net','wss://relay.snort.social','wss://offchain.pub'];

    const first = migrateRelays(OLD, false);
    ok('both retired relays are dropped', !first.list.some(u => DEAD_RELAYS.includes(u)), first.list);
    ok('and it reports how many', first.retired === 2, first.retired);
    ok('the rest of the list is untouched and in order',
        JSON.stringify(first.list) === JSON.stringify(['wss://nos.lol','wss://relay.damus.io','wss://relay.primal.net','wss://relay.snort.social']), first.list);
    ok('the change is written back', first.save === true, first.save);

    // damus.io answers 503 on some days and serves fine on others. v22.59 made the call that
    // intermittent is not the same as silent, and this must not quietly reverse it.
    ok('damus.io survives', first.list.includes('wss://relay.damus.io'), first.list);

    // Run once, and only once. A migration that repeats is a migration that fights the user.
    const second = migrateRelays(first.list, true);
    ok('a migrated list is left alone', JSON.stringify(second.list) === JSON.stringify(first.list), second.list);
    ok('and nothing is retired the second time', second.retired === 0 && second.save === false, second);

    // The case this whole change exists to avoid causing: somebody who never saved a list must not
    // get one now. Writing one would freeze them at today's defaults — the original bug, reissued.
    for (const [name, saved] of [['null', null], ['undefined', undefined], ['empty', []], ['not an array', 'wss://x']]) {
        const r = migrateRelays(saved, false);
        ok(`no saved list (${name}) yields the live defaults`, JSON.stringify(r.list) === JSON.stringify(DEFAULT_RELAYS), r.list);
        ok(`no saved list (${name}) is not written back`, r.save === false, r.save);
    }

    // A relay removed on purpose stays removed. There is nothing in the stored list that tells a
    // deliberate removal apart from one that was never added, so the list is never topped up.
    const trimmed = migrateRelays(['wss://nos.lol'], false);
    ok('a deliberately short list is not topped back up', JSON.stringify(trimmed.list) === JSON.stringify(['wss://nos.lol']), trimmed.list);
    ok('and nothing is written back for it', trimmed.save === false, trimmed.save);

    // relay.snort.social left the defaults in 23.0.1 for keeping no history, not for being
    // unreachable. That is a reason to stop choosing it for new installs; it is not a licence to
    // take it out of a list somebody built themselves. DEAD_RELAYS is for relays that do not
    // answer, and widening it to "relays we would no longer pick" would make this migration a way
    // to overwrite preferences rather than to clear out wreckage.
    const quality = migrateRelays(['wss://nos.lol','wss://relay.snort.social'], false);
    ok('a relay dropped from the defaults on quality stays in a saved list',
        quality.list.includes('wss://relay.snort.social') && quality.save === false, quality);
    ok('and it is not in DEAD_RELAYS', !DEAD_RELAYS.includes('wss://relay.snort.social'), DEAD_RELAYS);

    // Stripping the dead ones can empty a list, and an extension with no relays reaches nothing.
    // That is the one case where the defaults come back.
    const allDead = migrateRelays([...DEAD_RELAYS], false);
    ok('a list that was only dead relays falls back to the defaults',
        JSON.stringify(allDead.list) === JSON.stringify(DEFAULT_RELAYS), allDead.list);
    ok('and that is written back', allDead.save === true, allDead.save);

    // Retirement runs through normRelay, so the trailing-slash and mixed-case forms of the same
    // relay are the same relay. A real NIP-65 list supplied exactly that pair, per v22.59.
    const messy = migrateRelays(['wss://nos.lol','wss://relay.nostr.band/','WSS://OffChain.pub','wss://nos.lol/'], false);
    ok('trailing slashes and case do not hide a dead relay',
        JSON.stringify(messy.list) === JSON.stringify(['wss://nos.lol']), messy.list);

    // Deduplication still happens on the way in, migrated or not.
    const dupes = migrateRelays(['wss://nos.lol','wss://nos.lol/','wss://nostr.mom'], true);
    ok('duplicates are still collapsed on an already-migrated list',
        JSON.stringify(dupes.list) === JSON.stringify(['wss://nos.lol','wss://nostr.mom']), dupes.list);

    return { name: 'relay migration', pass: p, fail: f };
}
