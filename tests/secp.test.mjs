// Verifies the hand-rolled secp256k1 + BIP-340 Schnorr implementation shipped in content.js:
// genuine events verify, every tamper/forgery vector is rejected, and the complete official
// BIP-340 test vector set passes.
//
// All nineteen of them, not one. For a long time this file used reference vector #1 and a
// hand-made variant of it, which proves the implementation can accept a good signature and says
// nothing about whether it rejects a bad one. Ten of the official vectors exist precisely for that
// second question — a public key off the curve, a signature whose first half is not an x
// coordinate, s equal to the curve order, sG - eP at infinity — and those are the cases where a
// hand-rolled implementation goes wrong. Getting one of them wrong means accepting a forged
// signature, which is the single assumption everything else in this extension rests on.
//
// The vectors are embedded rather than fetched: the suite runs offline and has no dependencies,
// and a test that needs the network is a test that gets skipped.
import fs from 'fs';

const SRC = new URL('../NostrComments-Chrome/content.js', import.meta.url);

export async function run() {
    const src = fs.readFileSync(SRC, 'utf8');
    const s0 = src.indexOf('const _secp = (() => {');
    const s1 = src.indexOf('})();', s0) + '})();'.length;
    const _secp = eval(src.slice(s0, s1) + '; _secp');
    const enc = new TextEncoder();

    let p = 0, f = 0;
    const ok = (n, c) => { c ? p++ : f++; if (!c) console.log('  ✗ FAIL ' + n); };

    const sign = async (priv, ev) => {
        const pub = _secp.pubKey(priv);
        const ser = JSON.stringify([0, pub, ev.created_at, ev.kind, ev.tags, ev.content]);
        const idb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(ser)));
        return { ...ev, id: _secp.b2h(idb), sig: await _secp.sign(priv, idb), pubkey: pub };
    };
    const verify = async (ev) => {
        if (!/^[0-9a-f]{64}$/i.test(ev.id || '') || !/^[0-9a-f]{64}$/i.test(ev.pubkey || '') || !/^[0-9a-f]{128}$/i.test(ev.sig || '')) return false;
        const ser = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
        const idb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(ser)));
        if (_secp.b2h(idb) !== ev.id.toLowerCase()) return false;
        return _secp.verify(ev.pubkey, idb, ev.sig);
    };

    for (let i = 0; i < 8; i++) {
        const priv = _secp.b2h(crypto.getRandomValues(new Uint8Array(32)));
        const ev = { kind: 1, created_at: 1700000000 + i, tags: [['r', 'https://x.com/p'], ['e', 'a'.repeat(64)]], content: `hi ${i} — üñî 🚀` };
        const s = await sign(priv, ev);
        ok(`genuine event verifies #${i}`, await verify(s));
        ok(`tampered content rejected #${i}`, !(await verify({ ...s, content: s.content + '!' })));
        ok(`forged pubkey rejected #${i}`, !(await verify({ ...s, pubkey: _secp.pubKey(_secp.b2h(crypto.getRandomValues(new Uint8Array(32)))) })));
        const badSig = s.sig.slice(0, -2) + (s.sig.slice(-2) === 'ff' ? '00' : 'ff');
        ok(`tampered signature rejected #${i}`, !(await verify({ ...s, sig: badSig })));
    }

    const h2b = h => new Uint8Array((h.match(/.{2}/g) || []).map(b => parseInt(b, 16)));

    // The official set, from bitcoin/bips/bip-0340/test-vectors.csv.
    const BIP340 = [
    { i: 0, sec: '0000000000000000000000000000000000000000000000000000000000000003', pub: 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9', msg: '0000000000000000000000000000000000000000000000000000000000000000', sig: 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0', ok: true, note: '' },
    { i: 1, sec: 'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef', pub: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: '6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a', ok: true, note: '' },
    { i: 2, sec: 'c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5c9', pub: 'dd308afec5777e13121fa72b9cc1b7cc0139715309b086c960e18fd969774eb8', msg: '7e2d58d8b3bcdf1abadec7829054f90dda9805aab56c77333024b9d0a508b75c', sig: '5831aaeed7b44bb74e5eab94ba9d4294c49bcf2a60728d8b4c200f50dd313c1bab745879a5ad954a72c45a91c3a51d3c7adea98d82f8481e0e1e03674a6f3fb7', ok: true, note: '' },
    { i: 3, sec: '0b432b2677937381aef05bb02a66ecd012773062cf3fa2549e44f58ed2401710', pub: '25d1dff95105f5253c4022f628a996ad3a0d95fbf21d468a1b33f8c160d8f517', msg: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', sig: '7eb0509757e246f19449885651611cb965ecc1a187dd51b64fda1edc9637d5ec97582b9cb13db3933705b32ba982af5af25fd78881ebb32771fc5922efc66ea3', ok: true, note: 'test fails if msg is reduced modulo p or n' },
    { i: 4, sec: '', pub: 'd69c3509bb99e412e68b0fe8544e72837dfa30746d8be2aa65975f29d22dc7b9', msg: '4df3c3f68fcc83b27e9d42c90431a72499f17875c81a599b566c9889b9696703', sig: '00000000000000000000003b78ce563f89a0ed9414f5aa28ad0d96d6795f9c6376afb1548af603b3eb45c9f8207dee1060cb71c04e80f593060b07d28308d7f4', ok: true, note: '' },
    { i: 5, sec: '', pub: 'eefdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: '6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e17776969e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b', ok: false, note: 'public key not on the curve' },
    { i: 6, sec: '', pub: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: 'fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a14602975563cc27944640ac607cd107ae10923d9ef7a73c643e166be5ebeafa34b1ac553e2', ok: false, note: 'has_even_y(R) is false' },
    { i: 7, sec: '', pub: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: '1fa62e331edbc21c394792d2ab1100a7b432b013df3f6ff4f99fcb33e0e1515f28890b3edb6e7189b630448b515ce4f8622a954cfe545735aaea5134fccdb2bd', ok: false, note: 'negated message' },
    { i: 8, sec: '', pub: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: '6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e177769961764b3aa9b2ffcb6ef947b6887a226e8d7c93e00c5ed0c1834ff0d0c2e6da6', ok: false, note: 'negated s value' },
    { i: 9, sec: '', pub: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: '0000000000000000000000000000000000000000000000000000000000000000123dda8328af9c23a94c1feecfd123ba4fb73476f0d594dcb65c6425bd186051', ok: false, note: 'sG - eP is infinite. Test fails in single verification if has_even_y(inf) is defined as true and x(inf) as 0' },
    { i: 10, sec: '', pub: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: '00000000000000000000000000000000000000000000000000000000000000017615fbaf5ae28864013c099742deadb4dba87f11ac6754f93780d5a1837cf197', ok: false, note: 'sG - eP is infinite. Test fails in single verification if has_even_y(inf) is defined as true and x(inf) as 1' },
    { i: 11, sec: '', pub: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: '4a298dacae57395a15d0795ddbfd1dcb564da82b0f269bc70a74f8220429ba1d69e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b', ok: false, note: 'sig[0:32] is not an X coordinate on the curve' },
    { i: 12, sec: '', pub: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f69e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b', ok: false, note: 'sig[0:32] is equal to field size' },
    { i: 13, sec: '', pub: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: '6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e177769fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', ok: false, note: 'sig[32:64] is equal to curve order' },
    { i: 14, sec: '', pub: 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc30', msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89', sig: '6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e17776969e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b', ok: false, note: 'public key is not a valid X coordinate because it exceeds the field size' },
    { i: 15, sec: '0340034003400340034003400340034003400340034003400340034003400340', pub: '778caa53b4393ac467774d09497a87224bf9fab6f6e68b23086497324d6fd117', msg: '', sig: '71535db165ecd9fbbc046e5ffaea61186bb6ad436732fccc25291a55895464cf6069ce26bf03466228f19a3a62db8a649f2d560fac652827d1af0574e427ab63', ok: true, note: 'message of size 0 (added 2022-12)' },
    { i: 16, sec: '0340034003400340034003400340034003400340034003400340034003400340', pub: '778caa53b4393ac467774d09497a87224bf9fab6f6e68b23086497324d6fd117', msg: '11', sig: '08a20a0afef64124649232e0693c583ab1b9934ae63b4c3511f3ae1134c6a303ea3173bfea6683bd101fa5aa5dbc1996fe7cacfc5a577d33ec14564cec2bacbf', ok: true, note: 'message of size 1 (added 2022-12)' },
    { i: 17, sec: '0340034003400340034003400340034003400340034003400340034003400340', pub: '778caa53b4393ac467774d09497a87224bf9fab6f6e68b23086497324d6fd117', msg: '0102030405060708090a0b0c0d0e0f1011', sig: '5130f39a4059b43bc7cac09a19ece52b5d8699d1a71e3c52da9afdb6b50ac370c4a482b77bf960f8681540e25b6771ece1e5a37fd80e5a51897c5566a97ea5a5', ok: true, note: 'message of size 17 (added 2022-12)' },
    { i: 18, sec: '0340034003400340034003400340034003400340034003400340034003400340', pub: '778caa53b4393ac467774d09497a87224bf9fab6f6e68b23086497324d6fd117', msg: '99999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999', sig: '403b12b0d8555a344175ea7ec746566303321e5dbfa8be6f091635163eca79a8585ed3e3170807e7c03b720fc54c7b23897fcba0e9d0b4a06894cfd249f22367', ok: true, note: 'message of size 100 (added 2022-12)' },
    ];
    for (const v of BIP340) {
        let got;
        try { got = await _secp.verify(v.pub, h2b(v.msg), v.sig) === true; }
        catch (e) { got = 'threw: ' + e.message; }
        ok(`BIP-340 vector #${v.i} ${v.ok ? 'verifies' : 'is rejected'}${v.note ? ' — ' + v.note : ''}`, got === v.ok);
    }
    // Deriving the public key is the other half of interoperating: a wrong one produces events
    // nobody can attribute to you.
    for (const v of BIP340.filter(v => v.sec))
        ok(`BIP-340 vector #${v.i}: the public key derives from the secret key`,
           (() => { try { return _secp.pubKey(v.sec).toLowerCase() === v.pub; } catch (e) { return false; } })());
    // And signing, checked by verifying rather than by comparing bytes: BIP-340 signatures depend
    // on aux_rand, so a byte comparison would test the random source rather than the maths.
    for (const v of BIP340.filter(v => v.sec && v.ok && v.msg.length === 64)) {
        let back = false;
        try { back = await _secp.verify(v.pub, h2b(v.msg), await _secp.sign(v.sec, h2b(v.msg))) === true; } catch (e) {}
        ok(`BIP-340 vector #${v.i}: a signature made here verifies against the reference key`, back);
    }

    // Official BIP-340 reference vector #1 — proves interop with other Nostr signers.
    ok('BIP-340 reference vector #1 verifies',
        await _secp.verify(
            'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
            h2b('243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89'),
            '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A'));
    ok('wrong-message vector rejected',
        !(await _secp.verify(
            'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
            h2b('243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C88'),
            '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A')));

    return { name: 'secp / event verification', pass: p, fail: f };
}
