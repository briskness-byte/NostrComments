// Verifies NIP-19 identity encoding (bech32): the "Copy nsec"/"Copy npub" export must produce
// values that other Nostr clients accept. Checked against the official NIP-19 reference vectors.
import fs from 'fs';

const SRC = new URL('../NostrComments-Chrome/content.js', import.meta.url);

export async function run() {
    const src = fs.readFileSync(SRC, 'utf8');
    const a = src.indexOf('function toBech32(hrp, hex) {');
    const b = src.indexOf('const toNpub =', a);
    const toBech32 = eval(src.slice(a, b) + '; toBech32');

    let p = 0, f = 0;
    const ok = (n, c) => { c ? p++ : f++; if (!c) console.log('  ✗ FAIL ' + n); };

    // Official NIP-19 reference vectors.
    ok('nsec (private key) matches NIP-19',
        toBech32('nsec', '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa')
        === 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5');
    ok('npub (public key) matches NIP-19',
        toBech32('npub', '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d')
        === 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6');

    return { name: 'bech32 / NIP-19 identity encoding', pass: p, fail: f };
}
