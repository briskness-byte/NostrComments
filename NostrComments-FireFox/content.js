
(() => {
    'use strict';

    let _bridgeInjected = false;
    if (!document.body) { document.addEventListener('DOMContentLoaded', init); return; }
    init().catch(e => console.error('[NostrComments]', e));

    async function init() {

        // Load all persistent storage up front (cross-origin, unlike localStorage)
        const _st = await chrome.storage.local.get(['nostrcomments_privkey','nostrcomments_relays','nostrcomments_muted','nostrcomments_disabled','nostrcomments_consent','nostrcomments_keybackup','nostrcomments_supporter','nostrcomments_lastseen','nostrcomments_mutewords','nostrcomments_signer','nostrcomments_nip05','nostrcomments_pwoffered','nostrcomments_backupasked','nostrcomments_btnpos','nostrcomments_relaymig','nostrcomments_widepublish','nostrcomments_theme']);
        let hasConsent = _st.nostrcomments_consent === true;
        let encPriv = _isEncPriv(_st.nostrcomments_privkey) ? _st.nostrcomments_privkey : null;
        let keyBackedUp = _st.nostrcomments_keybackup === true;
        let isSupporter = _st.nostrcomments_supporter === true;
        // 'local' | 'nip07' — which key signs. Null means: decide from what is available.
        let signerPref = _st.nostrcomments_signer === 'nip07' || _st.nostrcomments_signer === 'local' ? _st.nostrcomments_signer : null;
        // Per origin, so moving it out of the way on one site does not move it everywhere.
        const _btnPosAll = (_st.nostrcomments_btnpos && typeof _st.nostrcomments_btnpos === 'object') ? _st.nostrcomments_btnpos : {};
        let btnCorner = /^(tl|tr|bl|br)$/.test(_btnPosAll[location.origin]) ? _btnPosAll[location.origin] : 'br';
        const saveBtnCorner = () => { try { _btnPosAll[location.origin] = btnCorner; chrome.storage.local.set({nostrcomments_btnpos: _btnPosAll}); } catch(e) {} };
        if (Array.isArray(_st.nostrcomments_disabled) && _st.nostrcomments_disabled.includes(location.origin)) {
            const _reBtn = document.createElement('button');
            _reBtn.type = 'button';
            Object.assign(_reBtn.style, {border:'none',padding:'0',position:'fixed',right:'18px',bottom:'18px',width:'28px',height:'28px',background:'rgba(100,100,100,0.35)',borderRadius:'50%',cursor:'pointer',zIndex:'2147483647',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'14px',opacity:'0.4',userSelect:'none',transition:'opacity .2s'});
            _reBtn.title = 'NostrComments is disabled on this site — click to re-enable';
            _reBtn.textContent = '💬';
            _reBtn.onmouseenter = () => _reBtn.style.opacity = '1';
            _reBtn.onmouseleave = () => _reBtn.style.opacity = '0.4';
            _reBtn.onclick = async () => {
                const _d = await chrome.storage.local.get('nostrcomments_disabled');
                const arr = (Array.isArray(_d.nostrcomments_disabled) ? _d.nostrcomments_disabled : []).filter(o => o !== location.origin);
                await chrome.storage.local.set({nostrcomments_disabled: arr});
                _reBtn.remove();
                init();
            };
            // In a shadow root, like the main button and for the same reason — but this one
            // matters more. If a site hides it, there is nothing left on that site to click: the
            // panel does not exist while the extension is disabled, and the per-site list is only
            // reachable from the panel on the site it applies to. A page could make itself
            // permanently un-re-enable-able. Found while reviewing the fix that moved the main
            // button, which had missed this one.
            const _reHost = document.createElement('div');
            document.documentElement.appendChild(_reHost);
            _reHost.attachShadow({mode:'open'}).appendChild(_reBtn);
            return;
        }

        // Inject NIP-07 bridge into main world (once per page load, guarded against re-enable re-injection)
        if (!_bridgeInjected) {
            try { const _bs=document.createElement('script'); _bs.src=chrome.runtime.getURL('injected.js'); document.documentElement.appendChild(_bs); _bs.remove(); } catch(e) {}
            _bridgeInjected = true;
        }

        // Minimal secp256k1 + BIP-340 Schnorr for local keypair generation
        const _secp = (() => {
            const P=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
            const N=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
            const G=[0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
                     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n];
            const m=(a,b=P)=>((a%b)+b)%b;
            const inv=a=>{a=m(a);let old_r=a,r=P,old_s=1n,s=0n;while(r!==0n){const q=old_r/r;[old_r,r]=[r,old_r-q*r];[old_s,s]=[s,old_s-q*s];}return m(old_s);};
            const pa=(A,B)=>{
                if(!A)return B;if(!B)return A;
                const[ax,ay]=A,[bx,by]=B;
                if(ax===bx){if(ay!==by)return null;const l=m(3n*ax*ax*inv(2n*ay));const x=m(l*l-2n*ax);return[x,m(l*(ax-x)-ay)];}
                const l=m((by-ay)*inv(bx-ax));const x=m(l*l-ax-bx);return[x,m(l*(ax-x)-ay)];
            };
            const pm=(k,Pt)=>{let R=null,Q=Pt;while(k>0n){if(k&1n)R=pa(R,Q);Q=pa(Q,Q);k>>=1n;}return R;};
            const h2b=h=>{const b=new Uint8Array(h.length/2);for(let i=0;i<h.length;i+=2)b[i/2]=parseInt(h.slice(i,i+2),16);return b;};
            const b2h=b=>Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');
            const n2h=(n,l=32)=>n.toString(16).padStart(l*2,'0');
            const h2n=h=>BigInt('0x'+h);
            const sha=async(...a)=>{const c=new Uint8Array(a.reduce((s,b)=>s+b.length,0));let o=0;for(const b of a){c.set(b,o);o+=b.length;}return new Uint8Array(await crypto.subtle.digest('SHA-256',c));};
            const th=async(tag,...ms)=>{const t=await sha(new TextEncoder().encode(tag));return sha(t,t,...ms);};
            const mpow=(b,e,n)=>{let r=1n;b=((b%n)+n)%n;while(e>0n){if(e&1n)r=r*b%n;b=b*b%n;e>>=1n;}return r;};
            const liftX=x=>{const y2=m(x*x*x+7n);const y=mpow(y2,(P+1n)/4n,P);return m(y*y)===y2?[x,y%2n===0n?y:P-y]:null;};
            const verify=async(pubHex,msgBytes,sigHex)=>{try{const r=h2n(sigHex.slice(0,64)),s=h2n(sigHex.slice(64));if(r>=P||s>=N)return false;const Pt=liftX(h2n(pubHex));if(!Pt)return false;const e=m(h2n(b2h(await th('BIP0340/challenge',h2b(n2h(r)),h2b(pubHex),msgBytes))),N);const R=pa(pm(s,G),pm(N-e,Pt));return!!R&&R[1]%2n===0n&&R[0]===r;}catch(_){return false;}};
            const pubKey=priv=>n2h(pm(h2n(priv),G)[0]);
            const sign=async(priv,msg)=>{
                const privBig=h2n(priv),Pt=pm(privBig,G);
                const pk=Pt[1]%2n!==0n?m(N-privBig,N):privBig;
                const pub=h2b(n2h(Pt[0]));
                const aux=crypto.getRandomValues(new Uint8Array(32));
                const t=pk^h2n(b2h(await th('BIP0340/aux',aux)));
                const rand=await th('BIP0340/nonce',h2b(n2h(t)),pub,msg);
                let k=m(h2n(b2h(rand)),N);if(k===0n)throw new Error('bad nonce');
                const R=pm(k,G);if(R[1]%2n!==0n)k=N-k;
                const rx=h2b(n2h(R[0]));
                const e=m(h2n(b2h(await th('BIP0340/challenge',rx,pub,msg))),N);
                return b2h(rx)+n2h(m(k+pk*e,N));
            };
            return{pubKey,sign,b2h,verify};
        })();

        async function makeLocalWallet(privHex) {
            const pubHex=_secp.pubKey(privHex);
            const enc=new TextEncoder();
            return {
                getPublicKey:()=>Promise.resolve(pubHex),
                signEvent:async ev=>{
                    const serial=JSON.stringify([0,pubHex,ev.created_at,ev.kind,ev.tags,ev.content]);
                    const idBytes=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(serial)));
                    const id=_secp.b2h(idBytes);
                    const sig=await _secp.sign(privHex,idBytes);
                    return{...ev,id,sig,pubkey:pubHex};
                }
            };
        }

        // Optional passphrase encryption of the local private key at rest (WebCrypto
        // PBKDF2 -> AES-GCM). When set, storage holds {v,salt,iv,ct} instead of plain hex.
        // Reading comments never needs the key, so it's only decrypted when the user posts.
        const _b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
        const _unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
        function _isEncPriv(v) { return !!v && typeof v === 'object' && v.v === 1 && typeof v.ct === 'string'; }
        async function _deriveKey(pass, salt) {
            const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
            return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        }
        async function _encryptPriv(privHex, pass) {
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const key = await _deriveKey(pass, salt);
            const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(privHex));
            return { v: 1, salt: _b64(salt), iv: _b64(iv), ct: _b64(ct) };
        }
        async function _decryptPriv(enc, pass) {
            const key = await _deriveKey(pass, _unb64(enc.salt));
            const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _unb64(enc.iv) }, key, _unb64(enc.ct));
            return new TextDecoder().decode(pt);
        }

        // --- Event verification (NIP-01 id + BIP-340 Schnorr sig) ---
        // Incoming relay events are untrusted: a relay can forge authorship or votes unless we
        // check that ev.id === sha256(serialization) AND the Schnorr signature is valid.
        // Verification is pure-JS and expensive, so results are cached per id and the work is
        // serialized with a yield between events to keep the tab responsive under a burst.
        const _verifyCache = new Map(); // id -> boolean | Promise<boolean>
        async function verifyEvent(ev) {
            if (!ev || typeof ev.id !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.id)) return false;
            if (typeof ev.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.pubkey)) return false;
            if (typeof ev.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(ev.sig)) return false;
            const hit = _verifyCache.get(ev.id);
            if (hit !== undefined) return hit;
            const pr = (async () => {
                try {
                    const serial = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
                    const idBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serial)));
                    if (_secp.b2h(idBytes) !== ev.id.toLowerCase()) return false;
                    return await _secp.verify(ev.pubkey, idBytes, ev.sig);
                } catch(_) { return false; }
            })();
            _verifyCache.set(ev.id, pr);
            const ok = await pr;
            _verifyCache.set(ev.id, ok);
            return ok;
        }
        // Serialized verification queue — one event at a time, yielding after each so a flood of
        // relay events can't lock up the page. onValid runs only for events that verify.
        const _seenEv = new Set();
        let _vq = Promise.resolve();
        // The seen-set belongs to a purpose, not to the extension. A reply to you on the page you
        // are reading matches both subscriptions — it carries your p tag and the page's r tag — so
        // whichever socket delivered it first used to mark it seen for the other, and the thread
        // then skipped it entirely: the badge counted a reply that never appeared. The thread's set
        // is also cleared on every page load, which a session-long notification sub must not be.
        function queueVerify(ev, onValid, seen = _seenEv) {
            if (!ev || typeof ev.id !== 'string' || seen.has(ev.id)) return;
            seen.add(ev.id);
            _vq = _vq.then(async () => {
                const ok = await verifyEvent(ev);
                if (ok) { try { onValid(); } catch(_) {} }
                await new Promise(r => setTimeout(r, 0));
            });
        }

        function toBech32(hrp, hex) {
            const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
            const GEN = [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];
            const pm = v => { let c=1; for (const d of v){const t=c>>25;c=(c&0x1ffffff)<<5^d;for(let i=0;i<5;i++)if((t>>i)&1)c^=GEN[i];} return c; };
            const ex = h => [...h].map(c=>c.charCodeAt(0)>>5).concat(0,...[...h].map(c=>c.charCodeAt(0)&31));
            const bytes = hex.match(/.{2}/g).map(b=>parseInt(b,16));
            const w=[]; let acc=0,bits=0;
            for(const b of bytes){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;w.push((acc>>bits)&31);}}
            if(bits)w.push((acc<<(5-bits))&31);
            const chk=pm([...ex(hrp),...w,0,0,0,0,0,0])^1;
            return hrp+'1'+[...w,...Array.from({length:6},(_,i)=>(chk>>(5*(5-i)))&31)].map(d=>CS[d]).join('');
        }
        // bech32 → hex, for importing an existing identity. The checksum is verified: without it a
        // mistyped nsec would silently decode to a different, valid-looking key and the user would
        // end up posting as an identity nobody knows, with no error to tell them why.
        function fromBech32(expectedHrp, str) {
            const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
            const GEN = [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];
            const pm = v => { let c=1; for (const d of v){const t=c>>25;c=(c&0x1ffffff)<<5^d;for(let i=0;i<5;i++)if((t>>i)&1)c^=GEN[i];} return c; };
            const ex = h => [...h].map(c=>c.charCodeAt(0)>>5).concat(0,...[...h].map(c=>c.charCodeAt(0)&31));
            const s = String(str||'').trim().toLowerCase();
            if (!s.startsWith(expectedHrp + '1')) return null;
            const vals = [];
            for (const ch of s.slice(expectedHrp.length + 1)) { const v = CS.indexOf(ch); if (v < 0) return null; vals.push(v); }
            if (vals.length < 7 || pm([...ex(expectedHrp), ...vals]) !== 1) return null;
            let acc = 0, bits = 0; const out = [];
            for (const v of vals.slice(0, -6)) { acc = (acc<<5)|v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc>>bits)&0xff); } }
            if (out.length !== 32) return null;
            return out.map(b => b.toString(16).padStart(2,'0')).join('');
        }

        const toNpub = hex => toBech32('npub', hex);
        const toNote = hex => toBech32('note', hex);
        const toNsec = hex => toBech32('nsec', hex);

        function timeAgo(ts) {
            const s = Math.floor(Date.now()/1000) - ts;
            if (s < 60) return 'just now';
            if (s < 3600) return `${Math.floor(s/60)}m ago`;
            if (s < 86400) return `${Math.floor(s/3600)}h ago`;
            if (s < 86400*30) return `${Math.floor(s/86400)}d ago`;
            return new Date(ts*1000).toLocaleDateString();
        }

        // Shadow DOM: the panel and the button both live in here.
        const host = document.createElement('div');
        document.documentElement.appendChild(host);
        const s = host.attachShadow({mode:'open'});

        // Floating button — in the shadow root, not the page.
        //
        // It used to hang in the light DOM, and the host page's own CSS reached it: a plain
        // `span{position:static !important}` folded both badges into the middle of the button with
        // the notification one on the right, and `span[id]{display:none}` removed the comment count
        // altogether. Neither is an attack; they are the kind of rule ordinary sites carry, which is
        // why the button looked different from one site to the next. The panel was already isolated
        // this way — the button had simply never been given the same treatment.
        const btn = document.createElement('button');
        btn.appendChild(new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24"><path fill-rule="evenodd" fill="white" d="M4 2h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7l-5 5V4a2 2 0 0 1 2-2z M6.6 9.5a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0z M10.6 9.5a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0z M14.6 9.5a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0z"/></svg>', 'image/svg+xml').documentElement);
        btn.id = 'nc-btn';
        btn.classList.add('nc-' + btnCorner);
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Open NostrComments');
        btn.onmouseenter = () => btn.classList.add('nc-hover');
        btn.onmouseleave = () => btn.classList.remove('nc-hover');
        const badge = document.createElement('span');
        badge.id = 'nc-badge';
        // Inline, because inline beats anything the page can throw at it — that is the whole point
        // of browser-buttoncss. It also beats the #nc-badge rule in _cssText, so the two have to be
        // changed together: editing only the stylesheet does nothing at all, which is exactly what
        // happened when the button was shrunk and these were left behind.
        Object.assign(badge.style, {position:'absolute',top:'-5px',right:'-5px',background:'#e53935',color:'white',borderRadius:'10px',fontSize:'11px',fontWeight:'bold',padding:'1px 5px',minWidth:'16px',textAlign:'center',display:'none',fontFamily:'system-ui,sans-serif',lineHeight:'1.45',pointerEvents:'none'});
        btn.appendChild(badge);
        const nBadge = document.createElement('span');
        nBadge.id = 'nc-nbadge';
        Object.assign(nBadge.style, {position:'absolute',top:'-5px',left:'-5px',background:'#f59e0b',color:'white',borderRadius:'10px',fontSize:'11px',fontWeight:'bold',padding:'1px 5px',minWidth:'16px',textAlign:'center',display:'none',fontFamily:'system-ui,sans-serif',lineHeight:'1.45',pointerEvents:'none'});
        btn.appendChild(nBadge);
        s.appendChild(btn);


        const _cssText = `
        #m{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.94);z-index:2147483647;place-items:center;font-family:system-ui,sans-serif;overflow:hidden}
        #p{background:#fff;width:95%;max-width:740px;max-height:92vh;overflow-y:auto;overflow-x:hidden;border-radius:16px;padding:16px 18px;box-sizing:border-box;position:relative;box-shadow:0 20px 60px rgba(0,0,0,0.6);color:#222}
        #c{position:absolute;top:12px;right:16px;width:50px;height:50px;font-size:40px;background:none;border:none;cursor:pointer;color:#555;display:flex;align-items:center;justify-content:center}
        #gear-btn{position:absolute;top:16px;left:16px;width:auto;height:40px;font-size:14px;padding:0 12px;background:none;border:none;cursor:pointer;color:#767676;display:flex;align-items:center;justify-content:center;border-radius:8px;gap:6px;transition:background .15s,color .15s}
        #gear-btn:hover{background:#f0f0f0;color:#555}
        #gear-btn.active{background:#e8f0fe;color:#1d9bf0}
        #theme-btn{position:absolute;top:15px;right:68px;width:36px;height:36px;font-size:20px;background:none;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:8px;opacity:0.6;color:#555}
        #theme-btn:hover{background:#f0f0f0;opacity:1}
        h2{color:#1d9bf0;margin:0 0 12px;text-align:center;font-size:22px;font-weight:600}
        #settings{display:none;background:#eef1f5;border:1px solid #dde2e8;border-radius:14px;padding:18px;margin:0 0 20px}
        #settings-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:2px}
        #settings-close{background:none;border:1px solid #d5d9e0;cursor:pointer;font-size:13px;font-weight:600;color:#666;padding:5px 12px;border-radius:8px;line-height:1;font-family:inherit;transition:color .15s,border-color .15s}
        #settings-close:hover{color:#222;border-color:#9aa2ad}
        #settings strong{font-size:16px;color:#333}
        #relay-list{margin:10px 0}
        .relay-item{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:white;border-radius:8px;margin:5px 0;font-size:14px;color:#444;border:1px solid #eee}
        .relay-remove{background:none;border:none;color:#c62828;cursor:pointer;font-size:18px;padding:0 4px;line-height:1}
        .relay-url{display:block}
        .relay-state{display:block;font-size:11px;margin-top:2px;color:#8a8a8a;cursor:help}
        /* Settings hints. #666 measures 3.40:1 on the dark panel background, under the 4.5:1 AA
           floor — the older inline ones still do, and browser-qa does not reach into this panel to
           notice. New text at least goes in with a class that has both themes. */
        .nc-hint{font-size:13px;color:#666;margin:6px 0 0}
        .relay-state.answered{color:#2e7d32}
        .relay-state.failed,.relay-state.unreachable,.relay-state.blocked{color:#c62828}
        #relay-add,#muteword-add{display:flex;gap:8px;margin-top:10px}
        #relay-input,#muteword-input{flex:1;padding:10px 14px;border:1px solid #ddd;border-radius:10px;font-size:14px}
        #relay-add-btn,#muteword-add-btn{padding:10px 16px;background:#0c75bc;color:white;border:none;border-radius:10px;cursor:pointer;font-weight:600;font-size:14px}
        #controls{display:flex;flex-direction:column;gap:8px;margin:10px 0}
        #connect,#send,#loadMore{padding:12px 16px;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer}
        /* Blue that carries white text. Darker than the brand blue on purpose: white on #1d9bf0 is
           3.00:1, under the 4.5:1 AA floor, and every primary action here is a white label on that
           colour. #0c75bc is the same hue (204) and saturation (88%), fourteen points darker — the
           lightest value in that family where white clears 4.5:1 (4.90) and the pale onboarding
           background does too (4.54).

           The floating button keeps the vivid gradient. It carries an icon, not text, so the bar is
           3:1 for a graphical object, which the original meets — and it is the one element whose
           job is to be noticed on somebody else's page.

           Blue *text* is a different problem, not solved here: #1d9bf0 fails on light (3.00) and
           #0c75bc fails on dark (3.62), so no single value serves both themes. That needs a token
           per theme rather than a darker constant. */
        #connect,#send{background:#0c75bc;color:white;border:none}
        #loadMore{background:#0d8bf0;color:white;border:none;display:none}
        input,select,textarea{padding:10px 14px;border:1px solid #ddd;border-radius:12px;font-size:15px}
        #input-wrapper{position:relative;margin:12px 0}
        #input{width:100%;min-height:88px;padding:14px 14px 46px;border:2px solid #e2e8f0;border-radius:14px;font-size:15px;background:#fafbfc;resize:none;box-sizing:border-box}
        #send{position:absolute;bottom:10px;right:10px;padding:10px 24px;border-radius:10px}
        #pagekey{display:none;font-size:12px;color:#5b5b60;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:6px 10px;margin:10px 0 0;cursor:help;overflow-wrap:anywhere}
        #list{max-height:40vh;overflow-y:auto;background:#f8f9fa;padding:12px;border-radius:14px;margin:10px 0}
        .c{background:white;padding:14px;margin:8px 0;border-radius:12px;border-left:5px solid #1d9bf0;box-shadow:0 2px 8px rgba(0,0,0,0.07);color:#222;word-break:break-word}
        .c.reply{margin-left:28px;border-left:4px solid #90caf9}
        .v{font-size:13px;background:#eef2f7;border:1px solid #d0d9e8;cursor:pointer;padding:4px 10px;border-radius:20px;color:#444;font-weight:700;min-width:0}
        .v:hover{background:#dbeafe;border-color:#93c5fd;color:#1d9bf0}
        .v.mine{background:#dbeafe;border-color:#1d9bf0;color:#0b5c8f}
        .v.mine.down{background:#fde8e8;border-color:#c62828;color:#a01c1c}
        .reply-btn{font-size:14px;background:none;border:none;cursor:pointer;padding:6px 10px;color:#1d9bf0;font-weight:600}
        .h{opacity:0.5;font-style:italic;cursor:pointer;padding:30px;background:#f0f0f0;border-radius:16px;text-align:center;font-size:18px}
        .tomb{font-style:italic;background:#f3f4f6;color:#5b616e;border-left-color:#c9ced6;box-shadow:none;font-size:14px}
        #reply-indicator{display:none;background:#e8f4fd;border-radius:10px;padding:10px 14px;margin:8px 0;font-size:14px;color:#1d9bf0;align-items:center;justify-content:space-between;gap:10px}
        #reply-hint{display:none;font-size:12px;color:#5b7c95;margin-top:3px}
        #reply-cancel{background:none;border:none;color:#1d9bf0;cursor:pointer;font-weight:600;font-size:18px}
        #msg{display:none;position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:88vw;z-index:40;background:#0c75bc;color:white;padding:12px 18px;border-radius:12px;text-align:center;font-size:16px;box-shadow:0 6px 24px rgba(0,0,0,.28)}
        #onboard{display:none;background:#f0f7ff;border-radius:14px;padding:16px 18px;margin:0 0 12px}
        .ob-title{font-size:17px;font-weight:700;color:#1d9bf0;margin:0 0 8px}
        .ob-pitch{font-size:13px;line-height:1.6;color:#555;margin:0 0 12px}
        .ob-primary{display:block;width:100%;padding:13px;background:linear-gradient(135deg,#0c75bc,#0a68ad);color:white;border:none;border-radius:10px;cursor:pointer;font-size:15px;font-weight:700;margin-bottom:10px;letter-spacing:0.01em}
        .ob-primary:hover{opacity:0.92}
        .ob-or{text-align:center;font-size:13px;color:#717171;margin:0 0 10px}
        .ob-secondary{display:block;width:100%;padding:12px;background:none;border:1px solid #0c75bc;border-radius:10px;color:#0c75bc;cursor:pointer;font-size:14px;font-weight:600;margin-bottom:10px;font-family:inherit}
        .ob-wallets{display:flex;gap:8px}
        .ob-wallet{flex:1;padding:10px;text-align:center;border:2px solid #1d9bf0;border-radius:10px;color:#1d9bf0;font-weight:600;font-size:14px;text-decoration:none}
        .ob-wallet:hover{background:#e8f4fd}
        .ob-hint{font-size:12px;color:#717171;text-align:center;margin:8px 0 0}
        #post-note{margin:8px 2px 0;font-size:11px;line-height:1.45;color:#6b6b6b;text-align:center}
        #m.dark-mode #post-note{color:#8b8b93}
        #donate{text-align:center;margin:14px 0 4px;font-size:13px;color:#666;border-top:1px solid #eee;padding-top:12px}
        #donate a{color:#b45309;text-decoration:none;font-weight:600}
        #donate a:hover{text-decoration:underline}
        #donate-head{font-size:14px;font-weight:700;color:#b45309}
        #donate-row{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}
        #donate-toggle{background:none;border:none;cursor:pointer;color:#b45309;font-size:15px;line-height:1;padding:4px 8px;font-family:inherit;border-radius:8px}
        #donate-toggle:hover{background:#fdf1e3}
        #donate-body{display:none;margin-top:12px}
        #donate-pitch{margin:0 0 10px;font-size:13px;line-height:1.5}
        #donate-amounts{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
        .donate-amt{padding:7px 14px;background:none;border:1px solid #b45309;color:#b45309;border-radius:999px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit}
        .donate-amt:hover{background:#b45309;color:white}
        .donate-amt:disabled{opacity:.5;cursor:default}
        #donate-custom{display:none;gap:8px;justify-content:center;margin-top:8px}
        #donate-custom input{width:110px;padding:7px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:inherit}
        #donate-note{margin:10px 0 0;font-size:11px;line-height:1.45;color:#6b6b6b}
        #m.dark-mode #donate{border-top-color:#27272a}
        #m.dark-mode #donate a{color:#f7931a}
        #m.dark-mode #donate-head{color:#f7931a}
        #m.dark-mode #donate-toggle{color:#f7931a}
        #m.dark-mode #donate-toggle:hover{background:#27272a}
        #m.dark-mode .donate-amt{border-color:#f7931a;color:#f7931a}
        #m.dark-mode .donate-amt:hover{background:#f7931a;color:#18181b}
        #m.dark-mode #donate-custom input{background:#27272a;border-color:#3f3f46;color:#e4e4e7}
        #m.dark-mode #donate-note{color:#8b8b93}
        @media(min-width:768px){#controls{flex-direction:row;align-items:center}#search{width:260px}}
        .c a{color:#1d9bf0;text-decoration:none}
        .c a:hover{text-decoration:underline}
        .c code{background:#f0f4f8;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:15px;color:#d63384}
        .zap-btn{font-size:20px;background:none;border:none;cursor:pointer;padding:6px 10px;color:#f59e0b}
        .zap-btn:hover{color:#d97706}
        .del-btn{font-size:13px;background:none;border:none;cursor:pointer;padding:6px 10px;color:#bbb}
        .del-btn:hover{color:#c62828}
        .del-btn.armed{color:#c62828;font-weight:700}
        .del-btn:disabled{opacity:.5;cursor:default}
        .mute-btn{font-size:13px;background:none;border:none;cursor:pointer;padding:6px 10px;color:#bbb}
        .mute-btn:hover{color:#c62828}
        .copy-btn{font-size:16px;background:none;border:none;cursor:pointer;padding:6px 10px;color:#bbb}
        .copy-btn:hover{color:#555}
        /* Grey rather than another colour — a note is context, not a warning, and the three blues
           already mean comment, reply and yours. .own is declared after it so green still wins:
           until replies to notes existed you could never have a note of your own, and now that you
           can, "this one is mine" is what you scan for. The chip still says it is a note. */
        .c.nc-note{border-left-color:#a1a1aa;background:#fafafa}
        .c.own{border-left-color:#2e7d32}
        #muted-section{display:none;margin-top:14px}
        .muted-item{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:white;border-radius:8px;margin:5px 0;font-size:14px;color:#444;border:1px solid #eee}
        .unmute-btn{background:none;border:none;color:#1d9bf0;cursor:pointer;font-size:13px;font-weight:600}
        #notif-banner{display:none;background:#f59e0b;color:white;border-radius:12px;padding:10px 16px;margin:0 0 12px;font-size:15px;font-weight:600;text-align:center}
        .avatar{width:38px;height:38px;border-radius:50%;object-fit:cover;flex-shrink:0;background:#e8f4fd}
        .ts{color:#888}
        .nc-newtag{font-size:11px;font-weight:700;color:#f59e0b;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:1px 7px;margin-left:2px}
        .nc-notetag{font-size:11px;font-weight:700;color:#6b6b70;background:#f4f4f5;border:1px solid #d4d4d8;border-radius:10px;padding:1px 7px;margin-left:2px;cursor:help;font-family:inherit;line-height:1.5}
        .reply-btn.muted{opacity:.55}
        #m.dark-mode #p{background:#18181b;color:#e4e4e7}
        #m.dark-mode h2{color:#93c5fd}
        #m.dark-mode #pagekey{color:#a1a1aa;background:#1c1c1f;border-color:#3f3f46}
        #m.dark-mode #list{background:#09090b}
        #m.dark-mode .c{background:#27272a;box-shadow:none;color:#e4e4e7;border-left-color:#3b82f6}
        #m.dark-mode .c.own{border-left-color:#4ade80}
        #m.dark-mode .c.nc-note{border-left-color:#71717a;background:#1f1f23}
        #m.dark-mode .c.reply{border-left-color:#60a5fa}
        #m.dark-mode #settings{background:#0c0c0e;border-color:#2a2a30}
        #m.dark-mode #settings strong{color:#e4e4e7}
        #m.dark-mode .relay-item,#m.dark-mode .muted-item{background:#27272a;border-color:#3f3f46;color:#e4e4e7}
        #m.dark-mode .relay-state{color:#a1a1aa}
        #m.dark-mode .nc-hint{color:#a1a1aa}
        #m.dark-mode .relay-state.answered{color:#4ade80}
        #m.dark-mode .relay-state.failed,#m.dark-mode .relay-state.unreachable,#m.dark-mode .relay-state.blocked{color:#f87171}
        #m.dark-mode input,#m.dark-mode select,#m.dark-mode textarea{background:#27272a;border-color:#3f3f46;color:#e4e4e7}
        #m.dark-mode #input{background:#1c1c1f;border-color:#3f3f46;color:#e4e4e7}
        #m.dark-mode #onboard{background:#1a2540}
        #m.dark-mode .ob-title{color:#60a5fa}
        #m.dark-mode .ob-pitch{color:#c4c4ce}
        #m.dark-mode .ob-or{color:#8c8c8c}
        #m.dark-mode .ob-secondary{border-color:#3b82f6;color:#93c5fd}
        #m.dark-mode .ob-wallet{border-color:#3b82f6;color:#93c5fd;background:#111827}
        #m.dark-mode .ob-wallet:hover{background:#1e3a5f}
        #m.dark-mode .ob-hint{color:#8c8c8c}
        #m.dark-mode .h{background:#27272a;color:#71717a}
        #m.dark-mode .tomb{background:#1c1c1f;color:#a1a1aa;border-left-color:#3f3f46}
        #m.dark-mode #reply-indicator{background:#1c2d40;color:#93c5fd}
        #m.dark-mode #reply-hint{color:#94b4cd}
        #m.dark-mode #donate{color:#a1a1aa}
        #m.dark-mode .c code{background:#3f3f46;color:#f9a8d4}
        #m.dark-mode #privkey-display{background:#27272a;border-color:#3f3f46;color:#a1a1aa}
        #m.dark-mode #gear-btn{color:#818181}
        #m.dark-mode #gear-btn:hover{background:#27272a;color:#e4e4e7}
        #m.dark-mode #gear-btn.active{background:#1a2535;color:#60a5fa}
        #m.dark-mode #settings-close{color:#a1a1aa;border-color:#3f3f46}
        #m.dark-mode #settings-close:hover{color:#e4e4e7;border-color:#71717a}
        #m.dark-mode #theme-btn{color:#f59e0b}
        #m.dark-mode #theme-btn:hover{background:#27272a;opacity:1}
        #m.dark-mode #c{color:#a1a1aa}
        #m.dark-mode .avatar{background:#27272a}
        #m.dark-mode .ts{color:#a1a1aa}
        #m.dark-mode .nc-newtag{color:#fbbf24;background:#3a2e13;border-color:#5c4718}
        #m.dark-mode .nc-notetag{color:#a1a1aa;background:#2e2e33;border-color:#3f3f46}
        #m.dark-mode .copy-btn{color:#71717a}
        #m.dark-mode .copy-btn:hover{color:#e4e4e7}
        #m.dark-mode .del-btn{color:#71717a}
        #m.dark-mode .del-btn:hover,#m.dark-mode .del-btn.armed{color:#f87171}
        #m.dark-mode .mute-btn:hover{color:#f87171}
        #m.dark-mode .v{background:#2a2a35;border-color:#4a4a5a;color:#c4c4ce}
        #m.dark-mode .v:hover{background:#1e3a5f;border-color:#3b82f6;color:#60a5fa}
        #m.dark-mode .v.mine{background:#1e3a5f;border-color:#3b82f6;color:#93c5fd}
        #m.dark-mode .v.mine.down{background:#3b1f1f;border-color:#ef4444;color:#fca5a5}
        .nc-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
        .nc-plink{display:flex;align-items:center;gap:8px;text-decoration:none}
        .nc-name{font-weight:600;color:#1d9bf0}
        .nc-nip05{color:#2e7d32;font-weight:700;font-size:13px;cursor:help}
        .nc-body{margin:12px 0;font-size:17px;line-height:1.6}
        .nc-actions{margin-top:12px}
        .nc-img{max-width:100%;border-radius:10px;margin:8px 0;display:block;cursor:pointer}
        .nc-vid{max-width:100%;border-radius:10px;margin:8px 0;display:block}
        #nc-btn{border:0;padding:0;position:fixed;width:48px;height:48px;background:linear-gradient(135deg,#1d9bf0,#0d8bf0);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483647;box-shadow:0 6px 18px rgba(29,155,240,0.45);transition:transform .25s ease;user-select:none}
        /* Bottom right is the most contested corner on the web — every support chat widget defaults
           there, along with back-to-top buttons and cookie bars. So the corner is a per-site choice
           rather than an assumption, and bottom left is the escape hatch, which is nearly always
           empty. The offsets live in classes so exactly one of them is ever applied. */
        #nc-btn.nc-br{right:18px;bottom:18px}
        #nc-btn.nc-bl{left:18px;bottom:18px}
        #nc-btn.nc-tr{right:18px;top:18px}
        #nc-btn.nc-tl{left:18px;top:18px}
        #nc-btn.nc-hover{transform:scale(1.12)}
        /* Sized against the button, not against nothing: the two badges sit at opposite top
           corners, so on a 48px button they have to be small enough not to meet in the middle.
           They fitted at 68px and browser-buttoncss caught them touching at 48. */
        #nc-badge,#nc-nbadge{position:absolute;border-radius:10px;font-size:11px;font-weight:bold;padding:1px 5px;min-width:16px;text-align:center;display:none;font-family:system-ui,sans-serif;line-height:1.45;pointer-events:none}
        #nc-badge{top:-5px;right:-5px;background:#e53935;color:white}
        #nc-nbadge{top:-5px;left:-5px;background:#f59e0b;color:white}
        .nc-empty{color:#727272;font-size:18px}
        /* Set by class, not inline: an inline colour cannot be overridden per theme, which is how
           "Not connected" ended up at 3.15:1 on the dark panel. */
        #m.dark-mode .nc-empty{color:#8c8c8c}
        #status.ok{color:#2e7d32}
        #status.err{color:#c62828}
        #m.dark-mode #status.ok{color:#4ade80}
        #m.dark-mode #status.err{color:#f87171}
        #m.dark-mode .nc-name{color:#93c5fd}
        #m.dark-mode .nc-nip05{color:#4ade80}
        `;
        try {
            const _ss = new CSSStyleSheet();
            _ss.replaceSync(_cssText);
            s.adoptedStyleSheets = [_ss];
        } catch(e) {
            const _style = document.createElement('style');
            _style.textContent = _cssText;
            s.appendChild(_style);
        }

        const _tpl = new DOMParser().parseFromString(`<html><body>
        <div id="m"><div id="p" role="dialog" aria-modal="true" aria-label="NostrComments">
        <button id="gear-btn">⚙ Settings</button>
        <button id="theme-btn" aria-label="Toggle dark mode">☽</button>
        <button id="c" aria-label="Close">×</button>
        <h2>NostrComments</h2>
        <div id="settings">
        <div id="settings-header"><strong>Settings</strong><button id="settings-close" title="Back to the comments">← Back</button></div>
        <div id="relay-list"></div>
        <div id="relay-add">
        <input id="relay-input" placeholder="wss://relay.example.com">
        <button id="relay-add-btn">Add</button>
        </div>
        <label id="widepub-label" style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;cursor:pointer"><input type="checkbox" id="widepub-toggle" style="width:16px;height:16px;flex:none;margin:0"><span>Also send what you post to three extra relays, so one relay removing it is not the end of it. They are never read from.</span></label>
        <div id="identity-section">
        <hr style="margin:14px 0;border:none;border-top:1px solid #eee">
        <strong style="font-size:15px;color:#333">Your identity</strong>
        <p style="font-size:13px;color:#666;margin:6px 0 8px">This is the public half — the name people see. Safe to share anywhere.</p>
        <div id="identity-card" style="display:flex;align-items:center;gap:10px;margin:8px 0 0">
        <img id="identity-avatar" alt="" style="width:34px;height:34px;border-radius:50%;object-fit:cover;background:#e8e8e8;display:none;flex:none">
        <div style="min-width:0;flex:1">
        <div id="identity-name" style="font-weight:600;font-size:14px;color:#1d9bf0"></div>
        <div id="identity-npub" style="font-size:11px;font-family:monospace;color:#666;word-break:break-all"></div>
        <div id="identity-hex" style="font-size:11px;font-family:monospace;color:#666;word-break:break-all;display:none"></div>
        </div>
        </div>
        <div id="setname-row" style="display:none;margin:10px 0 0">
        <p id="setname-lead" style="font-size:13px;color:#666;margin:0 0 6px"></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="setname-input" maxlength="40" placeholder="A name people will see" style="flex:1;min-width:160px;padding:9px 12px;border:2px solid #e2e8f0;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit">
        <button id="setname-btn" style="padding:9px 14px;background:#0c75bc;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;font-family:inherit">Publish name</button>
        </div>
        <p style="font-size:12px;color:#8a8a8a;margin:6px 0 0">Public, like your comments. Any Nostr app can change it later, and so can this one.</p>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button id="identity-copy-npub" style="padding:6px 12px;background:none;border:1px solid #1d9bf0;color:#1d9bf0;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Copy npub</button>
        <button id="identity-hex-toggle" style="padding:6px 12px;background:none;border:1px solid #bbb;color:#666;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Show hex</button>
        <button id="identity-copy-hex" style="padding:6px 12px;background:none;border:1px solid #bbb;color:#666;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;display:none">Copy hex</button>
        </div>
        </div>
        <div id="keypair-section" style="display:none">
        <hr style="margin:14px 0;border:none;border-top:1px solid #eee">
        <strong style="font-size:15px;color:#c62828">Your private key</strong>
        <p style="font-size:13px;color:#c62828;margin:6px 0 8px">⚠ Anyone who has this can post as you, forever. Never paste it anywhere but a Nostr app you trust — and keep a copy, because it is stored in this browser only.</p>
        <button id="privkey-reveal" style="width:100%;padding:9px 14px;background:none;border:1px solid #c62828;color:#c62828;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit">Show private key</button>
        <div id="privkey-box" style="display:none;margin-top:8px">
        <input id="privkey-display" readonly style="width:100%;font-size:12px;font-family:monospace;padding:8px;border:1px solid #ddd;border-radius:8px;box-sizing:border-box">
        <div style="display:flex;gap:8px;margin-top:6px">
        <button id="copy-nsec" style="flex:1;padding:8px 14px;background:#0c75bc;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px">Copy nsec</button>
        <button id="privkey-copy" style="flex:1;padding:8px 14px;background:none;border:1px solid #1d9bf0;color:#1d9bf0;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px">Copy hex</button>
        </div>
        </div>
        <label id="privkey-backup-label" style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;cursor:pointer"><input type="checkbox" id="privkey-backup" style="width:16px;height:16px;flex:none;margin:0"><span>I've saved my private key somewhere safe</span></label>

        <div style="display:flex;gap:8px;margin-top:8px">
        <button id="privkey-rotate" style="flex:1;padding:8px 14px;background:none;border:1px solid #d97706;color:#d97706;border-radius:8px;cursor:pointer;font-size:13px">Rotate key</button>
        <button id="privkey-delete" style="flex:1;padding:8px 14px;background:none;border:1px solid #c62828;color:#c62828;border-radius:8px;cursor:pointer;font-size:13px">Delete keypair</button>
        </div>
        </div>
        <div id="import-section">
        <hr style="margin:14px 0;border:none;border-top:1px solid #eee">
        <strong style="font-size:15px;color:#333">Use an existing identity</strong>
        <p style="font-size:13px;color:#666;margin:6px 0 10px">Paste the nsec from another Nostr app to post as that identity here. Raw hex works too.</p>
        <div style="display:flex;gap:8px">
        <input id="privkey-import" placeholder="nsec1… or 64-char hex" style="flex:1;font-size:12px;font-family:monospace;padding:8px;border:1px solid #ddd;border-radius:8px">
        <button id="privkey-import-btn" style="padding:8px 14px;background:none;border:1px solid #1d9bf0;color:#1d9bf0;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px">Import</button>
        </div>
        <p style="font-size:12px;color:#6b6b6b;margin:6px 0 0">This replaces any key stored here — back that one up first.</p>
        </div>
        <div id="signer-section">
        <hr style="margin:14px 0;border:none;border-top:1px solid #eee">
        <strong style="font-size:15px;color:#333">Signing</strong>
        <p style="font-size:13px;color:#666;margin:6px 0 10px">Which key signs your comments. Switch to your signer to use whichever account is selected there.</p>
        <div style="display:flex;gap:8px">
        <button id="signer-local" style="flex:1;padding:9px 10px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit">Key stored here</button>
        <button id="signer-nip07" style="flex:1;padding:9px 10px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit">Alby / nos2x</button>
        </div>
        <p id="signer-note" style="font-size:12px;color:#6b6b6b;margin:8px 0 0"></p>
        </div>
        <div id="muted-section">
        <hr style="margin:14px 0;border:none;border-top:1px solid #eee">
        <strong style="font-size:15px;color:#333">Muted users</strong>
        <div id="muted-list"></div>
        </div>
        <div id="disabled-section">
        <hr style="margin:14px 0;border:none;border-top:1px solid #eee">
        <strong style="font-size:15px;color:#333">Disabled sites</strong>
        <div id="disabled-list"></div>
        </div>
        <div id="muteword-section">
        <hr style="margin:14px 0;border:none;border-top:1px solid #eee">
        <strong style="font-size:15px;color:#333">Muted words</strong>
        <p style="font-size:13px;color:#666;margin:6px 0 8px">Hide comments containing any of these words.</p>
        <div id="muteword-list"></div>
        <div id="muteword-add">
        <input id="muteword-input" placeholder="word or phrase">
        <button id="muteword-add-btn">Add</button>
        </div>
        </div>
        <div style="margin-top:14px">
        <strong style="font-size:15px;color:#333">Verified names</strong>
        <label id="nip05-label" style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;cursor:pointer"><input type="checkbox" id="nip05-toggle" style="width:16px;height:16px;flex:none;margin:0"><span>Check the name@domain a commenter claims</span></label>
        <p style="font-size:12px;color:#777;margin:6px 0 0;line-height:1.45">Off by default. Checking asks that commenter's domain whether the name is really theirs, which tells the domain you are reading this page. Nothing else here contacts anyone outside your relays.</p>
        </div>
        <div style="margin-top:14px">
        <hr style="margin:0 0 12px;border:none;border-top:1px solid #eee">
        <strong style="font-size:15px;color:#333">This site</strong>
        <p style="font-size:13px;color:#666;margin:6px 0 10px">Where the NostrComments button sits on <span id="site-origin"></span> — or whether it appears at all.</p>
        <div id="btnpos-row" style="display:flex;gap:8px">
        <button class="btnpos" data-c="tl" style="flex:1;padding:8px 6px;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit">↖ Top left</button>
        <button class="btnpos" data-c="tr" style="flex:1;padding:8px 6px;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit">↗ Top right</button>
        <button class="btnpos" data-c="bl" style="flex:1;padding:8px 6px;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit">↙ Bottom left</button>
        <button class="btnpos" data-c="br" style="flex:1;padding:8px 6px;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit">↘ Bottom right</button>
        </div>
        <button id="site-disable-btn" style="margin-top:14px;padding:8px 14px;background:none;border:1px solid #e53935;color:#e53935;border-radius:8px;cursor:pointer;font-size:13px">Disable on this site</button>
        </div>
        </div>
        <div id="notif-banner"></div>
        <div id="controls">
        <button id="connect">Connect Nostr</button>
        <span id="status" class="err" style="font-weight:bold">Not connected</span>
        <input id="search" placeholder="Search comments…">
        <select id="sort">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="upvotes">Most upvotes</option>
        </select>
        </div>
        <div id="onboard"></div>
        <div id="pagekey"></div>
        <div id="list"></div>
        <button id="loadMore">Load more</button>
        <div id="msg"></div>
        <div id="reply-indicator"><span><span id="reply-to-label"></span><span id="reply-hint"></span></span><button id="reply-cancel">×</button></div>
        <div id="input-wrapper">
        <textarea id="input" placeholder="Write your comment…"></textarea>
        <button id="send">Post</button>
        </div>
        <p id="post-note">Comments are published to public relays. You can request deletion afterwards, but that is a request — some relays will not honour it, and copies may remain.</p>
        <div id="donate">
        <div id="donate-row">
        <span id="donate-head"></span>
        <span id="donate-quick"></span>
        <button id="donate-toggle" type="button" aria-expanded="false" aria-controls="donate-body">▾</button>
        </div>
        <div id="donate-body">
        <p id="donate-pitch">NostrComments is free and open source — and always will be. If it's useful to you, a zap keeps it maintained.</p>
        <div id="donate-amounts"></div>
        <div id="donate-custom">
        <input id="donate-custom-input" type="number" min="1" placeholder="sats" aria-label="Amount in sats">
        <button id="donate-custom-send" class="donate-amt">Send</button>
        </div>
        <p id="donate-note">Paying opens your own Lightning wallet and contacts the developer's Lightning provider directly. If you're connected to Nostr, your zap is public. No account, no tracking. Prefer on-chain? <a id="donate-btc" href="bitcoin:198yNVWJz2H8PwmNsX72URVVV9pRbxMb18" target="_blank">Send bitcoin</a> or <a id="donate-xmr" href="monero:87aDTPD9HQx2QenKsS7MvHDdqsziFPD7UB37X6G5XVXc2ZPhAs8DdEKUPYJijVcRjj1gU5KvxLCTfWUKWqrd1D5o8uw5EpM" target="_blank">monero</a> — either link copies the address too, in case no wallet opens.</p>
        </div>
        </div>
        </div></div>
        </body></html>`, 'text/html');
        s.appendChild(document.adoptNode(_tpl.getElementById('m')));

        const modal = s.getElementById('m');
        const list = s.getElementById('list');
        const input = s.getElementById('input');
        const send = s.getElementById('send');
        const connectBtn = s.getElementById('connect');
        const status = s.getElementById('status');
        const search = s.getElementById('search');
        const sort = s.getElementById('sort');
        const loadMore = s.getElementById('loadMore');
        const msg = s.getElementById('msg');
        const onboard = s.getElementById('onboard');
        const gearBtn = s.getElementById('gear-btn');
        const settings = s.getElementById('settings');
        const settingsClose = s.getElementById('settings-close');
        const relayListEl = s.getElementById('relay-list');
        const relayInput = s.getElementById('relay-input');
        const relayAddBtn = s.getElementById('relay-add-btn');
        const replyIndicator = s.getElementById('reply-indicator');
        const replyToLabel = s.getElementById('reply-to-label');
        const replyHint = s.getElementById('reply-hint');
        const replyCancel = s.getElementById('reply-cancel');
        const keypairSection = s.getElementById('keypair-section');
        const privkeyDisplay = s.getElementById('privkey-display');
        // The private key is held here, in the content script's own world, and put into the input
        // only while the user is looking at it. The panel hangs in an OPEN shadow root, so any
        // script on the page can read `host.shadowRoot` — and it used to find the key sitting in
        // that field from the moment Settings was opened until the page was left. Nothing in the
        // DOM is private; the fix is to keep the secret out of it rather than to hope nobody looks.
        let _privHex = '';
        const privkeyBoxOpen = () => { const b = s.getElementById('privkey-box'); return !!b && b.style.display !== 'none'; };
        // Shown as nsec, because that is the form every other Nostr app asks for and the form the
        // warning above the field talks about. The hex stays the single source of truth in
        // _privHex, and both copy buttons read from it rather than from the field, so what is
        // displayed and what is copied cannot drift apart.
        const privDisplayText = () => /^[0-9a-f]{64}$/i.test(_privHex) ? toNsec(_privHex) : _privHex;
        const setPrivHex = v => { _privHex = v || ''; if (privkeyBoxOpen()) privkeyDisplay.value = privDisplayText(); };
        const hidePrivkey = () => {
            const box = s.getElementById('privkey-box'), btn = s.getElementById('privkey-reveal');
            if (box) box.style.display = 'none';
            if (btn) btn.textContent = 'Show private key';
            privkeyDisplay.value = '';           // leave nothing behind for the page to find
        };

        const privkeyCopy = s.getElementById('privkey-copy');
        const privkeyRotate = s.getElementById('privkey-rotate');
        const privkeyDelete = s.getElementById('privkey-delete');
        const notifBanner = s.getElementById('notif-banner');
        const themeBtn = s.getElementById('theme-btn');
        const siteDisableBtn = s.getElementById('site-disable-btn');
        function paintBtnPos() {
            for (const b of s.querySelectorAll('.btnpos')) {
                const on = b.dataset.c === btnCorner;
                b.style.background = on ? '#1d9bf0' : 'none';
                b.style.color = on ? '#fff' : '#1d9bf0';
                b.style.border = '1px solid #1d9bf0';
            }
        }
        for (const b of s.querySelectorAll('.btnpos')) b.onclick = () => {
            const c = b.dataset.c;
            if (!/^(tl|tr|bl|br)$/.test(c)) return;
            btn.classList.remove('nc-tl', 'nc-tr', 'nc-bl', 'nc-br');
            btnCorner = c;
            btn.classList.add('nc-' + c);
            saveBtnCorner();
            paintBtnPos();
            showMsg('Moved — this site only.');
        };
        paintBtnPos();
        s.getElementById('site-origin').textContent = location.hostname;

        // The theme used to live in the visited page's localStorage, which got it wrong twice.
        //
        // localStorage is per origin, so choosing dark on one site left every other site following
        // the system again. The panel is the reader's own furniture; it does not belong to the site
        // it happens to be open on.
        //
        // And the page could read it. Any site could look for nostrcomments_theme and know the
        // extension was installed, and that its owner had opened the panel at least once — the same
        // kind of detection closed in v22.62 by giving injected.js a dynamic URL. Every other
        // setting had already moved to extension storage when the cross-origin bug was fixed; this
        // was the one left behind.
        //
        // A choice already made on some site is adopted once and then wiped from that origin, so
        // nobody loses their preference and the marker stops being readable.
        let themePref = _st.nostrcomments_theme === 'dark' || _st.nostrcomments_theme === 'light' ? _st.nostrcomments_theme : null;
        if (!themePref) {
            try {
                const legacy = localStorage.getItem('nostrcomments_theme');
                if (legacy === 'dark' || legacy === 'light') {
                    themePref = legacy;
                    chrome.storage.local.set({nostrcomments_theme: legacy});
                }
                if (legacy !== null) localStorage.removeItem('nostrcomments_theme');
            } catch(e) {}
        } else {
            try { localStorage.removeItem('nostrcomments_theme'); } catch(e) {}
        }
        function applyTheme() {
            const sysDark = window.matchMedia('(prefers-color-scheme:dark)').matches;
            const on = themePref === 'dark' || (themePref !== 'light' && sysDark);
            modal.classList.toggle('dark-mode', on);
            themeBtn.textContent = on ? '☀' : '☽';
        }
        applyTheme();
        window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change', applyTheme);
        themeBtn.onclick = () => {
            themePref = modal.classList.contains('dark-mode') ? 'light' : 'dark';
            chrome.storage.local.set({nostrcomments_theme: themePref});
            applyTheme();
        };

        privkeyCopy.onclick = () => { navigator.clipboard.writeText(_privHex); showMsg('Private key copied'); };
        {
            const revealBtn = s.getElementById('privkey-reveal');
            const box = s.getElementById('privkey-box');
            revealBtn.onclick = () => {
                if (box.style.display !== 'none') return hidePrivkey();
                if (!_privHex) return showMsg(encPriv ? 'Unlock your key first' : 'No key stored here');
                privkeyDisplay.value = privDisplayText();
                box.style.display = 'block';
                revealBtn.textContent = 'Hide private key';
            };
        }

        s.getElementById('copy-nsec').onclick = () => {
            const priv = _privHex;
            if (!/^[0-9a-f]{64}$/i.test(priv)) return showMsg('Unlock your key first');
            navigator.clipboard.writeText(toNsec(priv));
            showMsg('nsec copied — paste into any Nostr app');
        };
        // Import an identity generated elsewhere. Accepts the nsec form every other Nostr app
        // shows, as well as raw hex — asking someone to convert a key by hand is how mistakes and
        // pasted-into-a-website accidents happen.
        s.getElementById('privkey-import-btn').onclick = async () => {
            const raw = s.getElementById('privkey-import').value.trim();
            if (!raw) return showMsg('Paste an nsec or hex private key first');
            const priv = /^nsec1/i.test(raw) ? fromBech32('nsec', raw) : (/^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : null);
            if (!priv) return showMsg(/^nsec1/i.test(raw) ? 'That nsec is not valid — check for a typo' : 'Not an nsec1… or 64-character hex key');
            // Reject keys outside the secp256k1 group order rather than producing a broken identity.
            const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
            const v = BigInt('0x' + priv);
            if (v === 0n || v >= n) return showMsg('That key is out of range for Nostr');
            // Name the identity that is about to disappear, and offer to take a copy of it first.
            const cur = _privHex;
            const curValid = /^[0-9a-f]{64}$/i.test(cur);
            const hasStored = !!(localWallet || encPriv);
            if (hasStored) {
                const curNpub = curValid ? toNpub(_secp.pubKey(cur)) : (myPub ? toNpub(myPub) : null);
                const lines = [
                    curNpub ? `The identity stored here is ${curNpub.slice(0, 20)}… and it will be gone. This cannot be undone.`
                            : 'The key stored here will be replaced. This cannot be undone.',
                    keyBackedUp ? 'It is marked as backed up — but check that the copy is one you can still find.'
                                : 'There is NO confirmed backup of it. If you have no copy elsewhere, that identity is lost for good.',
                ];
                if (!curValid && encPriv) lines.push('It is password-protected, so it cannot be copied from here without unlocking first. Cancel and unlock if you want a copy.');
                const go = await askConfirm({
                    title: 'Replace the identity stored here?',
                    lines,
                    confirmLabel: 'Replace it',
                    extraLabel: curValid ? 'Copy the current key first' : null,
                    onExtra: curValid ? (async () => { await navigator.clipboard.writeText(toNsec(cur)); }) : null,
                });
                if (!go) { s.getElementById('privkey-import').value = ''; return showMsg('Import cancelled — your identity is unchanged. Paste the key again to retry.'); }
            }
            try {
                await chrome.storage.local.set({nostrcomments_privkey: priv, nostrcomments_keybackup: true});
                encPriv = null; keyBackedUp = true; refreshPwBtn(); updateBackupUI(); haveStoredKey = true;
                localWallet = await makeLocalWallet(priv);
                myPub = await localWallet.getPublicKey();
                setPrivHex(priv);
                s.getElementById('privkey-import').value = '';
                keypairSection.style.display = 'block';
                fetchProfiles([myPub]); paintIdentity();
                recountAll();
                startNotifSub();
                render();
                showMsg('Identity imported — you are now posting as ' + toNpub(myPub).slice(0, 12) + '…');
                offerEncryption(priv);
            } catch(e) { showMsg('Import failed — the key could not be loaded'); }
        };

        privkeyRotate.onclick = async () => {
            const cur = _privHex;
            const curValid = /^[0-9a-f]{64}$/i.test(cur);
            const go = await askConfirm({
                title: 'Generate a new identity?',
                lines: [
                    curValid ? `The identity stored here is ${toNpub(_secp.pubKey(cur)).slice(0, 20)}… and it will be replaced by a fresh one. This cannot be undone.`
                             : 'The key stored here will be replaced by a fresh one. This cannot be undone.',
                    keyBackedUp ? 'It is marked as backed up — but check that the copy is one you can still find.'
                                : 'There is NO confirmed backup. Without a copy elsewhere, that identity is lost for good.',
                ],
                confirmLabel: 'Generate a new one',
                extraLabel: curValid ? 'Copy the current key first' : null,
                onExtra: curValid ? (async () => { await navigator.clipboard.writeText(toNsec(cur)); }) : null,
            });
            if (!go) return showMsg('Cancelled — your key is unchanged');
            privkeyRotate.disabled = true;
            try {
                const priv = _secp.b2h(crypto.getRandomValues(new Uint8Array(32)));
                await chrome.storage.local.set({nostrcomments_privkey: priv, nostrcomments_keybackup: false});
                encPriv = null; keyBackedUp = false; refreshPwBtn(); updateBackupUI(); haveStoredKey = true;
                localWallet = await makeLocalWallet(priv);
                myPub = await localWallet.getPublicKey();
                setPrivHex(priv);
                fetchProfiles([myPub]); paintIdentity();
                recountAll();
                startNotifSub();
                render();
                showMsg('New key generated — copy it and tick "I\'ve saved my private key".');
                offerEncryption(priv);
            } catch(e) { showMsg('Key rotation failed — try again'); }
            finally { privkeyRotate.disabled = false; }
        };
        privkeyDelete.onclick = async () => {
            const cur = _privHex;
            const curValid = /^[0-9a-f]{64}$/i.test(cur);
            const go = await askConfirm({
                title: 'Delete the identity stored here?',
                lines: [
                    curValid ? `${toNpub(_secp.pubKey(cur)).slice(0, 20)}… will be removed from this browser. This cannot be undone.`
                             : 'The key stored here will be removed from this browser. This cannot be undone.',
                    keyBackedUp ? 'It is marked as backed up — but make sure that copy still exists.'
                                : 'There is NO confirmed backup. Without a copy elsewhere, this identity is gone permanently.',
                ],
                confirmLabel: 'Delete it',
                extraLabel: curValid ? 'Copy the key first' : null,
                onExtra: curValid ? (async () => { await navigator.clipboard.writeText(toNsec(cur)); }) : null,
            });
            if (!go) return showMsg('Cancelled — your key is unchanged');
            chrome.storage.local.remove(['nostrcomments_privkey','nostrcomments_keybackup']);
            localWallet = null; myPub = null; encPriv = null; keyBackedUp = false; refreshPwBtn(); updateBackupUI(); haveStoredKey = false;
            // Forget the key here too, not only on disk. Without this, "Show private key" would
            // hand back the identity the user just deleted, for as long as the page stayed open.
            setPrivHex(''); hidePrivkey();
            keypairSection.style.display = 'none';
            // The identity is gone: repaint from that fact instead of hand-setting the pieces, so
            // the Connect button returns and no vote is left marked as yours.
            paintIdentity(); recountAll(); render();
            startNotifSub();   // no identity left: this tears the subscription down
            closeSettings();
            showMsg('Keypair deleted');
        };

        // Backup reminder: nudge the user to save their key, and remember when they confirm.
        const privkeyBackup = s.getElementById('privkey-backup');
        function updateBackupUI() {
            if (!privkeyBackup) return;
            privkeyBackup.checked = keyBackedUp;
            const lbl = privkeyBackup.closest('label');
            if (lbl) lbl.style.color = keyBackedUp ? '#888' : '#c62828';
        }
        privkeyBackup.onchange = () => {
            keyBackedUp = privkeyBackup.checked;
            chrome.storage.local.set({nostrcomments_keybackup: keyBackedUp});
            updateBackupUI();
        };

        // Optional password protection: encrypt the local key at rest (PBKDF2 -> AES-GCM).
        const pwBtn = document.createElement('button');
        pwBtn.type = 'button';
        Object.assign(pwBtn.style, {width:'100%',marginTop:'8px',padding:'9px 14px',background:'none',border:'1px solid #1d9bf0',color:'#1d9bf0',borderRadius:'8px',cursor:'pointer',fontSize:'13px'});
        function refreshPwBtn() { pwBtn.textContent = encPriv ? '🔓 Remove password' : '🔒 Set a password'; }
        refreshPwBtn();
        pwBtn.onclick = async () => {
            if (encPriv) {
                if (!localWallet) { const w = await unlockLocalWallet(); if (!w) return; }
                const priv = _privHex;
                if (!/^[0-9a-f]{64}$/i.test(priv)) return showMsg('Unlock first to change this');
                await chrome.storage.local.set({nostrcomments_privkey: priv});
                encPriv = null; refreshPwBtn();
                showMsg('Password removed — key stored unencrypted on this device');
            } else {
                const priv = _privHex;
                if (!/^[0-9a-f]{64}$/i.test(priv)) return showMsg('No local key to protect');
                const p1 = await askForPassword({
                    title: '🔒 Set a password',
                    text: 'This encrypts your key where it is stored in this browser. You will be asked for it when you post.',
                    confirmLabel: 'Set a password',
                    declineLabel: 'Cancel',
                });
                if (!p1) return;
                const enc = await _encryptPriv(priv, p1);
                await chrome.storage.local.set({nostrcomments_privkey: enc});
                encPriv = enc; refreshPwBtn();
                showMsg('Password set — your key is now encrypted at rest');
            }
        };
        keypairSection.appendChild(pwBtn);

        siteDisableBtn.onclick = async () => {
            const _d = await chrome.storage.local.get('nostrcomments_disabled');
            const arr = Array.isArray(_d.nostrcomments_disabled) ? _d.nostrcomments_disabled : [];
            if (!arr.includes(location.origin)) arr.push(location.origin);
            await chrome.storage.local.set({nostrcomments_disabled: arr});
            modal.style.display = 'none';
            btn.style.display = 'none';
            host.remove();
        };

        // Onboard banner
        let _obNew, _obUnlock, _obPitch, _obUseLocal, _obGen, _obSigner, _obOr, _obWallets, _obWalletHint;
        // Whether a key exists in storage, which is not the same as one being loaded. Choosing the
        // NIP-07 signer deliberately leaves a stored key unloaded, so this is the difference
        // between "no identity yet" and "an identity we are not currently using".
        let haveStoredKey = !!_st.nostrcomments_privkey;
        // Declared here rather than beside signerPresent(), which is where it is maintained: the
        // onboarding block reads it through signerInPage() and paints long before that point in the
        // file, so leaving the declaration down there put it in the temporal dead zone and threw
        // during init. The panel never got built, and the only symptom was an extension that seemed
        // not to load at all.
        let nip07Seen = false;
        (() => {
            const headline = document.createElement('div');
            headline.className = 'ob-title';
            headline.textContent = '🌐 Comment freely. No one can silence you.';

            const pitch = document.createElement('p');
            pitch.className = 'ob-pitch';
            pitch.textContent = 'Your comments live on the Nostr network — a global web of relays nobody controls. No account. No email. No company can delete your posts. Your identity is a cryptographic key you own.';

            const genBtn = document.createElement('button');
            genBtn.className = 'ob-primary';
            genBtn.textContent = '🔑 Start commenting — generate your key';
            genBtn.onclick = async () => {
                genBtn.disabled = true;
                try {
                    // This writes straight to storage with no undo, and it is the only key path
                    // that never asked. Rotate and import both confirm first. Storage is re-read
                    // here rather than trusted from memory, because the danger is precisely a
                    // panel that is out of date with what is stored.
                    const _cur = await chrome.storage.local.get('nostrcomments_privkey');
                    if (_cur.nostrcomments_privkey) {
                        paintOnboard();
                        genBtn.disabled = false;
                        return showMsg('There is already a key stored here — nothing was changed. Use “Rotate key” in settings to replace it on purpose.');
                    }
                    const priv = _secp.b2h(crypto.getRandomValues(new Uint8Array(32)));
                    await chrome.storage.local.set({nostrcomments_privkey: priv, nostrcomments_keybackup: false});
                    encPriv = null; keyBackedUp = false; refreshPwBtn(); haveStoredKey = true;
                    localWallet = await makeLocalWallet(priv);
                    await connect();
                    // The key is held out of the DOM until somebody asks to see it, so this stores
                    // it without putting it on screen.
                    setPrivHex(priv);
                    keypairSection.style.display = 'block';
                    updateBackupUI();
                    paintOnboard();
                    // This used to open Settings and reveal the key on the spot. The reasoning was
                    // sound — the key exists in this browser and nowhere else, so there is no
                    // recovery and this is the one moment you have somebody's attention — but the
                    // moment was wrong. They pressed a button that said "start commenting" and were
                    // handed a red warning block and a secret instead. Nothing is at stake yet
                    // either: an identity with no comments on it is not worth backing up. The ask
                    // moved to just after the first comment, where the argument is actually true.
                    try { input.focus(); } catch(e) {}
                    showMsg('Key created — you can comment now.');
                } catch(e) {
                    showMsg('Key generation failed — try again');
                    genBtn.disabled = false;
                }
            };

            const orLine = document.createElement('div');
            orLine.className = 'ob-or';
            orLine.textContent = 'or connect an existing Nostr wallet';

            const wallets = document.createElement('div');
            wallets.className = 'ob-wallets';
            [['Alby', 'https://addons.mozilla.org/firefox/addon/alby/'], ['nos2x-fox', 'https://addons.mozilla.org/firefox/addon/nos2x-fox/']].forEach(([label, href]) => {
                const a = document.createElement('a');
                a.className = 'ob-wallet'; a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
                a.textContent = label;
                wallets.appendChild(a);
            });

            // Installing a signer means leaving the page. Coming back to a panel that still says
            // nothing reads as "it did not work" — the detection retries for about 30 seconds, which
            // is not something to rely on when one sentence removes the doubt.
            const walletHint = document.createElement('p');
            walletHint.className = 'ob-hint';
            walletHint.textContent = 'Install it, then reload this page.';

            // Selecting a signer that then stops answering used to be a dead end: the stored key
            // is deliberately not loaded, so nothing connects, the block stays up, and the only
            // button on it refuses because a key already exists. Falling back to that key on our
            // own is not the fix — switching identity behind somebody's back is the bug this
            // extension already had once — so it is offered instead.
            _obUseLocal = document.createElement('button');
            _obUseLocal.type = 'button';
            _obUseLocal.className = 'ob-primary';
            _obUseLocal.textContent = '🔑 Use the key stored here';
            _obUseLocal.style.display = 'none';
            _obUseLocal.onclick = () => chooseSigner('local');

            // Offering to install a signer to somebody who already has one — which is what the two
            // links below did unconditionally — sends them to a store page for an extension that is
            // already running. Meanwhile the thing they actually wanted, connect the signer I have,
            // existed only behind the Connect button in the header, which does not say what it does.
            //
            // One button rather than two: nothing here can tell Alby from nos2x. Both simply provide
            // window.nostr, so a pair of named buttons would suggest a choice that does not exist,
            // and the "wrong" one would work anyway.
            _obSigner = document.createElement('button');
            _obSigner.type = 'button';
            _obSigner.className = 'ob-primary';
            _obSigner.textContent = '⚡ Connect your Nostr signer';
            _obSigner.style.display = 'none';
            _obSigner.onclick = () => chooseSigner('nip07');

            _obGen = genBtn;
            _obOr = orLine;
            _obWallets = wallets;
            _obWalletHint = walletHint;
            _obNew = document.createElement('div');
            _obNew.append(_obSigner, genBtn, _obUseLocal, orLine, wallets, walletHint);
            _obUnlock = document.createElement('button');
            _obUnlock.type = 'button';
            _obUnlock.className = 'ob-primary';
            _obUnlock.textContent = '🔒 Unlock to comment';
            _obUnlock.style.display = 'none';
            _obUnlock.onclick = () => unlockLocalWallet();
            _obPitch = pitch;
            onboard.append(headline, pitch, _obNew, _obUnlock);
        })();

        // Whether the onboarding block belongs on screen is a fact about the stored identity, so it
        // is derived in one place and called from paintIdentity — which every path that changes an
        // identity already calls. Setting it by hand at each of those paths is what went wrong:
        // importing a key from settings left the block up, offering to generate over the key that
        // had just been imported.
        // Answered from the last bridge check. A userscript can read window.nostr directly; here it
        // is asynchronous, so the value is remembered and both painters follow it when it changes.
        const signerInPage = () => nip07Seen;

        function paintOnboard() {
            if (!onboard || !_obNew) return;
            onboard.style.display = (myPub || !hasConsent) ? 'none' : 'block';
            if (myPub) return;
            const locked = !!encPriv && !localWallet;
            // Two facts decide the whole block, and both are already known: is there a signer in
            // this page, and is there a key in storage that is not loaded. Everything follows.
            const signerHere = signerInPage();
            const storedAvailable = !locked && haveStoredKey && !localWallet;
            _obNew.style.display = locked ? 'none' : 'block';
            _obUnlock.style.display = locked ? 'block' : 'none';
            // A signer in the page is the offer to lead with: it is what somebody who has one came
            // for, and if signerPref is already 'nip07' it is what they asked for last time.
            if (_obSigner) _obSigner.style.display = signerHere ? 'block' : 'none';
            if (_obWallets) _obWallets.style.display = signerHere ? 'none' : 'flex';
            if (_obWalletHint) _obWalletHint.style.display = signerHere ? 'none' : 'block';
            if (_obOr) _obOr.textContent = signerHere ? 'or' : 'or connect an existing Nostr wallet';
            // Whichever local option applies is shown, and drops to secondary when a signer is
            // there, so two stacked buttons do not both read as the thing to press.
            if (_obGen) {
                _obGen.style.display = storedAvailable ? 'none' : 'block';
                _obGen.className = signerHere ? 'ob-secondary' : 'ob-primary';
            }
            if (_obUseLocal) {
                _obUseLocal.style.display = storedAvailable ? 'block' : 'none';
                _obUseLocal.className = signerHere ? 'ob-secondary' : 'ob-primary';
            }
            _obPitch.textContent = locked
                ? 'Your saved key is password-protected. Unlock it to post — reading comments needs no password.'
                : signerHere
                    ? (storedAvailable
                        ? 'A Nostr signer is available in this page. Connect it, or post with the key stored in this extension instead.'
                        : 'A Nostr signer is available in this page. Connect it, or make a key that lives only in this browser.')
                    : storedAvailable
                        ? 'Your browser signer is selected but is not answering. There is a key stored in this extension — you can post with that instead, or fix the signer and reload.'
                        : 'Your comments live on the Nostr network — a global web of relays nobody controls. No account. No email. No company can delete your posts. Your identity is a cryptographic key you own.';
        }

        // Sticky for anything the reader has to act on. A failure that arrives a minute after the
        // click and then takes itself off screen two and a half seconds later is a failure nobody
        // reads — which is exactly how a signer that had stopped answering looked like nothing
        // happening at all. The timer is cleared as well as set: two messages in a row let the
        // first one's timer hide the second, so the second was shown for whatever was left over.
        let _msgTimer = null;
        function showMsg(text, sticky) {
            msg.textContent = text;
            msg.style.display = 'block';
            if (_msgTimer) { clearTimeout(_msgTimer); _msgTimer = null; }
            if (!sticky) _msgTimer = setTimeout(() => { msg.style.display = 'none'; _msgTimer = null; }, 4000);
        }
        function clearMsg() {
            if (_msgTimer) { clearTimeout(_msgTimer); _msgTimer = null; }
            msg.style.display = 'none';
        }

        // "Failed to sign" is true but useless when the reason is that nothing ever came back.
        const _isSignerTimeout = e => /NIP-07 timeout/i.test((e && e.message) || '');
        function showSignFailure(e, what) {
            showMsg(_isSignerTimeout(e)
                ? `Your signer never answered, so nothing was signed and no ${what} was sent. Approve the request in your signer, or switch to the key stored here under ⚙ Settings.`
                : 'Failed to sign — try again.', true);
        }

        // Prominent disclosure + consent gate. Nothing is sent to any relay until the user
        // explicitly enables NostrComments here (Chrome Web Store user-data policy).
        const consentOverlay = document.createElement('div');
        Object.assign(consentOverlay.style, {display:'none',position:'absolute',inset:'0',background:'inherit',borderRadius:'16px',padding:'30px 26px',flexDirection:'column',justifyContent:'center',zIndex:'20',boxSizing:'border-box'});
        {
            const _cTitle = document.createElement('div');
            _cTitle.textContent = 'One quick thing before you start';
            Object.assign(_cTitle.style, {fontSize:'20px',fontWeight:'700',color:'#1d9bf0',margin:'0 0 14px',textAlign:'center'});
            const _cText = document.createElement('p');
            // No explicit colour → inherits the panel's theme-correct text colour.
            _cText.textContent = 'NostrComments works by connecting to public Nostr relays — third-party servers that no one controls. When you enable it, the address (URL) of the page you are on, the comments you write, and your Nostr public key are sent to these relays so your comments can be shared with everyone who visits the same page. The developer never receives, collects, or stores any of this — there is no account, no tracking, and no analytics. Nothing is sent until you enable it below, and you can disable it per site anytime in Settings.';
            Object.assign(_cText.style, {fontSize:'14px',lineHeight:'1.65',margin:'0 0 22px',textAlign:'left'});
            const _cBtn = document.createElement('button');
            _cBtn.textContent = 'I understand — enable NostrComments';
            Object.assign(_cBtn.style, {display:'block',width:'100%',padding:'14px',background:'linear-gradient(135deg,#0c75bc,#0a68ad)',color:'white',border:'none',borderRadius:'10px',cursor:'pointer',fontSize:'15px',fontWeight:'700'});
            _cBtn.onclick = async () => {
                hasConsent = true;
                try { await chrome.storage.local.set({nostrcomments_consent: true}); } catch(e) {}
                consentOverlay.style.display = 'none';
                paintOnboard();
                startNetwork();
            };
            consentOverlay.append(_cTitle, _cText, _cBtn);
        }
        s.getElementById('p').appendChild(consentOverlay);

        // Password dialog. Used both for the one-time offer when a key first appears and for the
        // Set-a-password button, so there is one flow rather than two — and so neither of them is
        // a native prompt(), which blocks the page it is injected into.
        //
        // Resolves with the password, or null when the person says no. Saying no is a real answer
        // here: a key that cannot be used without a password is a key ordinary readers abandon, and
        // this has to stay usable by people who did not come for a cryptography lesson.
        const pwOverlay = document.createElement('div');
        Object.assign(pwOverlay.style, {display:'none',position:'absolute',inset:'0',background:'inherit',borderRadius:'16px',padding:'30px 26px',flexDirection:'column',justifyContent:'center',zIndex:'28',boxSizing:'border-box'});
        const _pwTitle = document.createElement('div');
        const _pwText = document.createElement('p');
        const _pw1 = document.createElement('input');
        const _pw2 = document.createElement('input');
        const _pwErr = document.createElement('p');
        const _pwOk = document.createElement('button');
        const _pwNo = document.createElement('button');
        const _pwNote = document.createElement('p');
        let _pwResolve = null;
        {
            Object.assign(_pwTitle.style, {fontSize:'20px',fontWeight:'700',color:'#1d9bf0',margin:'0 0 12px',textAlign:'center'});
            Object.assign(_pwText.style, {fontSize:'14px',lineHeight:'1.6',margin:'0 0 14px',textAlign:'center'});
            for (const [el, ph] of [[_pw1, 'Password'], [_pw2, 'Repeat password']]) {
                el.type = 'password'; el.placeholder = ph; el.setAttribute('aria-label', ph);
                Object.assign(el.style, {width:'100%',padding:'12px 14px',border:'2px solid #e2e8f0',borderRadius:'10px',fontSize:'15px',boxSizing:'border-box',marginBottom:'8px'});
            }
            Object.assign(_pwErr.style, {color:'#c62828',fontSize:'13px',minHeight:'18px',margin:'0 0 8px',textAlign:'center'});
            _pwOk.type = 'button';
            Object.assign(_pwOk.style, {display:'block',width:'100%',padding:'13px',background:'linear-gradient(135deg,#0c75bc,#0a68ad)',color:'white',border:'none',borderRadius:'10px',cursor:'pointer',fontSize:'15px',fontWeight:'700',marginBottom:'8px'});
            _pwNo.type = 'button';
            Object.assign(_pwNo.style, {display:'block',width:'100%',padding:'10px',background:'none',border:'none',color:'#888',cursor:'pointer',fontSize:'14px'});
            // Kept out of the paragraph that does the asking, and under the buttons rather than
            // above them: it is a reassurance, not part of the question.
            Object.assign(_pwNote.style, {fontSize:'12px',color:'#8a8a8a',textAlign:'center',margin:'4px 0 0',lineHeight:'1.5'});
            const settle = v => { pwOverlay.style.display = 'none'; _pw1.value = ''; _pw2.value = ''; const r = _pwResolve; _pwResolve = null; if (r) r(v); };
            _pwOk.onclick = () => {
                if (!_pw1.value) { _pwErr.textContent = 'Enter a password, or choose not to set one.'; return; }
                if (_pw1.value !== _pw2.value) { _pwErr.textContent = 'The two do not match.'; return; }
                settle(_pw1.value);
            };
            _pwNo.onclick = () => settle(null);
            _pw2.onkeydown = e => { if (e.key === 'Enter') _pwOk.click(); };
            pwOverlay.append(_pwTitle, _pwText, _pw1, _pw2, _pwErr, _pwOk, _pwNo, _pwNote);
        }
        s.getElementById('p').appendChild(pwOverlay);
        function askForPassword({title, text, confirmLabel, declineLabel, note}) {
            _pwTitle.textContent = title;
            _pwText.textContent = text;
            _pwNote.textContent = note || '';
            _pwNote.style.display = note ? 'block' : 'none';
            _pwOk.textContent = confirmLabel;
            _pwNo.textContent = declineLabel;
            _pw1.value = ''; _pw2.value = ''; _pwErr.textContent = '';
            pwOverlay.style.display = 'flex';
            setTimeout(() => _pw1.focus(), 0);
            return new Promise(res => { _pwResolve = res; });
        }

        // Offered once, when a key first appears and never again — not a nag. The answer is
        // remembered either way, so somebody who said no is not asked on every page they read.
        let pwOffered = _st.nostrcomments_pwoffered === true;
        let backupAskedAt = Number(_st.nostrcomments_backupasked) || 0;
        const rememberBackupAsked = () => { try { chrome.storage.local.set({nostrcomments_backupasked: Date.now()}); } catch(e) {} };
        // Held until the panel is actually open. A key that was already stored triggers this at
        // page load, when the panel is usually shut — and marking it as offered then would spend
        // the one chance on a dialog nobody ever saw.
        let _pendingKeyOffer = null;
        // Two prompts about the same key, never on the same page. They are about opposite
        // dangers — losing the key yourself, and somebody else on this computer taking it — so
        // neither can be folded into the other, and both deserve to be read rather than clicked
        // away. Whichever does not get its turn comes back on a later visit.
        let keyPromptShown = false;

        async function offerEncryption(privHex) {
            if (pwOffered || !/^[0-9a-f]{64}$/i.test(privHex || '')) return;
            if (keyPromptShown) return;
            if (modal.style.display === 'none') { _pendingKeyOffer = privHex; return; }
            pwOffered = true; keyPromptShown = true;
            chrome.storage.local.set({nostrcomments_pwoffered: true});
            const pass = await askForPassword({
                title: '🔒 Protect this key?',
                text: 'Your key is stored in this browser. A password encrypts it there, so somebody with access to this computer cannot take it — you will be asked for it when you post. Without one it stays readable on disk.',
                confirmLabel: 'Set a password',
                declineLabel: 'Not now',
                note: 'Not now is fine — you can set one whenever you like under ⚙ Settings.',
            });
            if (!pass) return showMsg('No password set — you can add one later in ⚙ Settings');
            try {
                const enc = await _encryptPriv(privHex, pass);
                await chrome.storage.local.set({nostrcomments_privkey: enc});
                encPriv = enc; refreshPwBtn();
                showMsg('Password set — your key is encrypted on this device');
            } catch(e) { showMsg('Could not set the password — your key is unchanged'); }
        }

        // Unlock overlay — shown on demand when the user posts/votes while their key is
        // password-encrypted and not yet unlocked this page. Returns the wallet or null.
        const unlockOverlay = document.createElement('div');
        Object.assign(unlockOverlay.style, {display:'none',position:'absolute',inset:'0',background:'inherit',borderRadius:'16px',padding:'30px 26px',flexDirection:'column',justifyContent:'center',zIndex:'25',boxSizing:'border-box'});
        const _ulInput = document.createElement('input');
        const _ulErr = document.createElement('p');
        let _ulResolve = null;
        {
            const t = document.createElement('div');
            t.textContent = '🔒 Unlock your key';
            Object.assign(t.style, {fontSize:'20px',fontWeight:'700',color:'#1d9bf0',margin:'0 0 12px',textAlign:'center'});
            const pt = document.createElement('p');
            pt.textContent = 'Enter your password to post with your saved key.';
            Object.assign(pt.style, {fontSize:'14px',lineHeight:'1.6',margin:'0 0 14px',textAlign:'center'});
            _ulInput.type = 'password';
            _ulInput.setAttribute('aria-label', 'Password');
            _ulInput.placeholder = 'Password';
            Object.assign(_ulInput.style, {width:'100%',padding:'12px 14px',border:'2px solid #e2e8f0',borderRadius:'10px',fontSize:'15px',boxSizing:'border-box',marginBottom:'8px'});
            Object.assign(_ulErr.style, {color:'#c62828',fontSize:'13px',minHeight:'18px',margin:'0 0 8px',textAlign:'center'});
            const unlockBtn = document.createElement('button');
            unlockBtn.type = 'button'; unlockBtn.textContent = 'Unlock';
            Object.assign(unlockBtn.style, {display:'block',width:'100%',padding:'13px',background:'linear-gradient(135deg,#0c75bc,#0a68ad)',color:'white',border:'none',borderRadius:'10px',cursor:'pointer',fontSize:'15px',fontWeight:'700',marginBottom:'8px'});
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
            Object.assign(cancelBtn.style, {display:'block',width:'100%',padding:'10px',background:'none',border:'none',color:'#888',cursor:'pointer',fontSize:'14px'});
            const doUnlock = async () => {
                const pass = _ulInput.value;
                if (!pass) return;
                unlockBtn.disabled = true;
                try {
                    const priv = await _decryptPriv(encPriv, pass);
                    if (!/^[0-9a-f]{64}$/i.test(priv)) throw new Error('bad');
                    localWallet = await makeLocalWallet(priv);
                    setPrivHex(priv);
                    unlockOverlay.style.display = 'none';
                    _ulInput.value = '';
                    await connect();
                    const r = _ulResolve; _ulResolve = null; if (r) r(localWallet);
                } catch(e) { _ulErr.textContent = 'Wrong password — try again.'; }
                finally { unlockBtn.disabled = false; }
            };
            unlockBtn.onclick = doUnlock;
            _ulInput.onkeydown = e => { if (e.key === 'Enter') doUnlock(); };
            cancelBtn.onclick = () => { unlockOverlay.style.display = 'none'; _ulInput.value = ''; const r = _ulResolve; _ulResolve = null; if (r) r(null); };
            unlockOverlay.append(t, pt, _ulInput, _ulErr, unlockBtn, cancelBtn);
        }
        s.getElementById('p').appendChild(unlockOverlay);
        function unlockLocalWallet() {
            if (localWallet) return Promise.resolve(localWallet);
            if (!encPriv) return Promise.resolve(null);
            return new Promise(res => {
                _ulResolve = res; _ulErr.textContent = ''; _ulInput.value = '';
                unlockOverlay.style.display = 'flex';
                setTimeout(() => _ulInput.focus(), 0);
            });
        }

        // A real dialog, because window.confirm() offers only OK and Cancel — and the thing it
        // guards here is the permanent loss of an identity. The user needs a third option: take a
        // copy of the key first. Returns true to proceed, false to cancel.
        const askOverlay = document.createElement('div');
        Object.assign(askOverlay.style, {display:'none',position:'absolute',inset:'0',background:'inherit',borderRadius:'16px',padding:'30px 26px',flexDirection:'column',justifyContent:'center',zIndex:'30',boxSizing:'border-box'});
        s.getElementById('p').appendChild(askOverlay);
        function askConfirm({title, lines, confirmLabel, danger = true, extraLabel, onExtra, declineLabel = 'Cancel'}) {
            return new Promise(resolve => {
                askOverlay.replaceChildren();
                const t = document.createElement('div');
                t.textContent = title;
                Object.assign(t.style, {fontSize:'19px',fontWeight:'700',color: danger ? '#c62828' : '#1d9bf0',margin:'0 0 14px',textAlign:'center'});
                askOverlay.appendChild(t);
                for (const line of lines) {
                    const p2 = document.createElement('p');
                    p2.textContent = line;
                    Object.assign(p2.style, {fontSize:'14px',lineHeight:'1.6',margin:'0 0 12px',textAlign:'left'});
                    askOverlay.appendChild(p2);
                }
                const done = v => { askOverlay.style.display = 'none'; resolve(v); };
                if (extraLabel) {
                    const ex = document.createElement('button');
                    ex.type = 'button'; ex.textContent = extraLabel;
                    Object.assign(ex.style, {display:'block',width:'100%',padding:'12px',background:'none',border:'1px solid #1d9bf0',color:'#1d9bf0',borderRadius:'10px',cursor:'pointer',fontSize:'14px',fontWeight:'600',marginBottom:'10px'});
                    // Deliberately does not close the dialog: copying is a step before deciding.
                    ex.onclick = async () => { try { await onExtra(); ex.textContent = '✓ Copied — now decide below'; ex.disabled = true; ex.style.opacity = '.7'; } catch(e) { ex.textContent = 'Copy failed'; } };
                    askOverlay.appendChild(ex);
                }
                const yes = document.createElement('button');
                yes.type = 'button'; yes.textContent = confirmLabel;
                Object.assign(yes.style, {display:'block',width:'100%',padding:'13px',background: danger ? '#c62828' : 'linear-gradient(135deg,#0c75bc,#0a68ad)',color:'white',border:'none',borderRadius:'10px',cursor:'pointer',fontSize:'15px',fontWeight:'700',marginBottom:'8px'});
                yes.onclick = () => done(true);
                const no = document.createElement('button');
                no.type = 'button'; no.textContent = declineLabel;
                Object.assign(no.style, {display:'block',width:'100%',padding:'10px',background:'none',border:'none',color:'#888',cursor:'pointer',fontSize:'14px'});
                no.onclick = () => done(false);
                askOverlay.append(yes, no);
                askOverlay.style.display = 'flex';
                setTimeout(() => no.focus(), 0);
            });
        }

        function closeModal() { modal.style.display = 'none'; try { btn.focus(); } catch(e) {} }
        btn.onclick = () => {
            startNetwork();   // asked for by hand: no waiting
            modal.style.display = 'grid';
            if (_pendingKeyOffer) { const k = _pendingKeyOffer; _pendingKeyOffer = null; offerEncryption(k); }
            if (!hasConsent) { consentOverlay.style.display = 'flex'; setTimeout(() => consentOverlay.querySelector('button')?.focus(), 0); return; }
            markPageSeen();
            paintOnboard();
            if (unreadReplies > 0) {
                notifBanner.textContent = `🔔 ${unreadReplies} new repl${unreadReplies === 1 ? 'y' : 'ies'} on your comments`;
                notifBanner.style.display = 'block';
                setTimeout(() => { notifBanner.style.display = 'none'; }, 5000);
            }
            unreadReplies = 0;
            updateNotifBadge();
            setTimeout(() => s.getElementById('c')?.focus(), 0);
        };
        s.getElementById('c').onclick = closeModal;
        // Keyboard focus trap: keep Tab within the open dialog.
        s.addEventListener('keydown', e => {
            if (e.key !== 'Tab' || modal.style.display === 'none') return;
            const f = [];
            s.querySelectorAll('button,input,select,textarea,a[href]').forEach(el => { if (el.offsetParent !== null) f.push(el); });
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && s.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && s.activeElement === last) { e.preventDefault(); first.focus(); }
        });

        // The panel types into somebody else's document. Sites with keyboard shortcuts read keys off
        // document and cancel them — space is the usual one — and the character then never reaches
        // the box. Reported from real use on a Nostr client where the space bar did nothing.
        //
        // Two halves, because either alone is not enough. Stopping propagation keeps the page from
        // acting on what is typed here. But a listener registered in the capture phase runs before
        // anything in this shadow tree and cannot be stopped from inside it, so when the default has
        // already been cancelled by the time the event arrives, the character is inserted by hand.
        const keyEditable = el => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.disabled && !el.readOnly;
        const keyPrintable = e => !!e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
        const keyInsert = (el, ch) => {
            const a = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
            const b = typeof el.selectionEnd === 'number' ? el.selectionEnd : a;
            el.value = el.value.slice(0, a) + ch + el.value.slice(b);
            try { el.selectionStart = el.selectionEnd = a + ch.length; } catch (_) {}
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        ['keydown', 'keypress', 'keyup'].forEach(type => {
            s.addEventListener(type, e => {
                if (modal.style.display === 'none') return;
                if (type === 'keydown') {
                    // Escape closed the panel through a listener on document, which stopping
                    // propagation would cut off whenever focus sat inside the panel.
                    if (e.key === 'Escape') closeModal();
                    else if (e.defaultPrevented && keyPrintable(e) && keyEditable(s.activeElement)) {
                        keyInsert(s.activeElement, e.key);
                    }
                }
                e.stopPropagation();
            });
        });

        // Relay config
        // relay.nostr.band and offchain.pub were dropped in v22.59 after failing from two
        // independent machines on the same day — repeatedly, including through an unrelated tool
        // (ngit) that reported the same timeouts. damus.io stayed: it was intermittent rather than
        // silent, and answered on both machines within the same hour. nostr.mom and relay.nostr.net
        // replaced them after answering three out of three attempts each.
        //
        // relay.snort.social was dropped in v23.0.1 because it keeps nothing. It is memlay, and
        // says so itself: "High-performance in-memory Nostr relay", supported_nips [1, 11]. Asked
        // for kind 1 older than 90 days it returns nothing, where the other five return a full
        // page going back past a year; asked for kind 1111 older than 30 days, the same nothing.
        //
        // That is the wrong shape of relay for this. A comment system is a promise that the thread
        // is still there next month, and a relay that accepts a comment and loses it on the next
        // restart looks like it worked, which is worse than refusing. It was spending a socket on
        // every page to serve recent events that four of the others already hold.
        //
        // nostr.oxtr.dev replaced it: strfry, no auth and no payment, history past a year, and it
        // answered three out of three attempts. damus.io stayed again, for the reason it stayed in
        // v22.59 — it failed outright on one of today's runs and served fine on the next, and it
        // does keep history. Intermittent is still not the same as silent.
        //
        // Six is deliberate, not arbitrary: every relay here is a socket on every page that gets
        // read, so this list is a running cost for every user.
        const DEFAULT_RELAYS = ['wss://nos.lol','wss://relay.damus.io','wss://relay.primal.net','wss://nostr.oxtr.dev','wss://nostr.mom','wss://relay.nostr.net'];
        // Relays dropped from the defaults because they stopped answering, not because of taste.
        //
        // A saved list wins over DEFAULT_RELAYS, and it should: it is a choice somebody made. But
        // saveRelays() only runs when a relay is added or removed, so that choice froze on the day
        // it was made, dead relays and all. Anyone who touched this list before v22.59 is still
        // opening a socket to relay.nostr.band and offchain.pub on every page they read, still
        // waiting out both timeouts, with nothing on screen to say why the thread is thin.
        //
        // So these are stripped once and the fact of it is recorded. Nothing else is touched.
        // Topping the list back up to the current defaults is the tempting other half and the
        // wrong one: a relay somebody removed on purpose would come back, and there is no way to
        // tell that apart from one that was never added. The exception is a list left with nothing
        // in it, which is not a preference — it is an extension that can no longer reach anything.
        //
        // damus.io is deliberately not on this list. It answers 503 some days and serves fine on
        // others, and v22.59 already made the call that intermittent is not the same as silent.
        const DEAD_RELAYS = ['wss://relay.nostr.band','wss://offchain.pub'];
        const RELAY_MIGRATION = 1;
        function migrateRelays(saved, alreadyDone) {
            if (!Array.isArray(saved) || !saved.length) return {list: [...DEFAULT_RELAYS], retired: 0, save: false};
            // Cleaned on the way in as well as on the way out: a list saved before v22.59 can
            // already hold the same relay twice, and that costs a socket on every page.
            const list = dedupeRelays(saved);
            if (alreadyDone) return {list, retired: 0, save: false};
            const dead = new Set(DEAD_RELAYS.map(normRelay));
            const kept = list.filter(u => !dead.has(normRelay(u)));
            const retired = list.length - kept.length;
            return {list: kept.length ? kept : [...DEFAULT_RELAYS], retired, save: retired > 0};
        }
        // How many were retired on this load, so Settings can say so once rather than change
        // somebody's own list behind their back.
        let relaysRetired = 0;
        let relaysNeedSave = false;
        let RELAYS = (() => {
            try {
                const saved = _st.nostrcomments_relays;
                const done = _st.nostrcomments_relaymig >= RELAY_MIGRATION;
                // These are function declarations, so they are hoisted and callable here.
                const m = migrateRelays(saved, done);
                relaysRetired = m.retired;
                relaysNeedSave = m.save;
                return m.list;
            } catch(e) { return [...DEFAULT_RELAYS]; }
        })();
        // wss://relay.example.com and wss://relay.example.com/ are the same relay, and the check
        // on adding one was a literal string comparison — so both could sit in the list and the
        // extension would open two sockets to it on every page. Hosts are case-insensitive and
        // paths are not, so only the scheme and host are lowercased.
        function normRelay(u) {
            const s = String(u).trim();
            try {
                const x = new URL(s);
                return x.protocol.toLowerCase() + '//' + x.host.toLowerCase() + x.pathname.replace(/\/+$/, '') + x.search;
            } catch(e) { return s.replace(/\/+$/, ''); }
        }
        function dedupeRelays(list) {
            const out = [];
            for (const u of list) { const n = normRelay(u); if (n && !out.includes(n)) out.push(n); }
            return out;
        }

        function saveRelays() { chrome.storage.local.set({nostrcomments_relays: RELAYS}); }

        // The marker is written whether or not anything was removed, so this runs once instead of
        // on every page. The list itself is only written back when it actually changed: creating a
        // saved list for somebody who never had one would freeze them at today's defaults, which is
        // the whole bug being undone here.
        if (_st.nostrcomments_relaymig !== RELAY_MIGRATION) {
            const _patch = {nostrcomments_relaymig: RELAY_MIGRATION};
            if (relaysNeedSave) _patch.nostrcomments_relays = RELAYS;
            try { chrome.storage.local.set(_patch); } catch(e) {}
        }


        // Relays that receive comments but are never read from.
        //
        // Measured 14 Aug 2026 over the previous 180 days, counting only comments carrying the tag
        // shape this extension writes — I,K,i,k or I,K,e,k,p and nothing else — since the wider
        // NIP-22 web corpus on these relays is mostly one CLI client and says nothing about us.
        // Of those 86 comments, from 27 keys: 20% sat on exactly one relay, 34% on two, 42% on
        // three. One in five is one operator's decision away from gone, which is the single thing
        // this extension exists not to be. It also only counts what still exists, so it flatters
        // the truth — anything already erased could not be counted, and that is not hypothetical:
        // this was found because a comment on 20min.ch had gone, with the vote on it still there.
        //
        // The six-relay ceiling was reasoned from reading: every relay is a socket on every page
        // that gets read. Publishing has the opposite shape — reading happens constantly, writing
        // happens when somebody actually writes something — so the write set can be wider at
        // almost no running cost. That asymmetry was going unused.
        //
        // All three answered on three of three attempts, hold history past a year, and ask for no
        // payment, proof-of-work or identification. nostr21.com was measured and rejected: it sets
        // payment_required, so it would refuse these writes.
        const EXTRA_PUBLISH_RELAYS = ['wss://purplerelay.com','wss://relay.nostrplebs.com','wss://nostr.bitcoiner.social'];
        // Default on: the measurement says the common case is a comment on one or two relays, and
        // somebody who has never thought about relays is exactly who that costs.
        //
        // Declared here rather than beside the migration, because relaymigration.test.mjs evaluates
        // everything between DEFAULT_RELAYS and RELAYS with no _st in scope. Putting a storage read
        // in that range breaks the suite, which is a good enough reason to keep it out.
        let publishWide = _st.nostrcomments_widepublish !== false;

        // What each relay is actually doing. A relay that never answers looked exactly like a relay
        // with nothing to say: the thread was thinner and slower and nothing said why. Sockets fail
        // quietly here — onerror closes, onclose retries and gives up after six attempts — so
        // without this the only symptom is an emptier panel.
        //
        // "answered" means it sent EOSE, not merely that the socket opened. A relay can accept a
        // connection and never reply, and those are different problems.
        const relayState = new Map();     // url -> { state, events }
        function setRelayState(url, state, bump) {
            const cur = relayState.get(url) || { state: 'idle', events: 0 };
            relayState.set(url, { state, events: bump ? cur.events + 1 : (state === 'connecting' ? 0 : cur.events) });
            // Only repaint what somebody is looking at.
            if (settings && settings.style.display === 'block') renderRelayList();
        }

        // Some sites forbid the connections this extension needs. x.com's Content-Security-Policy
        // names every host its own code may reach and nothing else, so every relay socket is
        // refused before it opens.
        //
        // Chrome exempts a content script's requests from the page's policy. Firefox does not, for
        // WebSockets — so on Firefox a strict connect-src silently emptied the panel, and what the
        // reader saw was "No comments yet – be the first!", which is the one thing that is
        // certainly not true. Reported from real use on x.com, where all six relays sat at "not
        // contacted yet" with nothing saying why.
        //
        // Nothing can be done about it from inside the page: the socket would have to be opened
        // somewhere the page's policy does not reach, which means a background worker. Until then
        // the panel can at least stop blaming the absence of comments.
        const _relayHost = u => { try { return new URL(u).host; } catch(e) { return ''; } };
        document.addEventListener('securitypolicyviolation', e => {
            if (!/^connect-src/.test(e.effectiveDirective || e.violatedDirective || '')) return;
            const host = _relayHost(e.blockedURI);
            if (!host) return;
            let hit = false;
            for (const r of RELAYS) if (_relayHost(r) === host) { setRelayState(r, 'blocked'); hit = true; }
            // The thread has already drawn its empty state by now, and setRelayState only repaints
            // the relay list. Without this the panel keeps saying nobody has commented while the
            // settings page says the site is blocking every relay.
            if (hit) scheduleRender();
        });
        function relaysBlocked() {
            let n = 0;
            for (const r of RELAYS) if ((relayState.get(r) || {}).state === 'blocked') n++;
            return n;
        }

        function renderRelayList() {
            relayListEl.replaceChildren();
            RELAYS.forEach(r => {
                const item = document.createElement('div');
                item.className = 'relay-item';
                // The URL gets its own element so that selecting it copies the URL and not the
                // status line, and so that reading it back does not concatenate the two.
                const label = document.createElement('span');
                label.className = 'relay-info';
                const url = document.createElement('span');
                url.className = 'relay-url';
                url.textContent = r;
                label.appendChild(url);
                const st = relayState.get(r) || { state: 'idle', events: 0 };
                const status = document.createElement('span');
                status.className = 'relay-state ' + st.state;
                // Said plainly, because "answered with nothing" and "never answered" are different
                // things and the difference is the whole point of showing this.
                status.textContent =
                    st.state === 'answered'    ? (st.events ? `answered · ${st.events}` : 'answered · nothing here')
                  : st.state === 'connecting'  ? 'connecting…'
                  : st.state === 'failed'      ? 'no answer'
                  : st.state === 'unreachable' ? 'gave up'
                  : st.state === 'blocked'     ? 'blocked by this site'
                  : 'not contacted yet';
                status.title =
                    st.state === 'answered'    ? 'This relay replied to the query for this page.'
                  : st.state === 'connecting'  ? 'Connected, waiting for a reply.'
                  : st.state === 'failed'      ? 'The connection closed before this relay answered. Retrying.'
                  : st.state === 'unreachable' ? 'No answer after several attempts. Reload the page to try again.'
                  : st.state === 'blocked'     ? "This site's security policy forbids connections to this relay. It is the site refusing, not the relay."
                  : 'Not contacted yet on this page — relays are only used once a page is actually read.';
                label.appendChild(status);
                const removeBtn = document.createElement('button');
                removeBtn.className = 'relay-remove';
                removeBtn.textContent = '×';
                removeBtn.onclick = () => { RELAYS = RELAYS.filter(x => x !== r); saveRelays(); renderRelayList(); showMsg('Relay removed — reload page to apply'); };
                item.append(label, removeBtn);
                relayListEl.appendChild(item);
            });
        }

        // A settings list that vanishes when it is empty makes "you have muted nobody" and "this
        // cannot mute anybody" look the same, and there is no way to tell them apart from the
        // outside. Reported by somebody sent to Settings by a thread saying its comments were
        // hidden behind a mute, who arrived and found no such section at all.
        function emptyNote(text) {
            const p = document.createElement('p');
            p.className = 'nc-hint';
            p.textContent = text;
            return p;
        }

        function renderMutedList() {
            const mutedList = s.getElementById('muted-list');
            const mutedSection = s.getElementById('muted-section');
            mutedSection.style.display = 'block';
            mutedList.replaceChildren();
            if (mutedPubkeys.size === 0) {
                mutedList.appendChild(emptyNote('Nobody is muted. Use 🚫 Mute under a comment to hide everything from its author.'));
                return;
            }
            mutedPubkeys.forEach(pub => {
                const item = document.createElement('div');
                item.className = 'muted-item';
                const label = document.createElement('span');
                label.textContent = profiles.get(pub) || toNpub(pub).slice(0,12)+'…';
                const unmuteBtn = document.createElement('button');
                unmuteBtn.className = 'unmute-btn';
                unmuteBtn.textContent = 'Unmute';
                unmuteBtn.onclick = () => { mutedPubkeys.delete(pub); saveMuted(); renderMutedList(); render(); showMsg('User unmuted'); };
                item.append(label, unmuteBtn);
                mutedList.appendChild(item);
            });
        }

        async function renderDisabledList() {
            const listEl = s.getElementById('disabled-list');
            const sectionEl = s.getElementById('disabled-section');
            const _d = await chrome.storage.local.get('nostrcomments_disabled');
            const arr = Array.isArray(_d.nostrcomments_disabled) ? _d.nostrcomments_disabled : [];
            sectionEl.style.display = 'block';
            listEl.replaceChildren();
            if (arr.length === 0) {
                listEl.appendChild(emptyNote('NostrComments is switched on everywhere. "Disable on this site" below adds one here.'));
                return;
            }
            arr.forEach(origin => {
                const item = document.createElement('div');
                item.className = 'muted-item';
                const label = document.createElement('span');
                label.textContent = origin;
                const enableBtn = document.createElement('button');
                enableBtn.className = 'unmute-btn';
                enableBtn.type = 'button';
                enableBtn.textContent = 'Enable';
                enableBtn.onclick = async () => {
                    const _c = await chrome.storage.local.get('nostrcomments_disabled');
                    const next = (Array.isArray(_c.nostrcomments_disabled) ? _c.nostrcomments_disabled : []).filter(o => o !== origin);
                    await chrome.storage.local.set({nostrcomments_disabled: next});
                    renderDisabledList();
                    showMsg('Site enabled — reload it to see the button');
                };
                item.append(label, enableBtn);
                listEl.appendChild(item);
            });
        }

        const openSettings = async () => {
            settings.style.display = 'block';
            gearBtn.classList.add('active');
            renderRelayList();
            renderMutedList();
            renderDisabledList();
            renderMuteWords();
            if (localWallet || encPriv) {
                keypairSection.style.display = 'block';
                if (localWallet) {
                    const _d = await chrome.storage.local.get('nostrcomments_privkey');
                    if (!_isEncPriv(_d.nostrcomments_privkey)) setPrivHex(_d.nostrcomments_privkey || '');
                } else {
                    _privHex = '';
                }
                hidePrivkey();
            }
            refreshPwBtn();
            updateBackupUI();
            // Said once, in the panel that shows the list it changed. Quietly editing somebody's
            // own configuration is the same silence this release is about.
            if (relaysRetired) {
                showMsg(relaysRetired === 1
                    ? 'Removed a relay from your list that no longer answers. Add it back below if you disagree.'
                    : `Removed ${relaysRetired} relays from your list that no longer answer. Add them back below if you disagree.`, true);
                relaysRetired = 0;
            }
        };
        // Four lists in Settings say things about the reader that the page has no business reading,
        // and the shadow root is open by design (audit H1). They are only built when Settings is
        // opened — but they were never taken down again, so opening it once left them readable for
        // the rest of that page's life.
        //
        // The disabled-site list is the sharpest of them: it is a list of *other* sites the reader
        // visits, which is browsing history sitting in the DOM of one of them. Muted words can be a
        // name, an illness or a politician. Muted keys are a blocklist. And a relay list is only
        // dull while it is the default one — somebody running their own relay has their domain in
        // there.
        function clearSettingsDom() {
            for (const id of ['relay-list', 'muted-list', 'disabled-list', 'muteword-list']) {
                const el = s.getElementById(id);
                if (el) el.replaceChildren();
            }
        }
        const closeSettings = () => {
            settings.style.display = 'none';
            gearBtn.classList.remove('active');
            // Leaving the key revealed for the next time Settings is opened would undo the point
            // of hiding it: the next person to open this panel is not necessarily the same person.
            hidePrivkey();
            clearSettingsDom();
        };
        gearBtn.onclick = async () => {
            if (settings.style.display === 'block') closeSettings();
            else await openSettings();
        };
        settingsClose.onclick = closeSettings;

        relayInput.onkeydown = e => { if (e.key === 'Enter') relayAddBtn.onclick(); };
        relayAddBtn.onclick = () => {
            const url = normRelay(relayInput.value);
            if (!url.startsWith('wss://') || url.length < 10) return showMsg('Enter a valid wss:// URL');
            if (RELAYS.includes(url)) return showMsg('Relay already in list');
            RELAYS.push(url);
            saveRelays();
            relayInput.value = '';
            renderRelayList();
            showMsg('Relay saved — reload page to connect');
        };

        const muteWordInput = s.getElementById('muteword-input');
        const muteWordAddBtn = s.getElementById('muteword-add-btn');
        function renderMuteWords() {
            const listEl = s.getElementById('muteword-list');
            listEl.replaceChildren();
            muteWords.forEach(w => {
                const item = document.createElement('div');
                item.className = 'relay-item';
                const label = document.createElement('span');
                label.textContent = w;
                const removeBtn = document.createElement('button');
                removeBtn.className = 'relay-remove'; removeBtn.type = 'button';
                removeBtn.textContent = '×'; removeBtn.setAttribute('aria-label', 'Remove muted word');
                removeBtn.onclick = () => { muteWords = muteWords.filter(x => x !== w); saveMuteWords(); renderMuteWords(); render(); };
                item.append(label, removeBtn);
                listEl.appendChild(item);
            });
        }
        muteWordInput.onkeydown = e => { if (e.key === 'Enter') muteWordAddBtn.onclick(); };
        muteWordAddBtn.onclick = async () => {
            const w = muteWordInput.value.trim().toLowerCase();
            if (!w) return;
            // This one is never published. It would still be stored in plain text, outside every
            // path that handles keys — so "Delete keypair" would not remove it and the at-rest
            // password would not cover it. A key that survives deleting the key is worth refusing.
            if (await carriesPrivateKey(w)) return showMsg(PRIVKEY_WARNING);
            if (muteWords.includes(w)) return showMsg('Word already muted');
            muteWords.push(w);
            saveMuteWords();
            muteWordInput.value = '';
            renderMuteWords();
            render();
            showMsg('Word muted');
        };


        // Normalize a page URL into a stable thread key: strip known tracking params (so
        // ?utm_…/fbclid don't fragment threads) but keep meaningful params (e.g. YouTube's
        // ?v=…), sort the rest for order-independence, and keep only hash-router fragments.
        const _TRACKING = new Set(['gclid','gbraid','wbraid','dclid','fbclid','msclkid','yclid','twclid','igshid','mc_eid','mc_cid','_ga','_gl','mkt_tok','ref_src','ref_url','si','spm','scm','vero_id','oly_anon_id','oly_enc_id','_openstat','wickedid']);
        function normalizeUrl(href) {
            try {
                const u = new URL(href);
                const p = u.searchParams;
                // NB: collect keys via forEach — spreading the searchParams keys() iterator
                // is not supported in Firefox content scripts and would throw and abort init.
                const del = [];
                p.forEach((_v, k) => { const kl = k.toLowerCase(); if (_TRACKING.has(kl) || kl.startsWith('utm_') || kl.startsWith('ga_')) del.push(k); });
                del.forEach(k => p.delete(k));
                p.sort();
                const qs = p.toString();
                const hash = (u.hash.startsWith('#/') || u.hash.startsWith('#!')) ? u.hash : '';
                return u.origin + u.pathname + (qs ? '?' + qs : '') + hash;
            } catch(_) {
                return location.origin + location.pathname;
            }
        }
        let pageUrl = normalizeUrl(location.href);

        // A thread is filed under the normalised address, not under what is in the address bar, and
        // the two disagree more often than it looks: an anchor is dropped, tracking parameters are
        // removed, query parameters are sorted. Somebody who followed a link to #section-3 is
        // reading one part of an article and commenting on all of it, and nothing said so.
        //
        // Only shown when they actually differ. On most pages they do not, and a line repeating the
        // address bar is the kind of clutter that teaches people to stop reading the panel.
        const shortKey = u => {
            const bare = u.replace(/^https?:\/\//, '');
            return bare.length <= 58 ? bare : bare.slice(0, 30) + '…' + bare.slice(-24);
        };
        function paintPageKey() {
            const el = s.getElementById('pagekey');
            if (!el) return;
            if (pageUrl === location.href) { el.style.display = 'none'; el.textContent = ''; el.removeAttribute('title'); return; }
            el.textContent = 'Thread for ' + shortKey(pageUrl);
            el.title = pageUrl + '\n\nAnchors and tracking parameters are left out, so everyone reading this page lands in the same thread.';
            el.style.display = 'block';
        }
        // One filter per kind, each with its own budget, rather than one filter for all three.
        // A relay honours `limit` by returning the newest events that match, so a shared budget
        // is spent by whichever kind is most numerous — and reactions outnumber comments by a
        // lot. A hundred comments with five votes each is six hundred events: past the cap, and
        // the ones dropped were the oldest comments. They were on the relay the whole time, and
        // nothing said they were missing.
        const COMMENT_LIMIT = 500, REACTION_LIMIT = 3000;

        // Comments are NIP-22 (kind 1111) scoped to this page through an uppercase I tag, with
        // K = "web" as NIP-73 defines for a URL. Reactions and deletions are not NIP-22 events and
        // have no page of their own, so they carry an r tag with the page URL — our convention, not
        // a standard one, and the only way a live subscription can ask for "reactions here".
        //
        // Hence two shapes: the page subscription asks by I for comments and by r for the rest,
        // while the refetch asks all three by the comment ids it already knows.
        const NOTE_EXPLANATION = 'This is an ordinary Nostr note that links to this page, not a comment written here. You can vote on it, and “Reply on Nostr” opens it where its author will see your answer.';
        const COMMENT_KIND = 1111;
        // Kind 1 notes carrying an r tag for this page are read as well, and never written.
        //
        // Not for our own history — that is tiny — but because an r-tagged note is how the rest of
        // Nostr talks about a URL, from any client, and asking only for 1111 made all of it
        // invisible. It also closed a gap the notifications could not: they listen on kind 1 too,
        // so a mention in an ordinary note lit the badge while the thread had nowhere to show it.
        //
        // Read-only is not squeamishness. NIP-22: "Comments MUST NOT be used to reply to kind 1
        // notes." So a 1111 may not hang off one of these, and replying in kind would put the reply
        // back in everybody's feed, which is the thing kind 1111 exists to stop.
        const LEGACY_KIND = 1;
        const isLegacy = ev => ev.kind === LEGACY_KIND;
        // NIP-10, read from the NIPs repository rather than from memory:
        //   ["e", <id>, <relay>, <marker>, <pubkey>]  with marker "root" or "reply"
        //   "A direct reply to the root of a thread should have a single marked 'e' tag of type
        //   'root'."
        // So the root has to be found before a reply can be tagged. Take it from the parent's own
        // tags, which is what every other client publishes and reads: an explicit "root" marker if
        // there is one, otherwise the first e tag under the deprecated positional scheme. No e tags
        // at all means the parent is itself the root.
        // NIP-10: "the reply event's p tags should contain all of E's p tags as well as the pubkey
        // of the event being replied to." Capped, because these are copied out of an event a relay
        // handed us into one signed with the user's key, and an event carrying three hundred p tags
        // would turn a reply into a notification broadcast under somebody else's name.
        //
        // The reply strip says how many people this will reach, and it reads that from here rather
        // than counting for itself — a number worked out separately is a number that can drift from
        // the one actually published, and then the panel is stating something that is not so.
        //
        // Array.isArray rather than `|| []`: a signature covers an event's serialisation, not its
        // shape, so `tags` can be a string and still verify. `.filter` on that throws.
        const NOTIFY_CAP = 20;
        const notifyList = ev => {
            const raw = [ev.pubkey, ...(Array.isArray(ev.tags) ? ev.tags : [])
                .filter(t => Array.isArray(t) && t[0] === 'p').map(t => t[1])]
                .filter(k => /^[0-9a-f]{64}$/i.test(k || ''));
            const all = [...new Set(raw)];
            return { all, kept: all.slice(0, NOTIFY_CAP) };
        };
        const nip10Root = ev => {
            const es = (ev.tags || []).filter(t => t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] || ''));
            if (!es.length) return null;
            return (es.find(t => t[3] === 'root') || es[0])[1];
        };
        const pageFilters = () => [
            {kinds:[COMMENT_KIND], "#I":[pageUrl], limit: COMMENT_LIMIT},
            {kinds:[LEGACY_KIND], "#r":[pageUrl], limit: COMMENT_LIMIT},
            {kinds:[5], "#r":[pageUrl], limit: COMMENT_LIMIT},
            {kinds:[7], "#r":[pageUrl], limit: REACTION_LIMIT},
        ];
        const refetchFilters = ids => [
            {kinds:[COMMENT_KIND], "#e": ids, limit: COMMENT_LIMIT},
            {kinds:[LEGACY_KIND], "#e": ids, limit: COMMENT_LIMIT},
            {kinds:[5], "#e": ids, limit: COMMENT_LIMIT},
            {kinds:[7], "#e": ids, limit: REACTION_LIMIT},
        ];

        let pageGen = 0;
        let _wsPool = [];
        const subId = 'nc' + Math.random().toString(36).slice(2, 8);

        let myPub = null;
        // Set when a relay asked us to identify before there was any identity to offer. connect()
        // reopens the thread once there is, which is the only way back — the relay will not repeat
        // its refusal unless we ask again.
        let _authWanted = false;

        const comments = [];
        let _lastSeenMap = (_st.nostrcomments_lastseen && typeof _st.nostrcomments_lastseen === 'object') ? _st.nostrcomments_lastseen : {};
        let _newSince = 0;
        const scores = new Map();
        const votes = new Map(); // eventId -> Map(voterPubkey -> {val, at}), one vote per person
        // The per-voter map is the only source of truth for a score. Counting from it means an
        // optimistic vote and one arriving from a relay can never disagree, and it is what lets us
        // recognise your own vote after a reload — without that the arrows looked untouched, so
        // voting again seemed possible and quietly published a second reaction.
        function recount(id) {
            const m = votes.get(id);
            if (!m) return;
            let up = 0, down = 0;
            m.forEach(v => { if (v.val === 1) up++; else down++; });
            scores.set(id, {up, down, my: myPub ? m.get(myPub)?.val : undefined});
        }
        function recountAll() { votes.forEach((_m, id) => recount(id)); }
        const profiles = new Map();
        // The name this panel shows and the name its field edits have to be the same field, or
        // changing it looks like it did nothing. Kind 0 also carries display_name — half of all
        // profiles set one, and a third of those set it to something other than name — so the raw
        // fields of the one identity that can be edited here are kept, to fill the field with what
        // the button actually changes rather than with whatever happens to be on the card.
        let myProfileRaw = { pub: null, data: null };
        const profileAt = new Map();       // pubkey -> created_at of the kind 0 currently applied
        let namePrefill = null;            // what was filled in last, so typing is never overwritten
        const nip05s = new Map();          // pubkey -> the name@domain a profile claims
        const nip05ok = new Map();         // pubkey -> true / false / null while in flight
        // Off unless asked for. Checking a NIP-05 name means fetching from the domain it claims,
        // once per commenter, which tells that domain someone is reading a page where that person
        // commented — and hands it the reader's IP. That is a third party this extension otherwise
        // never touches, so it is a choice rather than a default.
        let nip05Check = _st.nostrcomments_nip05 === true;
        // NIP-05 identifiers name a domain, so anything that is not a plain domain name is refused
        // rather than carefully parsed. The pattern below used to be the only check, and it let
        // through more than it looks: a port, an IPv6 literal in brackets, and any bare address —
        // 192.168.1.1, 127.0.0.1, localhost, 169.254.169.254.
        //
        // That turns a profile into a way of knocking on the reader's own network. The answer is
        // unreadable across origins, but whether something answers at all, and how quickly, is not
        // information the author of a comment should be able to collect. Refusing every address
        // literal is both simpler and stricter than listing the ranges that matter, and it costs
        // nothing: an address is never a valid NIP-05 domain.
        //
        // nip05Host: start
        function nip05Host(raw) {
            if (typeof raw !== 'string' || !raw || raw.length > 253) return null;
            const h = raw.toLowerCase();
            // Anything that could steer the authority of the URL rather than name a host.
            if (/[:@[\]/\\?#%]/.test(h)) return null;
            if (h.startsWith('.') || h.endsWith('.') || h.includes('..')) return null;
            const labels = h.split('.');
            // One label is localhost and its kind; a NIP-05 domain always has a public suffix.
            if (labels.length < 2) return null;
            const tld = labels[labels.length - 1];
            // A numeric last label means an IPv4 address, and .local is mDNS on the local network.
            if (!/^[a-z][a-z0-9-]*$/.test(tld) || tld === 'local' || tld === 'localhost') return null;
            for (const l of labels) if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
            // Last word to the URL parser: it must read this back as exactly this host, no port.
            try { const u = new URL('https://' + h + '/'); if (u.hostname !== h || u.port) return null; }
            catch (_) { return null; }
            return h;
        }
        // nip05Host: end

        // Pictures named by somebody else's profile or comment. The same reasoning as nip05Host and
        // for the same reason: an address literal is the one form in which a stranger can aim a
        // request from the reader's browser at the reader's own network. A picture is a GET, and
        // there are devices on home networks that act on a GET.
        //
        // Mixed-content blocking already stops http subresources on an https page, so the window
        // this closes is narrow — but it costs a few lines, and "a comment made your browser talk to
        // your router" is not a sentence worth having to write later.
        //
        // safeMediaUrl: start
        function safeMediaUrl(raw) {
            if (typeof raw !== 'string' || !raw || raw.length > 2048) return null;
            let u;
            try { u = new URL(raw.trim()); } catch (_) { return null; }
            if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
            if (u.username || u.password) return null;
            const h = u.hostname.toLowerCase();
            if (!h || h.startsWith('[')) return null;                       // IPv6 literal
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return null;             // IPv4 literal
            if (!h.includes('.')) return null;                              // localhost and its kind
            const tld = h.slice(h.lastIndexOf('.') + 1);
            if (tld === 'local' || tld === 'localhost' || !/^[a-z]/.test(tld)) return null;
            return u.href;
        }
        // safeMediaUrl: end

        async function verifyNip05(pubkey) {
            if (!nip05Check || nip05ok.has(pubkey)) return;
            const m = /^([^@\s]+)@([^@\s/]+)$/.exec(nip05s.get(pubkey) || '');
            if (!m) return;
            const host = nip05Host(m[2]);
            // Recorded as failed rather than left pending: a claim that cannot be checked must not
            // sit there looking like one that is still being checked.
            if (!host) { nip05ok.set(pubkey, false); scheduleRender(); return; }
            nip05ok.set(pubkey, null);
            try {
                const res = await fetch(`https://${host}/.well-known/nostr.json?name=${encodeURIComponent(m[1])}`);
                const data = await res.json();
                nip05ok.set(pubkey, data?.names?.[m[1]] === pubkey);
            } catch(e) { nip05ok.set(pubkey, false); }
            scheduleRender();
        }
        const nip05Toggle = s.getElementById('nip05-toggle');
        nip05Toggle.checked = nip05Check;
        nip05Toggle.onchange = () => {
            nip05Check = nip05Toggle.checked;
            chrome.storage.local.set({nostrcomments_nip05: nip05Check});
            if (nip05Check) nip05s.forEach((_id, pub) => verifyNip05(pub));
            else { nip05ok.clear(); render(); }   // turning it off puts the marks away at once
            showMsg(nip05Check ? 'Verified names on — commenters\' domains will be contacted'
                               : 'Verified names off — no domain will be contacted');
        };
        const widepubToggle = s.getElementById('widepub-toggle');
        widepubToggle.checked = publishWide;
        widepubToggle.onchange = () => {
            publishWide = widepubToggle.checked;
            chrome.storage.local.set({nostrcomments_widepublish: publishWide});
            showMsg(publishWide ? 'Extra relays on — what you post goes to three more, and is read from none of them'
                                : 'Extra relays off — what you post goes only to the relays listed above');
        };

        const avatars = new Map();
        const lud16s = new Map();
        let localWallet = null;
        let mutedPubkeys = new Set(_st.nostrcomments_muted || []);
        function saveMuted() { chrome.storage.local.set({nostrcomments_muted: [...mutedPubkeys]}); }
        let muteWords = Array.isArray(_st.nostrcomments_mutewords) ? _st.nostrcomments_mutewords.map(w => String(w).toLowerCase()) : [];
        function saveMuteWords() { chrome.storage.local.set({nostrcomments_mutewords: muteWords}); }
        let unreadReplies = 0;
        const _seenNotif = new Set();   // kept apart from the thread's, see queueVerify
        let q = '';
        let pageSize = 20;
        let replyTo = null;

        // NIP-01 profile fetching
        function fetchProfiles(pubkeys) {
            const missing = [...new Set(pubkeys)].filter(p => !profiles.has(p));
            if (!missing.length) return;
            missing.forEach(p => profiles.set(p, null));
            // Every configured relay, not the first two. A commenter whose profile happened to live
            // on the third relay stayed an npub with no avatar for the whole session, because a
            // pubkey is marked as asked-for the moment we ask and is never asked about again. That
            // looked like people not having profiles, and was us not looking.
            RELAYS.forEach(r => {
                try {
                    const ws = new WebSocket(r);
                    const pid = 'p' + Math.random().toString(36).slice(2, 6);
                    const t = setTimeout(() => ws.close(), 8000);
                    ws.onopen = () => ws.send(JSON.stringify(["REQ", pid, {kinds:[0], authors: missing}]));
                    ws.onmessage = m => {
                        let parsed;
                        try { parsed = JSON.parse(m.data); } catch(e) { return; }
                        const [type,,ev] = parsed;
                        if (type === 'EOSE') { clearTimeout(t); ws.close(); scheduleRender(); return; }
                        if (type !== 'EVENT' || ev?.kind !== 0) return;
                        if (typeof ev.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.pubkey)) return;
                        queueVerify(ev, () => {
                            try {
                                // Kind 0 is replaceable, so an old copy left on a slow relay is not
                                // extra information, it is a wrong answer. Every relay is asked and
                                // whichever replied last used to win, which meant one relay that
                                // had not caught up could put a name back after it was changed.
                                const seenAt = profileAt.get(ev.pubkey);
                                if (seenAt !== undefined && ev.created_at <= seenAt) return;
                                const p = JSON.parse(ev.content);
                                profileAt.set(ev.pubkey, ev.created_at);
                                // name first, display_name only as a fallback. NIP-24 says name
                                // should always be set; reading display_name first would mean a
                                // name published here changed nothing on screen for the third of
                                // profiles whose two fields differ.
                                profiles.set(ev.pubkey, p.name || p.display_name || null);
                                if (ev.pubkey === myPub) { myProfileRaw = { pub: ev.pubkey, data: p }; paintSetName(); }
                                if (p.lud16) lud16s.set(ev.pubkey, p.lud16);
                                if (typeof p.nip05 === 'string') { nip05s.set(ev.pubkey, p.nip05); verifyNip05(ev.pubkey); }
                                // Checked here rather than at each <img>: this map feeds both the
                                // comment avatars and the identity panel.
                                if (p.picture) { const pic = safeMediaUrl(p.picture); if (pic) avatars.set(ev.pubkey, pic); }
                                scheduleRender();
                            } catch(e) {}
                        });
                    };
                } catch(e) {}
            });
        }

        // NIP-07 bridge (isolated world → main world via CustomEvent)
        const _nip07q = {};
        document.addEventListener('nc_nip07_res', ({detail}) => {
            try {
                const d = typeof detail === 'string' ? JSON.parse(detail) : detail;
                const p = _nip07q[d.id]; if (!p) return; delete _nip07q[d.id];
                if (d.error) p.reject(new Error(d.error)); else p.resolve(d.result);
            } catch(e) {}
        });
        function _nip07(action, payload) {
            return new Promise((resolve, reject) => {
                const id = 'n' + Math.random().toString(36).slice(2);
                _nip07q[id] = {resolve, reject};
                // Two different waits, because two different things are being waited for. The
                // check is a round trip to a script in the page's own world — 800ms was too short
                // for a signer that had not finished injecting window.nostr, which the panel read
                // as "no signer", so it is 2.5s. Everything else waits for a person: the signer
                // puts a prompt on screen and it stays there until it is read and clicked. Five
                // seconds meant an approval that took a moment longer was thrown away along with
                // whatever had been typed. A minute is generous for a human and still bounded, so
                // a signer that never answers cannot leave the button disabled forever.
                setTimeout(() => { if (_nip07q[id]) { delete _nip07q[id]; reject(new Error('NIP-07 timeout')); } }, action === 'check' ? 2500 : 60000);
                document.dispatchEvent(new CustomEvent('nc_nip07', {detail: JSON.stringify({id, action, payload})}));
            });
        }
                const _isPubkey = v => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
        const nip07Wallet = {
            getPublicKey: async () => {
                const pub = await _nip07('getPublicKey', null);
                if (!_isPubkey(pub)) throw new Error('signer returned an invalid public key');
                return pub;
            },
            signEvent: ev => _nip07('signEvent', ev),
        };

        // The bridge to a NIP-07 signer runs on DOM events in the page's own world, so any script
        // on the page can answer in its place. That cannot be closed by a nonce or a token: there
        // is no secret a content script can hand to main-world code that the page cannot read
        // straight back out of it, so the channel itself is unauthenticatable.
        //
        // What it can do is stop taking the answer on trust. A signed event carries the pubkey that
        // actually signed it, and producing one for a key you do not hold is the thing the whole
        // protocol rests on being impossible. So the identity comes from the signature rather than
        // from getPublicKey, and a mismatch is corrected rather than believed. A signer that
        // switched account between the two calls lands in exactly the same place.
        // A NIP-07 provider that is switched off while the tab stays open leaves window.nostr
        // behind: the object belongs to the page, the extension behind it does not. The request is
        // accepted and then never answered, and every check that asks "is a signer present" still
        // says yes — including our own 'check', which reads !!window.nostr. So this state cannot be
        // probed for, only waited out. Four seconds in, say so and name the way out, instead of
        // leaving a disabled button, no message, and a minute of silence.
        //
        // Unconditional on purpose: a key held here signs in a millisecond, so the timer only ever
        // fires for a signer that is genuinely taking its time — or has stopped listening.
        const SIGNER_SLOW_MS = 4000;
        function watchSigner(p) {
            let warned = false;
            const t = setTimeout(() => {
                warned = true;
                showMsg(haveStoredKey
                    ? 'Your signer has not answered yet. Approve the request there — or switch to the key stored here, under ⚙ Settings.'
                    : 'Your signer has not answered yet. Approve the request there, or check that the signer extension is still enabled.', true);
            }, SIGNER_SLOW_MS);
            return Promise.resolve(p).then(
                v => { clearTimeout(t); if (warned) clearMsg(); return v; },
                e => { clearTimeout(t); throw e; });
        }

        async function signAsMe(ev) {
            const signed = await watchSigner(getWallet().signEvent(ev));
            if (!signed || typeof signed !== 'object' || !_isPubkey(signed.pubkey) ||
                typeof signed.id !== 'string' || typeof signed.sig !== 'string') {
                throw new Error('signer returned something that is not a signed event');
            }
            if (signed.pubkey !== myPub) {
                myPub = signed.pubkey;
                fetchProfiles([myPub]);
                paintIdentity(); recountAll(); startNotifSub(); render();
                showMsg('Signing as ' + toNpub(myPub).slice(0, 12) + '… — the panel has caught up');
            }
            return signed;
        }


        // Wallet auto-load, auto-connect and relay loading are all deferred to startNetwork(),
        // which only runs after the user has consented (see the consent gate above).

        // A stored key used to win unconditionally, which meant that having one silently disabled
        // your NIP-07 signer: switching accounts in nos2x had no effect at all, and the only way
        // back was to delete the local key. The choice is now explicit.
        // No field in this panel except the import box has any business receiving a private key,
        // and three of the fields that could receive one publish what they are given: a comment
        // goes to public relays, a name goes into a replaceable profile, and both are permanent and
        // signed by the very key being handed out. The nearest thing to a defence until now was
        // that the boxes sit apart on screen, which is not a defence.
        //
        // nsec1… is unambiguous — there is no legitimate reason to publish one — so it is refused
        // wherever it turns up. Bare 64-character hex is a different matter: an event id and a
        // pubkey look exactly the same, and people quote those. So hex is only refused when it is
        // actually the key this browser is holding, which is precise and has no false positives.
        // A key encrypted at rest cannot be compared against, so there only the nsec form is caught.
        async function carriesPrivateKey(text) {
            const t = String(text || '');
            if (/nsec1[02-9ac-hj-np-z]{20,}/i.test(t)) return true;
            if (!/[0-9a-f]{64}/i.test(t)) return false;
            try {
                const d = await chrome.storage.local.get('nostrcomments_privkey');
                const k = d.nostrcomments_privkey;
                if (typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k)) return t.toLowerCase().includes(k.toLowerCase());
            } catch(e) {}
            return false;
        }
        const PRIVKEY_WARNING = 'That looks like a private key. Nothing was sent — anyone who reads it could post as you forever. To use a key from another app, paste it under “Use an existing identity” instead.';

        function getWallet() {
            if (signerPref === 'nip07') return nip07Wallet;
            return localWallet || nip07Wallet;
        }

        // Whether a NIP-07 signer exists in this page. The userscript can read window.nostr
        // straight off the page and decide on the spot; here the bridge answers asynchronously and
        // the panel is painted long before it does. So the answer is remembered, and the panel
        // repainted when it changes — which button is lit depends on it.
        async function signerPresent() {
            let seen = false;
            try { seen = await _nip07('check', null) === true; } catch(e) {}
            // Signers get switched on and off while a page is open, so this answer is not settled
            // once. Both painters follow it — the onboarding block used to keep whatever it decided
            // at load, which is how a signer that finished injecting late was never offered.
            if (seen !== nip07Seen) { nip07Seen = seen; paintSignerChoice(); paintOnboard(); }
            return seen;
        }

        function updateNotifBadge() {
            nBadge.textContent = unreadReplies > 9 ? '9+' : String(unreadReplies);
            nBadge.style.display = unreadReplies > 0 ? 'block' : 'none';
        }

        // Call this whenever the identity changes. The filter pins a pubkey at subscribe time, so a
        // subscription started before a signer switch keeps watching an identity you no longer post
        // as — and reports nothing for the one you do, for the rest of the session. Each call
        // supersedes the last, which is also how it is torn down when a key is deleted.
        let _notifGen = 0;
        let _notifWs = [];
        function startNotifSub() {
            const gen = ++_notifGen;
            _notifWs.forEach(w => { try { w.close(); } catch(_) {} });
            _notifWs = [];
            if (!myPub) return;
            const since = Math.floor(Date.now() / 1000);
            const sid = 'ncn' + Math.random().toString(36).slice(2, 8);
            const watching = myPub;
            // Unlike the thread subscription this one lives for the whole session, so a socket that
            // drops — a sleeping laptop, a relay restart — used to end notifications silently and
            // permanently. Same capped backoff as the thread: retry, but not forever.
            const open = (r, attempt) => {
                if (gen !== _notifGen) return;
                let ws;
                try { ws = new WebSocket(r); } catch(e) { return; }
                _notifWs.push(ws);
                ws.onopen = () => { attempt = 0; ws.send(JSON.stringify(["REQ", sid, {kinds:[1, COMMENT_KIND], "#p":[watching], since}])); };
                ws.onmessage = m => {
                    if (gen !== _notifGen) return;
                    let parsed;
                    try { parsed = JSON.parse(m.data); } catch(e) { return; }
                    // Both kinds: replies to your comments are 1111, but somebody can still
                    // mention you in an ordinary note, and missing that would be a silent gap.
                    if (parsed[0] !== 'EVENT' || ![1, COMMENT_KIND].includes(parsed[2]?.kind)) return;
                    const ev = parsed[2];
                    if (ev.pubkey === watching) return;
                    if (typeof ev.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.pubkey)) return;
                    queueVerify(ev, () => {
                        // Already drawn in the thread you have open: announcing it is noise.
                        if (comments.some(c => c.id === ev.id)) return;
                        unreadReplies++;
                        updateNotifBadge();
                    }, _seenNotif);
                };
                ws.onerror = () => { try { ws.close(); } catch(_) {} };
                ws.onclose = () => {
                    const i = _notifWs.indexOf(ws); if (i >= 0) _notifWs.splice(i, 1);
                    if (gen !== _notifGen || attempt >= 6) return;
                    setTimeout(() => open(r, attempt + 1), Math.min(30000, 2000 * (2 ** attempt)));
                };
            };
            RELAYS.slice(0, 3).forEach(r => open(r, 0));
        }

        let connecting = false;
        async function connect() {
            if (!hasConsent || connecting) return;
            connecting = true;
            const wallet = getWallet();
            if (!wallet) { connecting = false; return status.textContent = "Install Alby/nos2x"; }
            try {
                myPub = await wallet.getPublicKey();
                fetchProfiles([myPub]); paintIdentity();
                // Votes may already have loaded while nobody was connected; now that we know who
                // you are, work out which of them are yours.
                recountAll(); render();
                status.className = 'ok';
                paintOnboard();
                startNotifSub();
                if (_authWanted) { _authWanted = false; loadPage(); }
            } catch(e) { status.textContent = "Couldn't connect — check your Nostr signer"; status.className = 'err'; }
            connecting = false;
        }
        connectBtn.onclick = connect;

        // A NIP-07 signer can switch accounts at any time, and nothing tells us when it does.
        // myPub was read once at connect, so the extension would keep believing you are the old
        // identity: your own comments stop being recognised as yours, the delete button disappears
        // from them, and the event we hand the signer carries a pubkey it no longer controls.
        // Re-read it before anything that signs, and adjust if it moved.
        async function syncIdentity() {
            const w = getWallet();
            if (!w || w === localWallet) return myPub;   // a local key cannot change under us
            try {
                // An optimistic read over the unauthenticatable bridge: good enough to keep the
                // panel current when somebody really does switch account, and backstopped by
                // signAsMe, which takes the identity from the signature before anything is
                // published under it.
                const now = await w.getPublicKey();
                if (now && now !== myPub) {
                    myPub = now;
                    fetchProfiles([myPub]); paintIdentity();
                    recountAll();
                    startNotifSub();   // the old one is pinned to the identity you just left
                    showMsg('Signer switched account — now posting as ' + toNpub(myPub).slice(0, 12) + '…');
                    render();
                }
                return myPub;
            } catch(e) { return myPub; }
        }

        function saveSigner() { chrome.storage.local.set({nostrcomments_signer: signerPref}); }
        // One place that decides how the current identity is shown. It used to be five copies of
        // `Connected …${myPub.slice(-8)}` — the tail of the hex key, which tells a person nothing
        // about who they are posting as. Prefer the profile name, then the npub, and keep hex for
        // the cases that actually need it.
        const identityCard = s.getElementById('identity-card');
        const identityAvatar = s.getElementById('identity-avatar');
        const identityName = s.getElementById('identity-name');
        const identityNpub = s.getElementById('identity-npub');
        const identityHex = s.getElementById('identity-hex');
        const identityHexToggle = s.getElementById('identity-hex-toggle');
        const identityCopyHex = s.getElementById('identity-copy-hex');
        function shortNpub(np) { return np.slice(0, 10) + '…' + np.slice(-6); }
        // Your public key is public by design, and it was still in the page's reach on every site
        // you visited, whether or not you ever opened the panel: the status line, the npub, the hex,
        // and your profile name if you published one. The shadow root is open on purpose — closing
        // it is mostly theatre, see docs/SECURITY-AUDIT-2026-08.md H1 — and the rule adopted there
        // instead was "nothing sensitive goes in the DOM". That audit was about the private key, so
        // the public one was left where it was.
        //
        // It should not have been. Being public is not the same as being linkable: a site that
        // reads npub1… learns which pseudonym is reading it, on every page, without the reader ever
        // posting a word. That is a different party from the relays, who are chosen and disclosed.
        //
        // So these strings exist only while somebody is looking at them. Watched rather than hooked
        // to the button, because the panel is also opened by setting the style directly — which is
        // how every browser suite opens it, and an escape hatch for tests would mean shipping
        // something other than what is tested.
        const panelOpen = () => modal.style.display === 'grid';
        function clearIdentityDom() {
            status.textContent = ''; status.className = '';
            identityName.textContent = ''; identityNpub.textContent = ''; identityHex.textContent = '';
            identityAvatar.style.display = 'none'; identityAvatar.removeAttribute('src');
        }
        let _panelWasOpen = false;
        new MutationObserver(() => {
            const open = panelOpen();
            if (open === _panelWasOpen) return;
            _panelWasOpen = open;
            if (!open) { clearIdentityDom(); clearSettingsDom(); return; }
            // Re-ask whether a signer is in the page. Cheaper and more reliable than polling: the
            // onboarding block is only worth being right about while somebody is looking at it, and
            // signers get switched on and off underneath us. This sits on the observer rather than
            // the button's click handler because the panel is also opened by setting the style, and
            // a re-check that only fires on one of those paths is a re-check that will be missed.
            signerPresent().catch(() => {});
            paintIdentity();
            // Settings can still be showing from before the panel was shut; its lists were emptied
            // on the way out, so they have to be rebuilt rather than left blank.
            if (settings.style.display === 'block') { renderRelayList(); renderMutedList(); renderDisabledList(); renderMuteWords(); }
        }).observe(modal, {attributes: true, attributeFilter: ['style']});

        function paintIdentity() {
            // Once you are connected the button has nothing left to offer. It was disabled but kept
            // its full primary styling, so it read as a live call to action that ignored clicks.
            // Deriving it from the identity here means every path that changes one gets it right.
            connectBtn.style.display = myPub ? 'none' : '';
            paintOnboard();
            paintSignerChoice();
            // Structural state above is safe to keep current; anything that names the reader waits.
            if (!panelOpen()) return clearIdentityDom();
            if (!myPub) {
                status.textContent = 'Not connected';
                status.className = 'err';
                identityName.textContent = 'Not connected';
                identityNpub.textContent = '';
                identityHex.textContent = '';
                identityAvatar.style.display = 'none';
                return;
            }
            const np = toNpub(myPub);
            const name = profiles.get(myPub);
            status.textContent = name ? `Connected as ${name}` : `Connected as ${shortNpub(np)}`;
            status.className = 'ok';
            identityName.textContent = name || '(no profile name published)';
            paintSetName();
            identityNpub.textContent = np;
            identityHex.textContent = myPub;
            const av = avatars.get(myPub);
            if (av) { identityAvatar.referrerPolicy = 'no-referrer'; identityAvatar.src = av; identityAvatar.style.display = 'block'; }
            else identityAvatar.style.display = 'none';
        }
        identityAvatar.onerror = () => { identityAvatar.style.display = 'none'; };
        s.getElementById('identity-copy-npub').onclick = () => {
            if (!myPub) return showMsg('Not connected');
            navigator.clipboard.writeText(toNpub(myPub)).then(() => showMsg('npub copied'));
        };
        identityCopyHex.onclick = () => {
            if (!myPub) return showMsg('Not connected');
            navigator.clipboard.writeText(myPub).then(() => showMsg('hex public key copied'));
        };
        identityHexToggle.onclick = () => {
            const showing = identityHex.style.display !== 'none';
            identityHex.style.display = showing ? 'none' : 'block';
            identityCopyHex.style.display = showing ? 'none' : 'inline-block';
            identityHexToggle.textContent = showing ? 'Show hex' : 'Hide hex';
        };

        // --- signing source ---------------------------------------------------------------
        const signerLocalBtn = s.getElementById('signer-local');
        const signerNip07Btn = s.getElementById('signer-nip07');
        const signerNote = s.getElementById('signer-note');
        function paintSignerChoice() {
            if (!signerLocalBtn) return;
            // The lit button has to name the signer that will actually sign, not the one somebody
            // once picked. signerPref stays null until a choice is made, and getWallet() falls back
            // to the NIP-07 signer when no local key is loaded — so anyone connected through nos2x
            // was shown "Key stored here" as the live choice while their signer did the signing.
            // The userscript already decided it this way; the extensions had drifted.
            const usingNip07 = signerPref === 'nip07' || (signerPref === null && nip07Seen);
            for (const [b, on] of [[signerLocalBtn, !usingNip07], [signerNip07Btn, usingNip07]]) {
                b.style.background = on ? '#1d9bf0' : 'none';
                b.style.color = on ? '#fff' : '#1d9bf0';
                b.style.border = '1px solid #1d9bf0';
            }
            signerNote.textContent = usingNip07
                ? 'Using your browser signer. Change the account there and NostrComments follows.'
                : (localWallet || encPriv)
                    ? 'Using the key stored in this extension.'
                    : 'No key stored here yet — generate or import one below, or switch to your signer.';
        }
        async function chooseSigner(pref) {
            if (pref === 'nip07') {
                let present = false;
                try { present = await signerPresent(); } catch(e) {}
                if (!present) return showMsg('No Nostr signer found — install Alby or nos2x first');
            } else if (!localWallet && !encPriv) {
                // `localWallet` is whether the key is *loaded*, not whether it exists. Choosing the
                // signer and reloading leaves it deliberately unloaded, and this then told you that
                // you had no key at all — while it sat in storage, untouched, and the panel showed
                // your npub two lines above. Ask storage, not the variable.
                const _d = await chrome.storage.local.get('nostrcomments_privkey');
                const _saved = _d.nostrcomments_privkey;
                if (!_saved) return showMsg('No key stored here yet — generate or import one first');
                if (_isEncPriv(_saved)) encPriv = _saved;
                // setPrivHex too, or the key is loaded and usable while "Show private key" shows an
                // empty box — the key is deliberately held outside the DOM, so loading the wallet
                // is not by itself enough to make it viewable again.
                else { localWallet = await makeLocalWallet(_saved); setPrivHex(_saved); }
                refreshPwBtn(); updateBackupUI(); keypairSection.style.display = 'block';
            }
            signerPref = pref;
            saveSigner();
            paintSignerChoice();
            try {
                // Disabling a signer leaves window.nostr in the page, so "is one present" still
                // says yes and this is the first thing to find out otherwise. Without the watch it
                // would sit silent for the full minute before the timeout.
                const w = getWallet();
                myPub = await watchSigner(w.getPublicKey());
                fetchProfiles([myPub]); paintIdentity();
                recountAll();
                startNotifSub();
                paintOnboard();
                render();
                showMsg('Now signing as ' + toNpub(myPub).slice(0, 12) + '…');
            } catch(e) { showMsg('Could not read the identity from that source'); }
        }
        paintIdentity();
        signerLocalBtn.onclick = () => chooseSigner('local');
        signerNip07Btn.onclick = () => chooseSigner('nip07');
        paintSignerChoice();

        // Publishing a name, for keys that were generated here and have none.
        //
        // Kind 0 is replaceable: publishing one replaces the *whole* object, not the field you
        // touched. A profile made in any other client carries a picture, an about, a website, a
        // nip05 — and writing {"name":"..."} over it would silently destroy all of them. Other
        // clients avoid that by fetching the existing profile and merging; this one does not merge,
        // it refuses. So the check is not "did we see a name earlier" but a fresh look, taken at the
        // moment of publishing, at every relay.
        // Returns the newest profile found and how many relays actually answered. The count is the
        // important half: "no profile" and "could not check" look identical without it, and only one
        // of them is safe to publish over.
        function lookupProfile(pubkey, ms = 6000) {
            return new Promise(resolve => {
                let best = null, answered = 0, open = RELAYS.length, done = false;
                const finish = () => { if (!done) { done = true; resolve({ event: best, answered }); } };
                const t = setTimeout(finish, ms);
                if (!RELAYS.length) return finish();
                RELAYS.forEach(r => {
                    let ws, replied = false;
                    const shut = () => { try { ws && ws.close(); } catch(_) {} if (--open <= 0) { clearTimeout(t); finish(); } };
                    try { ws = new WebSocket(r); } catch(e) { return shut(); }
                    ws.onopen = () => ws.send(JSON.stringify(["REQ", 'sn' + Math.random().toString(36).slice(2, 6), {kinds:[0], authors:[pubkey], limit:5}]));
                    ws.onmessage = m => {
                        let p; try { p = JSON.parse(m.data); } catch(e) { return; }
                        if (p[0] === 'EVENT' && p[2]?.kind === 0 && p[2].pubkey === pubkey) {
                            if (!best || p[2].created_at > best.created_at) best = p[2];
                        } else if (p[0] === 'EOSE' || p[0] === 'CLOSED') {
                            if (!replied) { replied = true; answered++; }
                            shut();
                        }
                    };
                    ws.onerror = shut;
                    ws.onclose = shut;
                });
            });
        }

        function paintSetName() {
            const row = s.getElementById('setname-row');
            if (!row) return;
            row.style.display = myPub ? 'block' : 'none';
            const raw = myProfileRaw.pub === myPub ? myProfileRaw.data : null;
            const known = myPub && profiles.get(myPub);
            const mine = raw && typeof raw.name === 'string' ? raw.name.trim() : '';
            const hasName = raw ? !!mine : !!known;
            const lead = s.getElementById('setname-lead');
            const btn = s.getElementById('setname-btn');
            const inp = s.getElementById('setname-input');
            // Hiding this once a name existed made a typo permanent unless you exported the key to
            // another app — which is the habit this extension exists to avoid.
            // display_name belongs to the app that set it. Rewriting it from a comment panel would
            // change more than this button says it does, so it is named rather than touched.
            const alt = raw && typeof raw.display_name === 'string' && raw.display_name.trim()
                && raw.display_name.trim() !== mine ? raw.display_name.trim() : '';
            if (lead) lead.textContent = !known
                ? 'Nobody has published a name for this key. Comments you write show npub1… instead, which is hard to follow in a conversation.'
                : alt
                    ? 'Anything else in your profile — picture, bio, website — is kept as it is. Some apps show "' + alt + '" instead, which is a separate field; change that one where you set it.'
                    : 'Anything else in your profile — picture, bio, website — is kept as it is.';
            if (btn) btn.textContent = hasName ? 'Change name' : 'Publish name';
            // The field edits name, so it holds name — not what the card shows, which may be the
            // display_name this panel must not touch. Typing in progress is never overwritten.
            if (inp && inp !== s.activeElement && (inp.value === '' || inp.value === namePrefill)) {
                inp.value = mine; namePrefill = mine;
            }
        }

        {
            const nameInput = s.getElementById('setname-input');
            const nameBtn = s.getElementById('setname-btn');
            if (nameBtn) nameBtn.onclick = async () => {
                if (!myPub) return showMsg('Connect first!');
                const name = (nameInput.value || '').trim().replace(/\s+/g, ' ');
                if (!name) return showMsg('Type a name first');
                if (await carriesPrivateKey(name)) return showMsg(PRIVKEY_WARNING);
                nameBtn.disabled = true;
                try {
                    await syncIdentity();
                    // Which account this profile is read from, merged for, and may replace. A
                    // NIP-07 signer can change account at any moment and never says so, and the
                    // gap here is wide: the lookup below waits up to six seconds and the signer's
                    // own prompt stays open for as long as the user takes.
                    const builtFor = myPub;
                    const { event: existing, answered } = await lookupProfile(myPub);
                    // Kind 0 is replaceable: what goes out replaces the whole object. So the rule is
                    // never to publish one built from less than we can see.
                    if (!answered) {
                        return showMsg('No relay answered, so there is no way to tell whether this key already has a profile. Nothing was published — try again when a relay responds.');
                    }
                    let body = { name };
                    if (existing) {
                        let had;
                        try { had = JSON.parse(existing.content); } catch(e) { had = null; }
                        if (!had || typeof had !== 'object') {
                            // Unreadable, so it cannot be merged, so it must not be replaced.
                            return showMsg('This key has a profile this extension cannot read. Change the name in the app that made it — publishing from here would replace it.');
                        }
                        body = { ...had, name };          // every other field carried across untouched
                    }
                    // A replaceable event only wins if it is newer than the one already out there.
                    const at = Math.max(Math.floor(Date.now()/1000), (existing?.created_at || 0) + 1);
                    // Tags carry across, minus the client tag: copying that one would sign an event
                    // claiming this profile was written by whatever app the previous one came from.
                    const tags = Array.isArray(existing?.tags)
                        ? existing.tags.filter(t => !(Array.isArray(t) && t[0] === 'client')) : [];
                    const ev = {kind:0, created_at:at, tags, content:JSON.stringify(body), pubkey:myPub};
                    const signed = await signAsMe(ev);
                    // signAsMe adopts whatever key actually signed, and for a comment that is
                    // right: the words belong to whoever signed them. Here it is the opposite.
                    // This event carries one account's picture, about, banner, nip05 and lud16,
                    // and kind 0 is replaceable — so signed by another account it does not add a
                    // stray event, it overwrites that account's entire profile with this one's.
                    if (signed.pubkey !== builtFor) {
                        return showMsg('The signer answered as a different account than this profile was read from — nothing was published. Check which account your signer has selected, then try again.');
                    }
                    if (!(await verifyEvent(signed))) return showMsg('Signature check failed — nothing was published.');
                    if (publishFailed(await publishToRelays(signed), 'name')) return;
                    profiles.set(myPub, name);
                    profileAt.set(myPub, at);      // so a straggling old copy cannot undo this
                    myProfileRaw = { pub: myPub, data: body };
                    nameInput.value = ''; namePrefill = null;
                    paintIdentity(); paintSetName(); render();
                    showMsg('Name published — it shows on your comments from now on.');
                } catch(e) {
                    showMsg(/timeout/i.test((e && e.message) || '')
                        ? 'Your signer did not answer — approve the request there, then try again. Nothing was published.'
                        : 'Could not publish the name — try again.');
                } finally { nameBtn.disabled = false; }
            };
        }

        // Reply state
        function setReply(ev) {
            replyTo = ev;
            const name = profiles.get(ev.pubkey) || toNpub(ev.pubkey).slice(0,12)+'…';
            replyToLabel.textContent = `Replying to ${name}`;
            // Answering a note publishes an ordinary Nostr note, which behaves differently from a
            // comment: it reaches the author's client and shows up for people who follow you. That
            // is a reasonable thing to want and a surprising thing to discover afterwards, so it is
            // said before the reply is written rather than in a policy nobody opens.
            // Being able to know beats finding out afterwards. Somebody can place a note carrying
            // twenty p tags on a page you are likely to read, and your reply would then deliver
            // twenty notifications under your key. Nothing is forged and the content is your own,
            // but until this line existed there was no moment at which you could see it.
            if (isLegacy(ev)) {
                const { all, kept } = notifyList(ev);
                const who = kept.length === 1
                    ? 'Its author will be notified.'
                    : all.length > kept.length
                        ? `${kept.length} people will be notified — the note tags ${all.length}, and this stops at ${kept.length}.`
                        : `${kept.length} people will be notified: its author and everyone tagged in it.`;
                replyHint.textContent = `This one goes out as an ordinary Nostr note, so your followers can see it too. ${who}`;
            } else {
                replyHint.textContent = '';
            }
            replyHint.style.display = isLegacy(ev) ? 'block' : 'none';
            replyIndicator.style.display = 'flex';
            input.placeholder = 'Write your reply…';
            input.focus();
        }

        replyCancel.onclick = () => {
            replyTo = null;
            replyIndicator.style.display = 'none';
            replyHint.textContent = '';
            replyHint.style.display = 'none';
            input.placeholder = 'Write your comment…';
        };

        // Shared lnurl-pay flow, used both for zapping a comment and for supporting the developer.
        // `pubkey` is optional: without it the payment is a plain lnurl-pay instead of a NIP-57 zap.
        // Returns true only when a wallet confirmed the payment; every other path reports via showMsg.
        async function lnurlPay({lud16, pubkey, eventId, amount, target, successMsg}) {
            if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(lud16)) return showMsg('Invalid Lightning address');
            const [name, domain] = lud16.split('@');
            const endpoint = `https://${domain}/.well-known/lnurlp/${name}`;
            let lnurlData;
            try { lnurlData = await fetch(endpoint).then(r => r.json()); } catch(e) { return showMsg('Could not reach Lightning address'); }
            if (lnurlData.status === 'ERROR') return showMsg(lnurlData.reason || 'Lightning error');
            if (amount < lnurlData.minSendable || amount > lnurlData.maxSendable) return showMsg(`${amount / 1000} sats out of range${target ? ' for ' + target : ''}`);
            let nostrJson = '';
            if (pubkey && myPub && getWallet() && lnurlData.allowsNostr && lnurlData.nostrPubkey) {
                try {
                    const tags = [['relays', ...RELAYS], ['amount', String(amount)], ['lnurl', endpoint], ['p', pubkey]];
                    if (eventId) tags.push(['e', eventId]);
                    const zapReq = {
                        kind: 9734,
                        created_at: Math.floor(Date.now() / 1000),
                        content: '',
                        tags,
                        pubkey: myPub
                    };
                    const signed = await signAsMe(zapReq);
                    nostrJson = JSON.stringify(signed);
                } catch(e) {}
            }
            // `callback` arrives inside the payee's own JSON, so it is their string and not ours.
            // Two things were wrong with using it as given. It was pasted together with `?amount=`,
            // which produces a malformed URL whenever the provider's callback already carries a
            // query of its own — a real failure, for reasons invisible to whoever tried to zap. And
            // it was never checked, so a provider could send the invoice request over plaintext,
            // where the invoice — the thing that says who gets paid — can be swapped in transit.
            //
            // Not checked: that the host matches the lud16 domain. lnurl lets a provider name any
            // payment endpoint, several legitimately use a different host, and breaking those would
            // cost real payments to close a gap that amounts to the payee learning an IP address
            // they already have from the well-known lookup a moment earlier.
            let payUrl;
            try { payUrl = new URL(lnurlData.callback); } catch(e) { return showMsg('Lightning provider gave an unusable payment address'); }
            if (payUrl.protocol !== 'https:') return showMsg('Lightning provider asked for an insecure connection — payment stopped');
            payUrl.searchParams.set('amount', String(amount));
            if (nostrJson) payUrl.searchParams.set('nostr', nostrJson);
            let invoiceData;
            try { invoiceData = await fetch(payUrl.href).then(r => r.json()); } catch(e) { return showMsg('Could not get invoice'); }
            if (invoiceData.status === 'ERROR') return showMsg(invoiceData.reason || 'Invoice error');
            const pr = invoiceData.pr;
            if (window.webln) {
                try { await window.webln.enable(); await window.webln.sendPayment(pr); showMsg(successMsg); return true; } catch(e) {}
            }
            try { await navigator.clipboard.writeText(pr); showMsg('Invoice copied — paste into your wallet'); }
            catch(e) { showMsg('No wallet found. Copy invoice: ' + pr.slice(0, 30) + '…'); }
        }

        function zap(ev) {
            const lud16 = lud16s.get(ev.pubkey);
            if (!lud16) return showMsg('This user has no Lightning address');
            return lnurlPay({lud16, pubkey: ev.pubkey, eventId: ev.id, amount: 21000, target: 'this user', successMsg: '⚡ Zapped 21 sats!'});
        }

        // Value-4-value support. Every feature stays free and open source — nothing here unlocks
        // anything, supporters simply stop seeing the pitch. Zaps go straight from the user's own
        // wallet to the developer's Lightning provider; no server of ours is involved.
        const SUPPORT = {
            // Developer's Lightning address (lud16). Empty or REPLACE_ME hides the whole section.
            lud16: 'slurpnc@coinos.io',
            // Developer's Nostr pubkey in HEX (not npub). Optional: when set, support zaps become
            // public NIP-57 zaps attributed on Nostr; when empty they are plain Lightning payments.
            // = npub1ewxm82gprxwkh9qznauyey6vwx62xetpsux3prnmddkyevasatgswmds9e — the same identity
            // that owns this repository's NIP-34 announcement and publishes its releases to nostr.
            pubkey: 'cb8db3a901199d6b94029f784c934c71b4a36561870d108e7b6b6c4cb3b0ead1',
            amounts: [1000, 5000, 21000],
            // Shown on the collapsed line, so giving does not require opening the section first.
            quick: [1000, 5000]
        };
        function saveSupporter() { chrome.storage.local.set({nostrcomments_supporter: true}); }
        (() => {
            const wrap = s.getElementById('donate');
            const head = s.getElementById('donate-head');
            const pitch = s.getElementById('donate-pitch');
            const amountsEl = s.getElementById('donate-amounts');
            const custom = s.getElementById('donate-custom');
            const customInput = s.getElementById('donate-custom-input');
            const customSend = s.getElementById('donate-custom-send');
            const toggle = s.getElementById('donate-toggle');
            const body = s.getElementById('donate-body');
            const quick = s.getElementById('donate-quick');

            if (!SUPPORT.lud16 || SUPPORT.lud16.startsWith('REPLACE_ME')) { wrap.style.display = 'none'; return; }

            function renderHead() {
                head.textContent = isSupporter ? '⚡ Thank you for supporting NostrComments' : '⚡ Support the developer';
                pitch.style.display = isSupporter ? 'none' : 'block';
            }
            renderHead();

            async function send(sats) {
                if (!hasConsent) return; // nothing leaves the browser before the user has consented
                if (!(sats > 0)) return showMsg('Enter an amount in sats');
                const btns = [...amountsEl.querySelectorAll('button'), customSend, ...quickBtns];
                btns.forEach(b => b.disabled = true);
                try {
                    const paid = await lnurlPay({
                        lud16: SUPPORT.lud16,
                        pubkey: SUPPORT.pubkey || null,
                        amount: Math.round(sats) * 1000,
                        successMsg: `⚡ Sent ${sats} sats — thank you!`
                    });
                    if (paid && !isSupporter) { isSupporter = true; saveSupporter(); renderHead(); }
                } finally { btns.forEach(b => b.disabled = false); }
            }

            // One factory for both rows, so the collapsed line and the expanded set can never end
            // up labelled or behaving differently.
            function amountButton(sats) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'donate-amt';
                b.textContent = `⚡ ${sats >= 1000 ? (sats / 1000) + 'k' : sats}`;
                b.title = `Zap ${sats.toLocaleString('en-US')} sats`;
                b.onclick = () => send(sats);
                return b;
            }
            SUPPORT.amounts.forEach(sats => amountsEl.appendChild(amountButton(sats)));
            const otherBtn = document.createElement('button');
            otherBtn.type = 'button';
            otherBtn.className = 'donate-amt';
            otherBtn.textContent = 'Other…';
            otherBtn.onclick = () => {
                const open = custom.style.display === 'flex';
                custom.style.display = open ? 'none' : 'flex';
                if (!open) customInput.focus();
            };
            amountsEl.appendChild(otherBtn);
            customSend.onclick = () => send(parseInt(customInput.value, 10));
            customInput.onkeydown = e => { if (e.key === 'Enter') customSend.click(); };

            // Collapsed by default. What sat under every thread was a heading, a pitch, four
            // buttons and two paragraphs of small print — more of the panel than the comment box
            // in a short thread. One quiet line asks just as clearly, and everything that was here
            // is one click away, unchanged.
            const quickBtns = SUPPORT.quick.map(sats => {
                const b = amountButton(sats);
                quick.appendChild(b);
                return b;
            });

            function setOpen(open) {
                body.style.display = open ? 'block' : 'none';
                toggle.textContent = open ? '▴' : '▾';
                toggle.setAttribute('aria-expanded', String(open));
                toggle.setAttribute('aria-label', open ? 'Hide the other ways to support the developer'
                                                       : 'Show the other ways to support the developer');
            }
            setOpen(false);
            toggle.onclick = () => setOpen(body.style.display !== 'block');

            // A bitcoin: or monero: link only goes anywhere when a wallet has claimed the scheme,
            // and on plenty of desktops nothing is registered — the link then silently does
            // nothing, which reads as broken. Copy the address as well so it is never a dead end.
            // The href is untouched, so a registered wallet still opens as before.
            for (const [id, label] of [['donate-btc', 'Bitcoin'], ['donate-xmr', 'Monero']]) {
                const a = s.getElementById(id);
                if (!a) continue;
                a.onclick = () => {
                    const addr = (a.getAttribute('href') || '').split(':')[1] || '';
                    if (addr) navigator.clipboard.writeText(addr).then(() => showMsg(`${label} address copied`), () => {});
                };
            }
        })();

        function renderMarkdown(text) {
            const frag = document.createDocumentFragment();
            text.split('\n').forEach((line, i) => {
                if (i > 0) frag.appendChild(document.createElement('br'));
                const pat = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)]+)\)|(https?:\/\/\S+)/g;
                let last = 0, m;
                while ((m = pat.exec(line)) !== null) {
                    if (m.index > last) frag.appendChild(document.createTextNode(line.slice(last, m.index)));
                    if (m[1] != null) { const el = document.createElement('strong'); el.textContent = m[1]; frag.appendChild(el); }
                    else if (m[2] != null) { const el = document.createElement('em'); el.textContent = m[2]; frag.appendChild(el); }
                    else if (m[3] != null) { const el = document.createElement('code'); el.textContent = m[3]; frag.appendChild(el); }
                    else if (m[4] != null) { const a = document.createElement('a'); a.href = m[5]; a.textContent = m[4]; a.target = '_blank'; a.rel = 'noopener noreferrer'; frag.appendChild(a); }
                    else if (m[6] != null) {
                        const url = m[6];
                        // One that does not pass is still shown, as a link. Refusing to render it as
                        // a picture is the point; hiding that it was written is not.
                        const media = safeMediaUrl(url);
                        if (media && /\.(jpe?g|png|gif|webp|svg)(\?.*)?$/i.test(url)) {
                            const img = document.createElement('img');
                            // The server hosting this picture was chosen by whoever posted the
                            // comment, not by the reader — and without this it is told, in the
                            // Referer header, the exact address of the page being read. IP and
                            // browser version were already unavoidable and are disclosed; the page
                            // address is neither. Anyone could have learned where their own avatar
                            // gets loaded, which is every page they have ever commented on.
                            img.referrerPolicy = 'no-referrer';
                            // Lazily, because a thread can hold twenty of these and firing them all
                            // at once is how a public gateway starts refusing. That refusal is what
                            // made the same picture appear and vanish between reloads: onerror
                            // swaps in the bare URL, so the flakiness of somebody else's host was
                            // showing up as text that came and went.
                            img.loading = 'lazy';
                            img.decoding = 'async';
                            img.src = media;
                            img.className = 'nc-img';
                            img.onclick = () => window.open(url, '_blank');
                            img.onerror = () => { const a = document.createElement('a'); a.href = url; a.textContent = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; img.replaceWith(a); };
                            frag.appendChild(img);
                        } else if (media && /\.(mp4|mov|webm)(\?.*)?$/i.test(url)) {
                            const vid = document.createElement('video');
                            vid.src = media; vid.controls = true;
                            vid.className = 'nc-vid';
                            frag.appendChild(vid);
                        } else {
                            const a = document.createElement('a'); a.href = url; a.textContent = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; frag.appendChild(a);
                        }
                    }
                    last = m.index + m[0].length;
                }
                if (last < line.length) frag.appendChild(document.createTextNode(line.slice(last)));
            });
            return frag;
        }

        function makeItem(ev, sc, hidden, depth, reveal) {
            // Only reached for a deleted comment that still has replies under it. No name, no
            // avatar, no actions: the author asked for it to be gone, and what is left is a marker
            // that something was here, not a record of who wrote it.
            if (isDeleted(ev)) {
                const tomb = document.createElement('div');
                tomb.className = 'c tomb' + (depth > 0 ? ' reply' : '');
                tomb.textContent = 'Comment deleted by its author';
                return tomb;
            }
            const div = document.createElement('div');
            div.className = 'c' + (hidden && !reveal ? ' h' : '') + (depth > 0 ? ' reply' : '') + (ev.pubkey === myPub ? ' own' : '') + (isLegacy(ev) ? ' nc-note' : '');
            // A placeholder the reader can open. Rebuilding the item on click is what actually
            // reveals the comment: dropping the styling used to leave the placeholder sentence
            // sitting there, so "tap to show" changed how it looked and showed nothing.
            const openable = text => {
                div.textContent = text;
                div.onclick = () => div.replaceWith(makeItem(ev, sc, hidden, depth, true));
                return div;
            };
            // Muting is the reader's own choice and reversible, so unlike a deletion this one says
            // whose it is not, and offers a way in. It is only rendered at all when a reply hangs
            // off it — otherwise a muted comment is filtered out well before here.
            if (!reveal && mutedPubkeys.has(ev.pubkey)) {
                div.className = 'c tomb' + (depth > 0 ? ' reply' : '');
                return openable('Comment from a muted user — tap to show');
            }
            // Same reasoning as a muted person: your own reversible choice, so it says what
            // happened and lets you look. Only reached when a reply hangs off it.
            if (!reveal && muteWords.some(w => ev.content.toLowerCase().includes(w))) {
                div.className = 'c tomb' + (depth > 0 ? ' reply' : '');
                return openable('Comment hidden by one of your muted words — tap to show');
            }
            if (!reveal && hidden) return openable(`Hidden (${sc.down} downvotes) — tap to show`);
            const name = profiles.get(ev.pubkey) || toNpub(ev.pubkey).slice(0,12)+'…';
            const header = document.createElement('div');
            header.className = 'nc-header';
            const profileLink = document.createElement('a');
            profileLink.href = `https://njump.me/${toNpub(ev.pubkey)}`;
            profileLink.target = '_blank'; profileLink.rel = 'noopener noreferrer';
            profileLink.className = 'nc-plink';
            const avatarUrl = avatars.get(ev.pubkey);
            if (avatarUrl) {
                const img = document.createElement('img');
                img.className = 'avatar'; img.alt = name;
                // Same reasoning as the inline pictures: an avatar is fetched on every page where
                // its owner has commented, so the Referer would hand them a reading list.
                img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; img.decoding = 'async';
                img.src = avatarUrl;
                img.onerror = () => img.remove();
                profileLink.appendChild(img);
            }
            const nameEl = document.createElement('span');
            nameEl.className = 'nc-name';
            nameEl.textContent = name;
            profileLink.appendChild(nameEl);
            header.appendChild(profileLink);
            // Shown only once it has been checked. An unverified claim rendered as if it meant
            // something would be worse than showing nothing at all.
            if (nip05ok.get(ev.pubkey) === true) {
                const tick = document.createElement('span');
                tick.className = 'nc-nip05';
                tick.textContent = '✓';
                tick.title = `${nip05s.get(ev.pubkey)} — checked against that domain`;
                header.appendChild(tick);
            }
            const meta = document.createElement('small');
            meta.className = 'ts';
            meta.textContent = timeAgo(ev.created_at);
            header.appendChild(meta);
            if (isLegacy(ev)) {
                // A button rather than a span: a title attribute is unreachable on a phone, where
                // there is no hover, so the explanation would only exist for mouse users.
                const lt = document.createElement('button');
                lt.type = 'button';
                lt.className = 'nc-notetag';
                lt.textContent = 'note';
                lt.title = NOTE_EXPLANATION;
                lt.onclick = () => showMsg(NOTE_EXPLANATION);
                header.appendChild(lt);
            }
            if (_newSince > 0 && ev.created_at > _newSince && ev.pubkey !== myPub) {
                const nt = document.createElement('span');
                nt.className = 'nc-newtag';
                nt.textContent = 'new';
                header.appendChild(nt);
            }
            const body = document.createElement('div');
            body.className = 'nc-body';
            body.appendChild(renderMarkdown(ev.content));
            const actions = document.createElement('div');
            actions.className = 'nc-actions';
            [['1','↑',sc.up],['-1','↓',sc.down]].forEach(([val, arrow, count]) => {
                const b = document.createElement('button');
                const mine = sc.my !== undefined && String(sc.my) === val;
                b.className = 'v' + (mine ? (val === '1' ? ' mine' : ' mine down') : '');
                b.dataset.id = ev.id; b.dataset.val = val;
                b.type = 'button';
                b.setAttribute('aria-label', val === '1' ? 'Upvote' : 'Downvote');
                b.setAttribute('aria-pressed', String(mine));
                b.textContent = `${arrow} ${count}`;
                actions.appendChild(b);
            });
            const replyBtn = document.createElement('button');
            replyBtn.className = 'reply-btn';
            replyBtn.textContent = '↩ Reply';
            replyBtn.onclick = () => setReply(ev);
            actions.appendChild(replyBtn);
            const zapBtn = document.createElement('button');
            zapBtn.className = 'zap-btn';
            zapBtn.textContent = '⚡';
            zapBtn.title = 'Zap 21 sats';
            zapBtn.onclick = () => zap(ev);
            actions.appendChild(zapBtn);
            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-btn';
            copyBtn.textContent = '🔗';
            copyBtn.title = 'Copy link to this comment';
            copyBtn.onclick = () => navigator.clipboard.writeText(`nostr:${toNote(ev.id)}`).then(() => showMsg('Link copied'));
            actions.appendChild(copyBtn);
            if (ev.pubkey === myPub) {
                // Two-step, because this cannot be undone and cannot be fully guaranteed either.
                const delBtn = document.createElement('button');
                delBtn.className = 'del-btn';
                delBtn.textContent = '🗑 Delete';
                delBtn.title = 'Ask relays to delete this comment';
                let armed = false, disarm;
                delBtn.onclick = async () => {
                    if (!armed) {
                        armed = true;
                        delBtn.textContent = '🗑 Confirm?';
                        delBtn.classList.add('armed');
                        showMsg('Click again to request deletion. Most relays honour it; some will not, and copies may remain.');
                        disarm = setTimeout(() => { armed = false; delBtn.textContent = '🗑 Delete'; delBtn.classList.remove('armed'); }, 6000);
                        return;
                    }
                    clearTimeout(disarm);
                    delBtn.disabled = true;
                    // A request nobody accepted leaves the comment standing, so give the button
                    // back rather than stranding it disabled next to a comment that is still there.
                    if (!(await requestDeletion(ev))) {
                        armed = false;
                        delBtn.disabled = false;
                        delBtn.textContent = '🗑 Delete';
                        delBtn.classList.remove('armed');
                    }
                };
                actions.appendChild(delBtn);
            }
            if (ev.pubkey !== myPub) {
                const muteBtn = document.createElement('button');
                muteBtn.className = 'mute-btn';
                muteBtn.textContent = '🚫 Mute';
                muteBtn.title = 'Hide all comments from this user';
                muteBtn.onclick = () => { mutedPubkeys.add(ev.pubkey); saveMuted(); render(); showMsg('User muted — unmute via ⚙ Settings'); };
                actions.appendChild(muteBtn);
            }
            div.append(header, body, actions);
            return div;
        }

        // Publish a NIP-09 deletion request for one of your own comments. This asks relays to drop
        // it; it is not a guarantee, and the wording in the UI says so rather than implying it is.
        async function requestDeletion(ev) {
            if (!myPub && encPriv) { const w = await unlockLocalWallet(); if (!w) return; }
            if (!myPub) return showMsg('Connect first!');
            await syncIdentity();
            if (ev.pubkey !== myPub) return showMsg('You can only delete your own comments');
            const del = {
                kind: 5,
                created_at: Math.floor(Date.now() / 1000),
                content: '',
                // The r tag is what lets the request reach anyone still reading the thread: the
                // live subscription filters on the page, and a kind 5 carries no page of its own.
                // Without it a deletion only surfaced on the next page load.
                tags: [['e', ev.id], ['k', String(ev.kind)], ['r', pageUrl]],
                pubkey: myPub
            };
            try {
                const signed = await signAsMe(del);
                if (!(await verifyEvent(signed))) return showMsg('Signature check failed — not sent.');
                // Hiding it locally before anyone accepted the request would be the worst version
                // of this: the comment looks gone to you and is untouched for everybody else.
                if (publishFailed(await publishToRelays(signed), 'deletion request')) return false;
                noteDeletionRequest(signed);
                showMsg('Deletion requested. Relays that honour it will drop the comment; copies may remain elsewhere.');
                return true;
            } catch(e) { showMsg('Could not sign the deletion request'); }
            return false;
        }

        // NIP-09 deletion requests, keyed by the event they target and holding the pubkeys that
        // asked. Stored rather than applied on arrival because a request can reach us before the
        // comment it refers to, and because authorship has to be checked at the moment we compare:
        // a deletion only counts when it is signed by the author of the event being deleted.
        // Without that check anyone could erase anyone else's comment by publishing a kind 5.
        const deletionRequests = new Map();
        const isDeleted = ev => deletionRequests.get(ev.id)?.has(ev.pubkey) === true;

        // A deletion is a request to relays, not a guarantee, so what the extension can honestly do
        // is stop showing it. Requests are still verified before being trusted.
        function noteDeletionRequest(delEv) {
            const targets = (delEv.tags || []).filter(t => t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] || '')).map(t => t[1]);
            if (!targets.length) return;
            queueVerify(delEv, () => {
                let changed = false;
                for (const id of targets) {
                    if (!deletionRequests.has(id)) deletionRequests.set(id, new Set());
                    if (!deletionRequests.get(id).has(delEv.pubkey)) { deletionRequests.get(id).add(delEv.pubkey); changed = true; }
                }
                if (changed) scheduleRender();
            });
        }

        function render() {
            // One predicate, used by the filter and by the placeholder logic below, so the two
            // cannot disagree about what a muted word is.
            const hitsMuteWord = ev => { const cl = ev.content.toLowerCase(); return muteWords.some(w => cl.includes(w)); };
            // What this reader could see, before the search box narrows it. The badge counts this
            // rather than the raw list, so it cannot promise a discussion that turns out to be one
            // deleted comment and two people you muted.
            const visible = c => !mutedPubkeys.has(c.pubkey) && !isDeleted(c) && !hitsMuteWord(c);
            let shown = comments.filter(c => visible(c) && c.content.toLowerCase().includes(q));

            // A reply is only ever drawn from its parent, so dropping a hidden comment used to drop
            // everything hanging off it — replies written by other people, which nobody asked to
            // hide and which simply vanished. Keep such a comment as a placeholder so the thread
            // survives — whether it went because its author deleted it, because the reader muted
            // them, or because it tripped a muted word. When nothing hangs off it there is nothing
            // to preserve and it stays gone. The search box is deliberately not in this list:
            // filtering is a question you asked, and it ends when you clear the box.
            {
                const byId = new Map(comments.map(c => [c.id, c]));
                const parentIdOf = ev => ev.tags?.find(t => t[0] === 'e' && byId.has(t[1]))?.[1];
                const keep = new Set();
                for (const c of shown) {
                    // Same depth cap as appendWithReplies: a relay can send anything, and walking
                    // parent links from untrusted events should not be able to spin forever.
                    let p = parentIdOf(c);
                    for (let d = 0; p && d <= 10; d++, p = parentIdOf(byId.get(p))) {
                        const parent = byId.get(p);
                        if (isDeleted(parent) || mutedPubkeys.has(parent.pubkey) || hitsMuteWord(parent)) keep.add(p);
                    }
                }
                if (keep.size) shown = shown.concat(comments.filter(c => keep.has(c.id)));
            }

            if (sort.value === 'oldest') shown.sort((a,b) => a.created_at - b.created_at);
            if (sort.value === 'newest') shown.sort((a,b) => b.created_at - a.created_at);
            if (sort.value === 'upvotes') shown.sort((a,b) => (scores.get(b.id)?.up||0) - (scores.get(a.id)?.up||0));

            const total = Array.from(scores.values()).reduce((a,sc)=>a+sc.up+sc.down,0);
            const hide = Math.max(5, Math.round(0.1 * total));

            const commentIds = new Set(comments.map(c => c.id));
            const getParentId = ev => ev.tags?.find(t => t[0]==='e' && commentIds.has(t[1]))?.[1];
            // A reply is only ever drawn from its parent, so while a search was running a reply
            // that matched it was invisible whenever its parent did not — the one comment on the
            // page containing what you searched for, hidden because the comment above it did not
            // contain it. Keeping the parent as a placeholder was the other option and it is
            // worse: it puts text on screen that the reader has just asked not to see. So a search
            // returns a flat list of matches instead, which is what a search elsewhere does.
            const flat = !!q;
            const topLevel = flat ? shown : shown.filter(ev => !getParentId(ev));
            const replies = flat ? [] : shown.filter(ev => !!getParentId(ev));

            const visited = new Set();
            function appendWithReplies(ev, depth) {
                if (visited.has(ev.id) || depth > 10) return;
                visited.add(ev.id);
                const sc = scores.get(ev.id) || {up:0,down:0};
                list.appendChild(makeItem(ev, sc, sc.down >= hide, depth));
                replies.filter(r => getParentId(r) === ev.id)
                       .forEach(r => appendWithReplies(r, depth + 1));
            }

            list.replaceChildren();
            // Splitting the budget per kind stops reactions crowding comments out, but a thread can
            // still be bigger than any single request. Saying so beats the silence that hid this in
            // the first place — a truncated thread is indistinguishable from a complete one.
            // Each kind is a filter of its own with a budget of its own, so the total says nothing
            // about whether either was truncated. Ask them separately or a thread of 500 modern and
            // 3 legacy comments claims to be cut short when nothing was.
            const hitLimit = k => comments.reduce((n, c) => n + (c.kind === k ? 1 : 0), 0) >= COMMENT_LIMIT;
            if (hitLimit(COMMENT_KIND) || hitLimit(LEGACY_KIND)) {
                const capped = document.createElement('div');
                capped.className = 'c tomb';
                capped.textContent = `Showing the newest ${COMMENT_LIMIT} comments — this thread has more than one request can carry.`;
                list.appendChild(capped);
            }
            const page = topLevel.slice(0, pageSize);
            if (page.length === 0) {
                const empty = document.createElement('i');
                empty.className = 'nc-empty';
                // "No comments yet – be the first!" was said whatever the reason, so a thread
                // muted into silence and a search that matched nothing both reported a page nobody
                // had ever commented on. Reported from real use: twenty-one comments on the page,
                // all from one key, that key muted — and the panel said be the first.
                //
                // Only one of the three is an invitation to write something.
                const hiddenCount = comments.length - comments.filter(visible).length;
                const blocked = relaysBlocked();
                empty.textContent = blocked
                    ? `This site does not allow NostrComments to reach ${blocked === RELAYS.length ? 'any of your relays' : 'some of your relays'}, so its comments cannot load here.`
                    : comments.length === 0
                    ? 'No comments yet – be the first!'
                    : q
                        ? 'Nothing here matches what you searched for.'
                        : hiddenCount === 1
                            ? 'The one comment here is hidden — you muted its author or a word in it, or it was deleted.'
                            : `All ${hiddenCount} comments here are hidden — you muted their authors or words in them, or they were deleted.`;
                list.appendChild(empty);
            } else {
                page.forEach(ev => appendWithReplies(ev, 0));
            }
            paintIdentity();   // the profile may have arrived since the last render
            loadMore.style.display = topLevel.length > pageSize ? 'block' : 'none';
            // Deliberately not `shown.length`: typing in the search box narrows the thread, and
            // the count on the button should not drop to the number of matches.
            const count = comments.filter(visible).length;
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.style.display = count > 0 ? 'block' : 'none';
        }

        let renderTimer = null;
        function scheduleRender() {
            if (renderTimer) return;
            renderTimer = requestAnimationFrame(() => { renderTimer = null; render(); });
        }

        document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.style.display !== 'none') closeModal(); });

        search.addEventListener('input', () => { q = search.value.toLowerCase(); pageSize = 20; render(); });
        sort.onchange = () => { pageSize = 20; render(); };
        loadMore.onclick = () => { pageSize += 20; render(); };

        s.addEventListener('click', async e => {
            if (e.target.classList.contains('v')) {
                const id = e.target.dataset.id;
                const val = Number(e.target.dataset.val);
                if (!myPub && encPriv) { const w = await unlockLocalWallet(); if (!w) return; }
                if (!myPub) return showMsg("Connect first!");
                vote(id, val);
            }
        });

        async function vote(id, val) {
            const comment = comments.find(c => c.id === id);
            if (!comment) return;
            await syncIdentity();
            // Read the score after syncIdentity: `my` belongs to whoever is signing now.
            if (scores.get(id)?.my === val) return;
            const ev = {kind:7, created_at:Math.floor(Date.now()/1000), tags:[["e",id],["p",comment.pubkey],["r",pageUrl]], content:val===1?'+':'-', pubkey:myPub};
            try {
                const signed = await signAsMe(ev);
                if (!(await verifyEvent(signed))) { showMsg("Signature check failed — not sent."); return; }
                // Shown straight away, unlike a comment. Waiting for a relay leaves the arrow doing
                // nothing for as long as the slowest one takes to answer, and a vote has nothing to
                // lose by being provisional: if nobody takes it, it goes back where it was and says
                // so. A comment cannot do that — its text is the only copy.
                const previous = votes.get(id)?.get(myPub);
                if (!votes.has(id)) votes.set(id, new Map());
                votes.get(id).set(myPub, {val, at: signed.created_at});
                recount(id);
                render();
                if (publishFailed(await publishToRelays(signed), 'vote')) {
                    if (previous) votes.get(id).set(myPub, previous);
                    else votes.get(id).delete(myPub);
                    recount(id);
                    render();
                }
            } catch(e) {
                showSignFailure(e, 'vote');
            }
        }

        // Fire a signed event at every configured relay on its own short-lived socket, so one
        // unreachable relay cannot hold up the others. Rejections are surfaced, except the routine
        // ones (restricted/pow) that would otherwise nag on every post.
        // NIP-42. A relay may refuse to serve or accept anything until you prove which key you are,
        // by sending a challenge and expecting a signed kind-22242 back.
        //
        // Done only in reply to an actual `auth-required:` refusal, never on the challenge alone.
        // Authenticating because a relay merely offered it would hand your public key to every
        // relay you read from — including on pages where you never post, where reading is otherwise
        // anonymous — and would ask a NIP-07 signer for a signature you turned out not to need.
        async function authenticate(ws, challenge, relayUrl) {
            if (!myPub || !challenge) return null;
            try {
                const signed = await signAsMe({
                    kind: 22242,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['relay', relayUrl], ['challenge', challenge]],
                    content: '',
                    pubkey: myPub,
                });
                ws.send(JSON.stringify(['AUTH', signed]));
                return signed.id;
            } catch(e) { return null; }
        }

        // One relay, one socket, one answer. Split out so the same attempt can be made twice
        // without writing the NIP-42 exchange twice.
        function publishOne(r, signed) {
            return new Promise(resolve => {
                let settled = false;
                const settle = v => { if (!settled) { settled = true; resolve(v); } };
                let ws;
                try { ws = new WebSocket(r); } catch(e) { return settle({ok:false, reason:'could not connect'}); }
                const shut = () => { try { ws.close(); } catch(_) {} };
                let challenge = null, authId = null, identified = false;
                ws.onopen = () => ws.send(JSON.stringify(["EVENT", signed]));
                ws.onmessage = m => {
                    let d; try { d = JSON.parse(m.data); } catch(e) { return; }
                    if (d[0] === 'AUTH') { challenge = d[1]; return; }   // kept until something needs it
                    if (d[0] !== 'OK') return;
                    if (authId && d[1] === authId) {
                        if (d[2] === true) ws.send(JSON.stringify(["EVENT", signed]));   // again, now identified
                        else { settle({ok:false, reason:'the relay refused the identification'}); shut(); }
                        return;
                    }
                    if (d[1] !== signed.id) return;                     // OK is per event id
                    if (!d[2] && !identified && challenge && /^auth-required:/i.test(d[3] || '')) {
                        identified = true;
                        authenticate(ws, challenge, r).then(id => {
                            if (id) authId = id;
                            else { settle({ok:false, reason: d[3]}); shut(); }
                        });
                        return;
                    }
                    settle({ok: d[2] === true, reason: d[3] || 'refused without a reason'});
                    shut();
                };
                ws.onerror = () => { settle({ok:false, reason:'unreachable'}); shut(); };
                ws.onclose = () => settle({ok:false, reason:'closed without answering'});
                setTimeout(() => { settle({ok:false, reason:'timed out'}); shut(); }, 8000);
            });
        }

        // Worth asking twice, or not. A relay that was unreachable, timed out or dropped the socket
        // was plausibly just busy. One that wants payment, proof-of-work or membership has stated a
        // policy, and will state it again — asking twice would only be noise on somebody's server.
        const _worthRetrying = reason => /timed out|unreachable|could not connect|closed without answering|rate.?limit|slow down|too fast|try again/i.test(String(reason || ''));

        // Resolves as soon as one relay accepts — the ordinary case, and fast. Two things carry on
        // after that: every other relay is still asked, and the ones that failed for a reason worth
        // retrying are asked again. How many ended up holding the event comes back on `settled`,
        // because resolving on the first acceptance made one relay and nine look identical, and the
        // difference between those two is whether the comment survives somebody's spring clean.
        function publishToRelays(signed) {
            const targets = dedupeRelays(RELAYS.concat(publishWide ? EXTRA_PUBLISH_RELAYS : []));
            if (!targets.length) return Promise.resolve({accepted:false, reasons:['no relays configured'], settled: Promise.resolve({on:0, total:0})});
            const first = targets.map(r => publishOne(r, signed).then(res => ({r, res})));
            const settled = Promise.all(first).then(async all => {
                const on = new Set(all.filter(a => a.res.ok).map(a => a.r));
                const again = all.filter(a => !a.res.ok && _worthRetrying(a.res.reason)).map(a => a.r);
                if (again.length) {
                    await new Promise(done => setTimeout(done, 2000));
                    for (const a of await Promise.all(again.map(r => publishOne(r, signed).then(res => ({r, res})))))
                        if (a.res.ok) on.add(a.r);
                }
                return {on: on.size, total: targets.length};
            });
            return new Promise(resolve => {
                let pending = first.length;
                first.forEach(p => p.then(({res}) => {
                    if (res.ok) return resolve({accepted:true, reasons:[], settled});
                    // Every relay refused on the first pass. Saying so now would throw away a retry
                    // that is already under way, and with it whatever somebody had typed.
                    if (--pending === 0) settled.then(t => Promise.all(first).then(all => resolve({
                        accepted: t.on > 0,
                        reasons: t.on > 0 ? [] : [...new Set(all.map(a => a.res.reason).filter(Boolean))],
                        settled,
                    })));
                }));
            });
        }
        // One place that turns that result into something a person can act on. Naming the reason
        // matters: "no relay accepted it" is a dead end, "proof-of-work required" is something you
        // can do something about.
        // Relay refusals are written for machines. The ones a reader can actually do something
        // about are worth saying in words; the rest go through as they came.
        //
        // Proof-of-work is the honest "no" here. Reaching difficulty 20 costs roughly a million
        // hashes — about twelve seconds of a browser's SHA-256, on the main thread of the page
        // somebody is reading — and relays that ask for it usually ask 24 or 28, which is minutes
        // to an hour. Grinding for that and probably failing is worse than saying so.
        function explainRefusal(reason) {
            const r = String(reason || '');
            const pow = /^pow:/i.test(r) && r.match(/\d+/);
            if (pow) return `it wants proof-of-work at difficulty ${pow[0]}, which is more computing than a browser tab can reasonably do — try another relay, or drop this one in Settings`;
            if (/^restricted:/i.test(r)) return `it only accepts posts from its own members (${r.replace(/^restricted:\s*/i, '') || 'no detail given'})`;
            if (/^auth-required:/i.test(r)) return 'it wants you to identify yourself first, and there is no identity connected';
            return r;
        }

// A comment that reached exactly one relay is published, so nothing here is an error — but
        // it is one operator's decision away from being gone, and until now nothing said so. The
        // count arrives after the panel has already shown the comment, which is why this is a
        // separate message rather than part of the posting path.
        function publishedThinly(res, what) {
            if (!res || !res.settled) return;
            res.settled.then(t => {
                if (t.on === 1 && t.total > 1)
                    showMsg(`Your ${what} reached only one relay out of ${t.total}. If that one drops it, it is gone — add another under ⚙ Settings.`, true);
            }).catch(() => {});
        }

        function publishFailed(res, what) {
            if (res.accepted) return false;
            const why = res.reasons.slice(0, 2).map(explainRefusal).join('; ');
            showMsg(`No relay accepted your ${what}${why ? ` — ${why}` : ''}. Nothing was published.`);
            return true;
        }

        // Which shape a post takes is decided by the parent, never by a setting. Kept as its own
        // function so that send.onclick has nothing between "disable the button" and the try that
        // re-enables it — an exception thrown while building tags would otherwise leave the panel
        // with a dead Post button and no message.
        function buildEvent(text) {
            // Two shapes, and which one is used is decided by the parent, never by a setting.
            //
            // Answering an ordinary note has to be an ordinary note: NIP-22 says outright that
            // "Comments MUST NOT be used to reply to kind 1 notes. NIP-10 should instead be
            // followed." Everything else — a top-level comment, or a reply to a comment — stays
            // NIP-22, so nothing new is published as a kind 1 that was not already a kind 1 thread.
            let ev;
            if (replyTo && isLegacy(replyTo)) {
                const root = nip10Root(replyTo);
                const tags = root
                    ? [["e", root, "", "root"], ["e", replyTo.id, "", "reply", replyTo.pubkey]]
                    : [["e", replyTo.id, "", "root", replyTo.pubkey]];
                notifyList(replyTo).kept.forEach(k => tags.push(["p", k]));
                // Keeps the reply in this page's thread for the next reader, the same way the note
                // it answers got there.
                tags.push(["r", pageUrl]);
                ev = {kind:LEGACY_KIND, created_at:Math.floor(Date.now()/1000), tags, content:text, pubkey:myPub};
            } else {
                // NIP-22: the root scope in uppercase, the parent in lowercase. For a top-level
                // comment the page is both, so i/k repeat I/K. For a reply the root stays the page
                // and the parent becomes the comment being answered.
                const tags = [["I", pageUrl], ["K", "web"]];
                if (replyTo) {
                    tags.push(["e", replyTo.id], ["k", String(COMMENT_KIND)], ["p", replyTo.pubkey]);
                } else {
                    tags.push(["i", pageUrl], ["k", "web"]);
                }
                ev = {kind:COMMENT_KIND, created_at:Math.floor(Date.now()/1000), tags, content:text, pubkey:myPub};
            }
            return ev;
        }

        // Offered once, after the first comment: at that point the identity has something attached
        // to it and "you will lose this" is a statement about something real rather than about an
        // empty account. Somebody who never posts is never asked, and loses nothing by that.
        let backupAsked = false;
        async function offerBackup() {
            if (backupAsked || keyBackedUp || !localWallet || encPriv) return;
            if (keyPromptShown) return;
            // backupAsked resets with the page, so on its own it asked again on every site where
            // somebody happened to post their first comment. The timestamp is what makes it once.
            if (Date.now() - backupAskedAt < 864e5) return;
            backupAsked = true; keyPromptShown = true;
            backupAskedAt = Date.now(); rememberBackupAsked();
            const go = await askConfirm({
                title: 'Save your key?',
                danger: false,
                lines: [
                    'That comment was signed with a key that exists only in this browser. There is no account behind it and nothing to reset — a key is the whole identity.',
                    'Clear this browser\'s data, or move to another computer, and the identity that comment belongs to is gone with it.',
                ],
                confirmLabel: 'Show my key',
                declineLabel: 'Later',
            });
            if (!go) return showMsg('You can save it whenever you like under ⚙ Settings.');
            await openSettings();
            keypairSection.style.display = 'block';
            const box = s.getElementById('privkey-box'), btn = s.getElementById('privkey-reveal');
            if (box && box.style.display === 'none' && btn) btn.click();
        }

        send.onclick = async () => {
            if (!myPub && encPriv) { const w = await unlockLocalWallet(); if (!w) return; }
            if (!myPub) return showMsg("Connect first!");
            await syncIdentity();
            const text = input.value.trim();
            if (!text) return;
            // Before anything is signed or sent. The text stays in the box, so nothing is lost.
            if (await carriesPrivateKey(text)) return showMsg(PRIVKEY_WARNING);
            send.disabled = true;
            try {
                const ev = buildEvent(text);
                const signed = await signAsMe(ev);
                if (!(await verifyEvent(signed))) { showMsg("Signature check failed — not sent."); return; }
                // Only treat it as posted once a relay says so. On failure the text stays in the
                // box, which is the whole point: it is the only copy left.
                const pub = await publishToRelays(signed);
                if (publishFailed(pub, 'comment')) return;
                publishedThinly(pub, 'comment');
                comments.unshift(signed);
                input.value = '';
                replyCancel.onclick();
                render();
                offerBackup();
            } catch(e) {
                showSignFailure(e, 'comment');
            } finally {
                send.disabled = false;
            }
        };

        // Everything below (wallet auto-load, auto-connect, and relay loading) only runs
        // after consent — no data leaves the browser until the user enables NostrComments.
        let _networkStarted = false;
        // Connecting is deferred until the page has actually been looked at. Most visits are
        // glances, and today every one of them opens a socket to every configured relay before the
        // reader has decided to stay. A tab opened in the background costs exactly as much as one
        // being read, which is what adds up when somebody middle-clicks twenty links at once.
        //
        // Three rules: a tab that has never been visible connects to nothing, a visible one waits
        // a moment first, and opening the panel skips the wait entirely — somebody who asks for the
        // thread should not be made to sit through a timer.
        const _SETTLE_MS = 2500;
        let _settleTimer = null;
        function armNetwork() {
            if (_networkStarted || !hasConsent || _settleTimer) return;
            if (document.visibilityState !== 'visible') return;
            _settleTimer = setTimeout(() => { _settleTimer = null; startNetwork(); }, _SETTLE_MS);
        }
        document.addEventListener('visibilitychange', armNetwork);

        function startNetwork() {
            if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
            if (_networkStarted || !hasConsent) return;
            _networkStarted = true;

            // Load the stored key, or not, according to what the user actually chose.
            //
            // This used to ask only whether a signer was installed, and skip the stored key if one
            // was. So choosing "Key stored here" and then reloading with Alby or nos2x present
            // connected you as the signer's identity instead — silently, and with your own key
            // sitting untouched in storage. Posting under the wrong identity is not a cosmetic bug
            // in an extension whose whole subject is which key speaks for you.
            //
            // Only when nothing has been chosen does the presence of a signer decide, which is the
            // old behaviour and a reasonable default for a first run.
            (async () => {
                const _savedPriv = _st.nostrcomments_privkey;
                if (_savedPriv && !_isEncPriv(_savedPriv)) {
                    const useLocal = signerPref === 'local' ? true
                                   : signerPref === 'nip07' ? false
                                   : !(await signerPresent());
                    if (useLocal) { localWallet = await makeLocalWallet(_savedPriv); connect(); }
                    // A key that predates this offer gets it once as well, rather than living
                    // unencrypted forever because the feature arrived after it did.
                    offerEncryption(_savedPriv);
                }
            })();

            // Auto-connect to a NIP-07 signer if one becomes available.
            //
            // This used to stop for good the first time the check came back empty. Alby and nos2x
            // inject window.nostr asynchronously, so on a cold start or a busy page the very first
            // look can miss it — and then nothing tried again for the life of the page, and the
            // only way out was to open Settings and press the signer button by hand.
            //
            // Keep looking for a while instead, then stop: a page with no signer at all should not
            // poll forever.
            let _signerTries = 0;
            const connectTimer = setInterval(async () => {
                if (myPub) { clearInterval(connectTimer); return; }
                if (!localWallet) {
                    const hasNip07 = await signerPresent();
                    if (!hasNip07) {
                        if (++_signerTries >= 6) clearInterval(connectTimer);   // ~30s
                        return;
                    }
                }
                connect();
            }, 5000);

            loadPage();
            watchNavigation();
        }

        // (Re)load the comment thread for the current pageUrl. Re-runnable on SPA navigation:
        // a generation token discards stale relay/verification callbacks from the previous page.
        function loadPage() {
            paintPageKey();
            const gen = ++pageGen;
            _wsPool.forEach(w => { try { w.close(); } catch(_) {} });
            _wsPool = [];
            comments.length = 0; scores.clear(); votes.clear(); _seenEv.clear();
            _newSince = _lastSeenMap[pageUrl] || 0;
            pageSize = 20; replyTo = null;
            replyIndicator.style.display = 'none';
            input.placeholder = 'Write your comment…';
            render();

            let _eoseCount = 0, _repliesFetched = false, _eoseTimer;
            const _silent = new Map();     // per relay: the timer watching for a reply that never comes
            function _fetchReplies() {
                if (_repliesFetched || gen !== pageGen) return;
                _repliesFetched = true;
                clearTimeout(_eoseTimer);
                // Wait for in-flight verifications to drain so replies are queried for every
                // verified comment (an unverified parent would otherwise be missing from the id list).
                _vq.then(() => {
                    if (gen !== pageGen) return;
                    const ids = comments.map(c => c.id);
                    if (ids.length) _wsPool.forEach(w => { if (w.readyState === 1) w.send(JSON.stringify(["REQ", subId+'r'+gen, ...refetchFilters(ids)])); });
                    fetchProfiles(comments.map(c => c.pubkey));
                });
            }
            _eoseTimer = setTimeout(_fetchReplies, 5000);
            // Open a relay subscription and auto-reconnect it (capped exponential backoff) if it
            // drops while this page is still current, so the live feed survives network blips.
            function openRelay(r, attempt) {
                if (gen !== pageGen) return;
                let ws;
                try { ws = new WebSocket(r); } catch(e) { return; }
                _wsPool.push(ws);
                const openSub = () => ws.send(JSON.stringify(["REQ", subId+gen, ...pageFilters()]));
                let challenge = null, authId = null, identified = false;
                ws.onopen = () => {
                    attempt = 0;
                    setRelayState(r, 'connecting');
                    // A relay can complete the handshake and then say nothing at all, which is a
                    // different failure from refusing the connection and used to look like neither:
                    // nothing was ever set, so the panel reported it as not contacted. Give it the
                    // same 5 seconds the thread already waits for EOSE before it gives up on one.
                    clearTimeout(_silent.get(r));
                    _silent.set(r, setTimeout(() => {
                        if (relayState.get(r)?.state !== 'answered') setRelayState(r, 'failed');
                    }, 6000));
                    openSub();
                };
                ws.onmessage = m => {
                    if (gen !== pageGen) return;
                    let parsed;
                    try { parsed = JSON.parse(m.data); } catch(e) { return; }
                    const [type] = parsed;
                    if (type === 'AUTH') { challenge = parsed[1]; return; }
                    // A refused subscription used to arrive here and be discarded, so a relay that
                    // turned us away produced no comments and no explanation — indistinguishable
                    // from a page nobody has commented on.
                    if (type === 'CLOSED') {
                        const [, , info] = parsed;
                        if (!identified && challenge && /^auth-required:/i.test(info || '')) {
                            // The thread starts loading before a stored key has finished loading,
                            // so the first refusal often arrives with no identity to answer it.
                            // Remember that one was wanted rather than spending the single attempt
                            // on nothing; connect() reopens the thread once there is somebody to be.
                            if (!myPub) { _authWanted = true; return; }
                            identified = true;
                            authenticate(ws, challenge, r).then(id => {
                                if (id) authId = id;
                                else showMsg(`A relay wants you to identify yourself first: ${info}`);
                            });
                            return;
                        }
                        showMsg(`A relay closed the subscription: ${info || 'no reason given'}`);
                        return;
                    }
                    if (type === 'OK') {
                        const [, id, ok, info] = parsed;
                        if (authId && id === authId) {
                            if (ok) openSub();                          // ask again, now identified
                            else showMsg(`A relay refused the identification: ${info || 'no reason given'}`);
                            return;
                        }
                        if (!ok && !/^(restricted|pow):/i.test(info||'')) showMsg(`Relay rejected: ${info || 'unknown reason'}`);
                        return;
                    }
                    if (type === 'EOSE') {
                        clearTimeout(_silent.get(r));
                        setRelayState(r, 'answered');
                        if (++_eoseCount >= _wsPool.length) _fetchReplies();
                        return;
                    }
                    if (type !== 'EVENT') return;
                    setRelayState(r, relayState.get(r)?.state === 'answered' ? 'answered' : 'connecting', true);
                    const ev = parsed[2];
                    if (!ev) return;
                    if (typeof ev.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.pubkey)) return;
                    if (typeof ev.id !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.id)) return;
                    if (ev.kind === COMMENT_KIND || ev.kind === LEGACY_KIND) {
                        if (!comments.find(c => c.id === ev.id) && !_seenEv.has(ev.id)) {
                            const commentIds = new Set(comments.map(c => c.id));
                            // 1111 is scoped by the uppercase I tag; a kind 1 has no such thing and
                            // uses the r tag the old versions wrote, which is also what any other
                            // client uses to link a note to a URL.
                            const pageTag = ev.kind === COMMENT_KIND ? "I" : "r";
                            const hasPageTag = ev.tags?.some(t => t[0]===pageTag && t[1]===pageUrl);
                            const isReply = ev.tags?.some(t => t[0]==="e" && commentIds.has(t[1]));
                            if (hasPageTag || isReply) {
                                queueVerify(ev, () => {
                                    if (gen !== pageGen || comments.find(c => c.id === ev.id)) return;
                                    comments.push(ev);
                                    fetchProfiles([ev.pubkey]);
                                    scheduleRender();
                                });
                            }
                        }
                    }
                    if (ev.kind === 5) noteDeletionRequest(ev);
                    if (ev.kind === 7) {
                        const e = ev.tags?.find(t => t[0]==="e")?.[1];
                        if (e) {
                            const val = ev.content === '+' || ev.content === '' ? 1 : ev.content === '-' ? -1 : 0;
                            if (val) {
                                queueVerify(ev, () => {
                                    if (gen !== pageGen) return;
                                    if (!votes.has(e)) votes.set(e, new Map());
                                    // A relay returns a voter's reactions in no particular order,
                                    // so an older one arriving last must not undo a newer one.
                                    const prev = votes.get(e).get(ev.pubkey);
                                    if (prev && prev.at > ev.created_at) return;
                                    votes.get(e).set(ev.pubkey, {val, at: ev.created_at});
                                    recount(e);
                                    scheduleRender();
                                });
                            }
                        }
                    }
                    scheduleRender();
                };
                ws.onerror = () => { try { ws.close(); } catch(_) {} };
                ws.onclose = () => {
                    const i = _wsPool.indexOf(ws); if (i >= 0) _wsPool.splice(i, 1);
                    // Answered once already: a later close is the socket ending, not a failure.
                    if (relayState.get(r)?.state !== 'answered') setRelayState(r, attempt >= 6 ? 'unreachable' : 'failed');
                    // Give up after ~6 tries (~90s) so a relay the network permanently blocks isn't
                    // retried forever; navigation/reload gives every relay a fresh start anyway.
                    if (gen !== pageGen || attempt >= 6) return;
                    setTimeout(() => openRelay(r, attempt + 1), Math.min(30000, 2000 * (2 ** attempt)));
                };
            }
            RELAYS.forEach(r => openRelay(r, 0));
        }

        // Remember when the user last viewed this page's thread, so comments newer than that get a
        // "new" marker on the next visit. Map is capped to the 300 most-recently-seen pages.
        function markPageSeen() {
            _lastSeenMap[pageUrl] = Math.floor(Date.now() / 1000);
            const keys = Object.keys(_lastSeenMap);
            if (keys.length > 300) keys.sort((a, b) => _lastSeenMap[a] - _lastSeenMap[b]).slice(0, keys.length - 300).forEach(k => delete _lastSeenMap[k]);
            chrome.storage.local.set({nostrcomments_lastseen: _lastSeenMap});
        }

        // Detect client-side (SPA) navigation and re-key the thread to the new URL.
        let _navStarted = false;
        function watchNavigation() {
            if (_navStarted) return;
            _navStarted = true;
            let _navTimer = null;
            // Debounce navigation so rapidly clicking through pages (YouTube/Reddit) doesn't spawn
            // a burst of loadPage()/relay connections; only the settled URL loads.
            const onNav = () => {
                // Clicking an anchor changes the address bar and nothing else: the thread is the
                // same, so there is nothing to reload — but that is the moment the two addresses
                // start disagreeing, which is exactly when the line has something to say.
                paintPageKey();
                if (normalizeUrl(location.href) === pageUrl) return;
                clearTimeout(_navTimer);
                _navTimer = setTimeout(() => {
                    const url = normalizeUrl(location.href);
                    if (url === pageUrl) return;
                    pageUrl = url;
                    loadPage();
                }, 400);
            };
            window.addEventListener('popstate', onNav);
            window.addEventListener('hashchange', onNav);
            // pushState/replaceState fire no event; poll as a CSP-proof, cross-world fallback.
            setInterval(onNav, 700);
        }

        if (hasConsent) armNetwork();
        render();
    }
})();
