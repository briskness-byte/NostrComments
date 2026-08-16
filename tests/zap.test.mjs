// Exercises the real lnurlPay() from the shipped Chrome build against stubbed fetch/webln.
// This is the money path: a wrong sats→msat conversion or a malformed NIP-57 zap request either
// sends the wrong amount or silently drops attribution, so it is worth pinning down.
import fs from 'fs';

const SRC = new URL('../NostrComments-Chrome/content.js', import.meta.url);

export async function run() {
    const src = fs.readFileSync(SRC, 'utf8');
    const start = src.indexOf('        async function lnurlPay(');
    const end = src.indexOf('        function zap(ev)');
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n, extra ?? '')); };
    if (start < 0 || end < 0) {
        ok('lnurlPay found in source', false);
        return { name: 'zap / lnurl-pay', pass, fail };
    }

    let msgs = [], fetches = [], paid = null;
    const showMsg = t => { msgs.push(t); };
    const RELAYS = ['wss://a.example', 'wss://b.example'];
    const myPub = 'aa'.repeat(32);
    const getWallet = () => ({ signEvent: async ev => ({ ...ev, id: 'deadbeef', sig: 'ff' }) });
    // lnurlPay signs through signAsMe now, which reconciles the identity from the signature before
    // anything goes out under it. That lives outside this slice, so it is stubbed at the same seam.
    const signAsMe = async ev => getWallet().signEvent(ev);
    const window = { webln: { enable: async () => {}, sendPayment: async pr => { paid = pr; } } };
    const navigator = { clipboard: { writeText: async () => {} } };

    const LIVE = { minSendable: 1000, maxSendable: 100000000, callback: 'https://pay.example/cb', allowsNostr: true, nostrPubkey: 'bb'.repeat(32) };
    let LNURL = LIVE;
    const fetch = async url => {
        fetches.push(url);
        if (url.includes('/.well-known/lnurlp/')) return { json: async () => LNURL };
        return { json: async () => ({ pr: 'lnbc1invoice...' }) };
    };

    const lnurlPay = new Function('showMsg', 'RELAYS', 'myPub', 'getWallet', 'signAsMe', 'window', 'navigator', 'fetch',
        src.slice(start, end) + '; return lnurlPay;')(showMsg, RELAYS, myPub, getWallet, signAsMe, window, navigator, fetch);

    const reset = () => { msgs = []; fetches = []; paid = null; };
    const zapReq = () => JSON.parse(decodeURIComponent(fetches[1].split('&nostr=')[1]));

    // Support zap: 5000 sats must bill 5_000_000 msat, as a NIP-57 zap with a p tag and no e tag.
    reset();
    let r = await lnurlPay({ lud16: 'dev@example.com', pubkey: 'cc'.repeat(32), amount: 5000 * 1000, successMsg: '⚡ Sent 5000 sats — thank you!' });
    ok('support zap returns true when the wallet paid', r === true, r);
    ok('lnurlp endpoint derived from lud16', fetches[0] === 'https://example.com/.well-known/lnurlp/dev', fetches[0]);
    ok('5000 sats billed as 5000000 msat', fetches[1].includes('amount=5000000'), fetches[1]);
    ok('zap request is kind 9734', zapReq().kind === 9734, zapReq().kind);
    ok('zap request p tag is the payee', JSON.stringify(zapReq().tags).includes('["p","' + 'cc'.repeat(32) + '"]'), zapReq().tags);
    ok('support zap carries no e tag', !zapReq().tags.some(t => t[0] === 'e'), zapReq().tags);
    ok('zap request amount tag in msat', zapReq().tags.some(t => t[0] === 'amount' && t[1] === '5000000'), zapReq().tags);
    ok('success message shown', msgs.includes('⚡ Sent 5000 sats — thank you!'), msgs);
    ok('invoice handed to the wallet', paid === 'lnbc1invoice...', paid);

    // Comment zap keeps its existing 21-sat behaviour and its e tag.
    reset();
    await lnurlPay({ lud16: 'u@example.com', pubkey: 'dd'.repeat(32), eventId: 'ee'.repeat(32), amount: 21000, target: 'this user', successMsg: '⚡ Zapped 21 sats!' });
    ok('comment zap tags the event', zapReq().tags.some(t => t[0] === 'e' && t[1] === 'ee'.repeat(32)), zapReq().tags);
    ok('comment zap bills 21000 msat', fetches[1].includes('amount=21000'), fetches[1]);
    ok('comment zap message unchanged', msgs.includes('⚡ Zapped 21 sats!'), msgs);

    // Without a payee pubkey it degrades to a plain lnurl-pay.
    reset();
    await lnurlPay({ lud16: 'dev@example.com', pubkey: null, amount: 1000 * 1000, successMsg: 'ok' });
    ok('no pubkey means no nostr param', !fetches[1].includes('nostr='), fetches[1]);

    // Range errors, with and without a named target.
    reset();
    LNURL = { ...LIVE, minSendable: 10000, maxSendable: 2000000 };
    await lnurlPay({ lud16: 'dev@example.com', amount: 1000, successMsg: 'x' });
    ok('below min reported without a target', msgs[0] === '1 sats out of range', msgs);
    reset();
    await lnurlPay({ lud16: 'u@example.com', amount: 21000000, target: 'this user', successMsg: 'x' });
    ok('above max keeps the "for this user" wording', msgs[0] === '21000 sats out of range for this user', msgs);
    LNURL = LIVE;

    // A malformed address must never reach the network.
    reset();
    await lnurlPay({ lud16: 'not-an-address', amount: 21000, successMsg: 'x' });
    ok('invalid lud16 rejected', msgs[0] === 'Invalid Lightning address', msgs);
    ok('invalid lud16 makes no network call', fetches.length === 0, fetches);

    // The callback is the payee's own string, handed back inside their JSON. It used to be pasted
    // straight onto `?amount=`, unchecked.
    //
    // A provider whose callback already carries a query — plenty do — got a malformed URL and the
    // zap failed for reasons nobody could see from the panel.
    reset();
    LNURL = { ...LIVE, callback: 'https://pay.example/cb?id=7&cur=sat' };
    await lnurlPay({ lud16: 'dev@example.com', amount: 21000, successMsg: 'x' });
    ok('a callback with its own query is not corrupted', fetches[1].startsWith('https://pay.example/cb?id=7&cur=sat&'), fetches[1]);
    ok('and still carries the amount', new URL(fetches[1]).searchParams.get('amount') === '21000', fetches[1]);

    // set(), not append(): a provider echoing its own amount must not end up with two.
    reset();
    LNURL = { ...LIVE, callback: 'https://pay.example/cb?amount=1' };
    await lnurlPay({ lud16: 'dev@example.com', amount: 21000, successMsg: 'x' });
    ok('an amount already in the callback is replaced, not doubled', new URL(fetches[1]).searchParams.getAll('amount').join() === '21000', fetches[1]);

    // Plaintext must not be accepted: the invoice says who gets paid, and over http it can be
    // swapped in transit for somebody else's.
    reset();
    LNURL = { ...LIVE, callback: 'http://pay.example/cb' };
    r = await lnurlPay({ lud16: 'dev@example.com', amount: 21000, successMsg: 'x' });
    ok('an http callback is refused', /insecure/i.test(msgs[0] || ''), msgs);
    ok('and no invoice is requested over it', fetches.length === 1, fetches);
    ok('and it does not report a payment', !r, r);

    // Anything else the provider might put there.
    for (const [label, cb] of [['a relative path', '/cb'], ['nonsense', 'not a url'], ['a javascript: URL', 'javascript:alert(1)'], ['nothing at all', undefined]]) {
        reset();
        LNURL = { ...LIVE, callback: cb };
        r = await lnurlPay({ lud16: 'dev@example.com', amount: 21000, successMsg: 'x' });
        const refused = fetches.length === 1 && !r;
        ok(`${label} as a callback is refused before any request`, refused, { msgs, fetches });
    }
    LNURL = LIVE;

    // The zap request still has to survive being built through URLSearchParams rather than pasted on.
    reset();
    await lnurlPay({ lud16: 'dev@example.com', pubkey: 'cc'.repeat(32), amount: 21000, successMsg: 'x' });
    const roundTripped = JSON.parse(new URL(fetches[1]).searchParams.get('nostr'));
    ok('the signed zap request survives the encoding intact', roundTripped.kind === 9734 && roundTripped.sig === 'ff', roundTripped);

    // A provider error must surface and must not look like a completed payment.
    reset();
    LNURL = { status: 'ERROR', reason: 'wallet offline' };
    r = await lnurlPay({ lud16: 'dev@example.com', amount: 21000, successMsg: 'x' });
    ok('provider error surfaced verbatim', msgs[0] === 'wallet offline', msgs);
    ok('provider error returns falsy', !r, r);
    ok('provider error stops before the invoice call', fetches.length === 1, fetches);

    return { name: 'zap / lnurl-pay', pass, fail };
}
