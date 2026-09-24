// The curve arithmetic in the shipped build, checked against a second, independent and deliberately
// plain implementation of the same thing.
//
// Verifying a signature is the most expensive thing this extension does, and it does it once for
// every event in a thread, so the arithmetic underneath is written for speed. Speed is the kind of
// change that gets a number wrong once in a few thousand inputs, and a wrong number here is not a
// crash: it is a signature that verifies when it should not, or one that does not when it should.
// So the fast code is held against the slow, obviously-correct affine version — public keys for many
// scalars including the awkward ones, and signatures made by one and checked by the other.
import { extensionCode } from './harness.mjs';

export async function run() {
    const { _secp, newKey } = extensionCode();
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n, extra ?? '')); };

    // --- the reference: affine coordinates, one modular inverse per addition ---------------------
    const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
    const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    const G = [0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
               0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n];
    const m = a => ((a % P) + P) % P;
    const modpow = (b, e) => { let r = 1n; b = m(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; };
    const inv = a => modpow(a, P - 2n);                       // Fermat, on purpose: not the same routine
    const add = (A, B) => {
        if (!A) return B; if (!B) return A;
        if (A[0] === B[0]) {
            if (m(A[1] + B[1]) === 0n) return null;
            const l = m(3n * A[0] * A[0] * inv(2n * A[1])); const x = m(l * l - 2n * A[0]);
            return [x, m(l * (A[0] - x) - A[1])];
        }
        const l = m((B[1] - A[1]) * inv(B[0] - A[0])); const x = m(l * l - A[0] - B[0]);
        return [x, m(l * (A[0] - x) - A[1])];
    };
    const mul = (k, Pt) => { let R = null, Q = Pt; while (k > 0n) { if (k & 1n) R = add(R, Q); Q = add(Q, Q); k >>= 1n; } return R; };
    const hex = n => n.toString(16).padStart(64, '0');

    // --- public keys ---------------------------------------------------------------------------------
    const edge = [1n, 2n, 3n, 4n, 7n, 8n, 15n, 16n, 255n, 256n, N - 1n, N - 2n, N - 3n, (N + 1n) / 2n, (N - 1n) / 2n,
                  2n ** 128n, 2n ** 255n, 2n ** 255n - 1n, P - 1n, P % N];
    const random = Array.from({ length: 150 }, () => BigInt('0x' + newKey()) % (N - 1n) + 1n);
    let mismatched = 0;
    for (const k of [...edge, ...random]) {
        if (k <= 0n || k >= N) continue;
        if (_secp.pubKey(hex(k)) !== hex(mul(k, G)[0])) { mismatched++; console.log('  ✗ public key differs for', hex(k)); }
    }
    ok(`public keys agree with the reference for ${edge.length + random.length} scalars`, mismatched === 0, mismatched);

    // --- signatures both ways --------------------------------------------------------------------------
    const enc = new TextEncoder();
    const msg = async i => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('message ' + i)));
    let signFails = 0, tamperAccepted = 0, shortcutsWrong = 0;
    for (let i = 0; i < 60; i++) {
        const k = newKey(), pub = _secp.pubKey(k), mm = await msg(i);
        const sig = await _secp.sign(k, mm);
        if (!(await _secp.verify(pub, mm, sig))) signFails++;
        // Anything altered must fail: one bit of the signature, of the message, of the key.
        const flip = (h, at) => h.slice(0, at) + ((parseInt(h[at], 16) ^ 1).toString(16)) + h.slice(at + 1);
        const bad = [
            [pub, mm, flip(sig, (i * 7) % 128)],
            [flip(pub, (i * 5) % 64), mm, sig],
            [pub, await msg('x' + i), sig],
        ];
        for (const [p, mg, sg] of bad) if (await _secp.verify(p, mg, sg)) tamperAccepted++;
    }
    ok('60 signatures made here verify here', signFails === 0, signFails);
    ok('180 altered signatures, messages and keys are all refused', tamperAccepted === 0, tamperAccepted);

    // The reference verifies what the shipped code signs. BIP-340: R = sG - eP, R has an even y and R.x = r.
    const th = async (tag, ...ms) => {
        const t = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(tag)));
        const all = new Uint8Array([...t, ...t, ...ms.flatMap(x => [...x])]);
        return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
    };
    const b2n = b => BigInt('0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join(''));
    const h2b = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
    for (let i = 0; i < 25; i++) {
        const k = newKey(), pubHex = _secp.pubKey(k), mm = await msg('ref' + i), sig = await _secp.sign(k, mm);
        const r = BigInt('0x' + sig.slice(0, 64)), s = BigInt('0x' + sig.slice(64));
        const y2 = m(BigInt('0x' + pubHex) ** 3n + 7n), y = modpow(y2, (P + 1n) / 4n);
        const Pt = [BigInt('0x' + pubHex), y % 2n === 0n ? y : P - y];
        const e = b2n(await th('BIP0340/challenge', h2b(sig.slice(0, 64)), h2b(pubHex), mm)) % N;
        const R = add(mul(s, G), mul(N - e, Pt));
        if (!R || R[1] % 2n !== 0n || R[0] !== r) shortcutsWrong++;
    }
    ok('the reference implementation accepts what the shipped code signs (25 signatures)', shortcutsWrong === 0, shortcutsWrong);

    return { name: 'curve arithmetic against a reference', pass, fail };
}
