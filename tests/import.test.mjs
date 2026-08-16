// fromBech32(), used to import an identity the user already has elsewhere.
//
// The risk this guards against is quiet: a mistyped nsec that still decodes would hand the user a
// different, perfectly valid key. They would post under an identity nobody recognises, with no
// error explaining why. So the checksum has to be enforced, and every rejection path has to
// actually reject rather than return something usable.
import fs from 'fs';

const SRC = new URL('../NostrComments-Chrome/content.js', import.meta.url);

export async function run() {
    const src = fs.readFileSync(SRC, 'utf8');
    const a = src.indexOf('        function fromBech32(expectedHrp, str) {');
    const b = src.indexOf('        const toNpub =', a);
    const t0 = src.indexOf('        function toBech32(hrp, hex) {');
    const t1 = src.indexOf('        function fromBech32', t0);
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };
    if (a < 0 || b < 0 || t0 < 0) { ok('fromBech32 present in source', false); return { name: 'key import (bech32 decode)', pass, fail }; }

    const fromBech32 = eval(src.slice(a, b) + '; fromBech32');
    const toBech32 = eval(src.slice(t0, t1) + '; toBech32');

    // Round-trips against the encoder the extension already ships.
    let bad = 0;
    for (let i = 0; i < 300; i++) {
        const hex = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
        if (fromBech32('nsec', toBech32('nsec', hex)) !== hex) bad++;
    }
    ok('300 nsec round-trips against the shipped encoder', bad === 0, bad);

    const hex = 'ab'.repeat(32);
    const nsec = toBech32('nsec', hex);

    ok('decodes a valid nsec', fromBech32('nsec', nsec) === hex);
    ok('accepts uppercase input', fromBech32('nsec', nsec.toUpperCase()) === hex);
    ok('accepts surrounding whitespace', fromBech32('nsec', '  ' + nsec + '\n') === hex);

    // The important ones: anything corrupted must come back null, not a different key.
    const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const flip = c => CS[(CS.indexOf(c) + 1) % 32];
    for (const pos of [6, 20, 40, nsec.length - 8]) {
        const mutated = nsec.slice(0, pos) + flip(nsec[pos]) + nsec.slice(pos + 1);
        const got = fromBech32('nsec', mutated);
        ok(`a single flipped character at ${pos} is rejected`, got === null, got && got.slice(0, 16));
    }
    ok('a truncated nsec is rejected', fromBech32('nsec', nsec.slice(0, -1)) === null);
    ok('an extended nsec is rejected', fromBech32('nsec', nsec + 'q') === null);
    ok('an npub is rejected when an nsec is expected', fromBech32('nsec', toBech32('npub', hex)) === null);
    ok('an nsec is rejected when an npub is expected', fromBech32('npub', nsec) === null);
    ok('a non-bech32 character is rejected', fromBech32('nsec', nsec.slice(0, 10) + 'b' + nsec.slice(11)) === null);

    for (const junk of ['', '   ', 'nsec1', 'hello world', 'nsec', '1234', null, undefined]) {
        let threw = false, got;
        try { got = fromBech32('nsec', junk); } catch { threw = true; }
        ok(`junk input ${JSON.stringify(junk)} returns null without throwing`, !threw && got === null, { threw, got });
    }

    // A payload of the wrong length must not be accepted even with a valid checksum.
    const shortPayload = toBech32('nsec', 'cd'.repeat(16));
    ok('a correctly-checksummed but wrong-length payload is rejected', fromBech32('nsec', shortPayload) === null);

    return { name: 'key import (bech32 decode)', pass, fail };
}
