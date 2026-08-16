// Verifies the optional at-rest key encryption (PBKDF2 -> AES-GCM): a private key round-trips
// through encrypt/decrypt, a wrong password is rejected (GCM auth failure), the encrypted blob
// is detected by _isEncPriv, and random salt/iv make each ciphertext unique.
import fs from 'fs';

const SRC = new URL('../NostrComments-Chrome/content.js', import.meta.url);

export async function run() {
    const src = fs.readFileSync(SRC, 'utf8');
    const a = src.indexOf('const _b64 =');
    const b = src.indexOf('// --- Event verification', a);
    const ns = eval('(() => {' + src.slice(a, b) + ' return {_b64,_unb64,_isEncPriv,_encryptPriv,_decryptPriv};})()');

    let p = 0, f = 0;
    const ok = (n, c) => { c ? p++ : f++; if (!c) console.log('  ✗ FAIL ' + n); };

    const priv = 'a'.repeat(63) + 'b';
    const enc = await ns._encryptPriv(priv, 'hunter2');

    ok('_isEncPriv true for encrypted blob', ns._isEncPriv(enc));
    ok('_isEncPriv false for hex string', !ns._isEncPriv(priv));
    ok('_isEncPriv false for null', !ns._isEncPriv(null));
    ok('round-trip decrypt returns the key', (await ns._decryptPriv(enc, 'hunter2')) === priv);

    let threw = false;
    try { await ns._decryptPriv(enc, 'wrong-password'); } catch (e) { threw = true; }
    ok('wrong password is rejected (GCM auth fail)', threw);

    const enc2 = await ns._encryptPriv(priv, 'hunter2');
    ok('random salt/iv → different ciphertext each time', enc.ct !== enc2.ct);
    ok('both ciphertexts still decrypt to the same key',
        (await ns._decryptPriv(enc2, 'hunter2')) === priv);

    return { name: 'at-rest key encryption', pass: p, fail: f };
}
