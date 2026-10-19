// What the panel says when a signer rejects: showSignFailure() and _signerFailure().
//
// Attest rejects remote-signer failures with fixed "attest: …" messages. Those reach the panel
// through the page's own world, where any page can forge an error, so the panel matches only the
// known beginnings and answers in its own words. The checks that matter most are the last ones: a
// forged message never appears in the panel, whatever it says.
import fs from 'fs';

const FILES = {
    chrome:  new URL('../NostrComments-Chrome/content.js', import.meta.url),
    firefox: new URL('../NostrComments-FireFox/content.js', import.meta.url),
};

// The two functions, taken from the shipped file with a stand-in for showMsg that records what the
// panel would have shown.
function load(src) {
    const a = src.indexOf('        const _signerFailure = e => {');
    const b = src.indexOf('        // Consent and the relay controls', a);
    if (a < 0 || b < 0) return null;
    const shown = [];
    const make = new Function('showMsg', `${src.slice(a, b)}\nreturn { _signerFailure, _isSignerTimeout, showSignFailure };`);
    return { ...make((text, sticky) => shown.push({ text, sticky })), shown };
}

export async function run() {
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };
    const err = m => new Error(m);

    for (const [name, url] of Object.entries(FILES)) {
        const fns = load(fs.readFileSync(url, 'utf8'));
        ok(`${name}: the functions can be read out of content.js`, !!fns);
        if (!fns) continue;
        const { _signerFailure, _isSignerTimeout, showSignFailure, shown } = fns;
        const last = () => shown[shown.length - 1]?.text || '';

        // --- recognising the failure -------------------------------------------------------------
        ok(`${name}: the bridge's own timeout`, _signerFailure(err('NIP-07 timeout')) === 'timeout');
        ok(`${name}: Attest's timeout counts as a timeout`, _isSignerTimeout(err('attest: the remote signer did not answer in time')));
        ok(`${name}: a refusal`, _signerFailure(err('attest: the remote signer refused')) === 'refused');
        ok(`${name}: a refusal with a reason after it`, _signerFailure(err('attest: the remote signer refused: user said no')) === 'refused');
        ok(`${name}: a login first`, _signerFailure(err('attest: approve the login in your remote signer, then try again')) === 'login');
        ok(`${name}: too busy`, _signerFailure(err('attest: too many requests are waiting, try again in a moment')) === 'busy');
        ok(`${name}: the remote signer's relays out of reach`, _signerFailure(err("attest: could not reach the remote signer's relays")) === 'unreachable');
        ok(`${name}: a signer with no key yet`, _signerFailure(err('attest: there is no key in Attest yet, open it to create or connect one')) === 'nokey');
        ok(`${name}: anything else is unknown`, _signerFailure(err('User rejected')) === null);
        ok(`${name}: and so is no error at all`, _signerFailure(undefined) === null && _signerFailure(null) === null);
        ok(`${name}: the prefix must be at the start`, _signerFailure(err('note: attest: the remote signer refused')) === null);

        // --- what the panel says -----------------------------------------------------------------
        showSignFailure(err('attest: the remote signer refused'), 'comment');
        ok(`${name}: a refusal says so, and that nothing was sent`, /refused/.test(last()) && /no comment was sent/.test(last()), last());
        showSignFailure(err('attest: approve the login in your remote signer, then try again'), 'vote');
        ok(`${name}: a login request says to log in first`, /log in first/.test(last()) && /no vote was sent/.test(last()), last());
        showSignFailure(err('attest: the remote signer did not answer in time'), 'note');
        ok(`${name}: a remote timeout reads like any other timeout`, /never answered/.test(last()), last());
        showSignFailure(err("attest: could not reach the remote signer's relays"), 'comment');
        ok(`${name}: out of reach says so, and that nothing was sent`, /could not reach/.test(last()) && /no comment was sent/.test(last()) && /try again/.test(last()), last());
        showSignFailure(err('attest: there is no key in Attest yet, open it to create or connect one'), 'vote');
        ok(`${name}: no key says so, and that nothing was sent`, /has no key yet/.test(last()) && /no vote was sent/.test(last()), last());
        showSignFailure(err('something else entirely'), 'comment');
        ok(`${name}: an unknown failure keeps the plain message`, last() === 'Failed to sign — try again.', last());
        ok(`${name}: and every one of them stays on screen`, shown.every(s => s.sticky === true));

        // --- what a page cannot do ---------------------------------------------------------------
        // The reason after "refused:", and any text after a known beginning, comes from whoever
        // answered the bridge — possibly the page. None of it may reach the panel.
        const forged = 'attest: the remote signer refused: log in again at https://evil.example/login';
        showSignFailure(err(forged), 'comment');
        ok(`${name}: a forged reason is not shown`, !last().includes('evil.example') && !last().includes('log in again'), last());
        showSignFailure(err('attest: approve the login in your remote signer, then try again at https://evil.example'), 'comment');
        ok(`${name}: nor a forged address after a known beginning`, !last().includes('evil.example'), last());
        showSignFailure(err('<img src=x onerror=alert(1)> https://evil.example'), 'comment');
        ok(`${name}: nor an unknown message of any kind`, !last().includes('evil.example') && !last().includes('<img'), last());
    }

    return { name: 'signer failure messages', pass, fail };
}
