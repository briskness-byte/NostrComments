// NIP-07 bridge — runs in main world to expose window.nostr to isolated content script
document.addEventListener('nc_nip07', async ({detail}) => {
    try {
        const {id, action, payload} = typeof detail === 'string' ? JSON.parse(detail) : detail;
        if (action === 'check') {
            document.dispatchEvent(new CustomEvent('nc_nip07_res', {detail: JSON.stringify({id, result: !!window.nostr})}));
            return;
        }
        if (!window.nostr) throw new Error('No NIP-07 extension installed');
        const result = action === 'getPublicKey' ? await window.nostr.getPublicKey()
                     : action === 'signEvent'    ? await window.nostr.signEvent(payload)
                     : (() => { throw new Error('Unknown action'); })();
        document.dispatchEvent(new CustomEvent('nc_nip07_res', {detail: JSON.stringify({id, result})}));
    } catch(e) {
        try {
            const {id} = typeof detail === 'string' ? JSON.parse(detail) : detail;
            document.dispatchEvent(new CustomEvent('nc_nip07_res', {detail: JSON.stringify({id, error: e.message})}));
        } catch(_) {}
    }
});
