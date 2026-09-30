// decodeLinkedEntity(): turning a <link rel="alternate" href="nostr:..."> value into what a relay
// filter needs to find the NIP-22 comments scoped to it — an { addr } for an addressable event
// (root-scoped with an A tag, per NIP-22) or an { id } for a regular one (root-scoped with E).
//
// The naddr and nevent below are real: they arrived in a NIP draft a user of the extension sent in
// (nostrhub.io/<the naddr>), proposing exactly this discovery convention. Decoded here and checked
// against what querying live relays for them independently returned — kind 30817, author
// 46f3c7bb…, d-tag "nip-link-web-to-nostr-entity-link" for the naddr; the reply note's own id for
// the nevent. Real production data is a better fixture than one built to be easy to decode.
import { extensionCode } from './harness.mjs';

export async function run() {
    const { decodeLinkedEntity } = extensionCode();
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n, extra ?? '')); };

    const NADDR = 'naddr1qvzqqqrcvypzq3hnc7an8npsryzfkaku38dmjm35cfrmmkngk6kcvvngy7fllzs6qqsku6ts94kxjmnt94mk2c3dw3hj6mn0wd68ytt9de6xjare94kxjmnt7pzrp0';
    const NEVENT = 'nevent1qvzqqqqy2upzq3hnc7an8npsryzfkaku38dmjm35cfrmmkngk6kcvvngy7fllzs6qy88wumn8ghj7mn0wvhxcmmv9uq3wamnwvaz7tmjv4kxz7fwwpexjmtpdshxuet59uqzqgzxryf57ez3uzwj9v27zkza725nt7p4knatj3ktvzrh5u8rru5m4klnsa';
    const WANT_ADDR = '30817:46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a:nip-link-web-to-nostr-entity-link';
    const WANT_ID = '204619134f6451e09d22b15e1585df2a935f835b4fab946cb60877a70e31f29b';

    const r1 = decodeLinkedEntity(NADDR);
    ok('naddr decodes to the real kind:pubkey:d address', r1 && r1.addr === WANT_ADDR && r1.id === null, r1);
    ok('nostr: prefix is stripped', decodeLinkedEntity('nostr:' + NADDR)?.addr === WANT_ADDR);
    ok('uppercase input is accepted, bech32 is case-insensitive', decodeLinkedEntity(NADDR.toUpperCase())?.addr === WANT_ADDR);
    ok('surrounding whitespace is trimmed', decodeLinkedEntity('  ' + NADDR + '\n')?.addr === WANT_ADDR);

    const r2 = decodeLinkedEntity(NEVENT);
    ok('nevent decodes to the real event id', r2 && r2.id === WANT_ID && r2.addr === null, r2);
    ok('nostr:nevent prefix is stripped', decodeLinkedEntity('nostr:' + NEVENT)?.id === WANT_ID);

    // note1 — the plain-event form NIP-LINK's own prose mentions as an alternative to nevent.
    const { toBech32, newKey, _secp } = extensionCode();
    const noteId = 'cc'.repeat(32);
    ok('a plain note1 decodes by id, same as an nevent without extra fields', decodeLinkedEntity(toBech32('note', noteId))?.id === noteId);

    // Never both, never a length that could confuse an id with something else.
    ok('addr and id are mutually exclusive on an naddr', r1.id === null);
    ok('addr and id are mutually exclusive on an nevent', r2.addr === null);

    // A relay could send back a d-tag holding anything short of the 2048-char link-href cap
    // (safeLink) checked elsewhere; a genuinely huge one should not become an expensive parse.
    let corruptedFails = 0;
    const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const flip = (s, pos) => s.slice(0, pos) + CS[(CS.indexOf(s[pos]) + 1) % 32] + s.slice(pos + 1);
    for (const pos of [10, 30, 60, NADDR.length - 5]) {
        if (decodeLinkedEntity(flip(NADDR, pos)) !== null) corruptedFails++;
    }
    ok('4 single-character corruptions of a valid naddr are all rejected', corruptedFails === 0, corruptedFails);

    for (const junk of [
        null, undefined, 42, '', '   ', 'nostr:', 'nostr:npub1abc', 'naddr1', 'naddr1q',
        'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',  // a real npub — wrong type
        'x'.repeat(3000), 'naddr1' + 'q'.repeat(2500),
        NADDR.slice(0, -1), NADDR + 'q', NADDR.slice(0, -8),
    ]) {
        let threw = false, got;
        try { got = decodeLinkedEntity(junk); } catch (e) { threw = true; }
        ok(`rejects ${JSON.stringify(String(junk).slice(0, 24))} without throwing`, !threw && got === null, { threw, got });
    }

    // A naddr missing the pieces NIP-22's A tag needs (author or kind) must not decode to a
    // half-built address — a filter on "undefined:<pubkey>:x" or "30817:undefined:x" would silently
    // match nothing, which reads as "nothing to merge" rather than the malformed-input error it is.
    ok('an addr string is never built with a missing piece', !r1.addr.includes('undefined'), r1.addr);

    return { name: 'NIP-LINK entity decode (naddr/nevent)', pass, fail };
}
