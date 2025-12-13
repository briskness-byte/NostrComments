// ==UserScript==
// @name         NostrComments
// @namespace    https://github.com/briskness-byte/NostrComments
// @version      0.2
// @description  Comment freely on every website — without censorship
// @author       Built on Nostr
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
    'use strict';

    if (!document.body) { document.addEventListener('DOMContentLoaded', init); return; }
    init();

    function init() {
        // Floating button
        const btn = document.createElement('div');
        btn.innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v14l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/><circle cx="7.5" cy="9.5" r="1.5"/><circle cx="12" cy="9.5" r="1.5"/><circle cx="16.5" cy="9.5" r="1.5"/></svg>`;
        Object.assign(btn.style, {
            position:'fixed', right:'18px', bottom:'18px', width:'68px', height:'68px',
            background:'linear-gradient(135deg,#1d9bf0,#0d8bf0)', borderRadius:'50%',
                      display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer',
                      zIndex:'2147483647', boxShadow:'0 12px 35px rgba(29,155,240,0.6)',
                      transition:'transform .25s ease', userSelect:'none'
        });
        btn.onmouseenter = () => btn.style.transform = 'scale(1.12)';
        btn.onmouseleave = () => btn.style.transform = 'scale(1)';
        document.body.appendChild(btn);

        // Shadow DOM modal
        const host = document.createElement('div');
        document.body.appendChild(host);
        const s = host.attachShadow({mode:'open'});

        s.innerHTML = `
        <style>
        #m{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.94);z-index:2147483647;place-items:center;font-family:system-ui,sans-serif}
        #p{background:#fff;width:95%;max-width:860px;max-height:94vh;overflow-y:auto;border-radius:20px;padding:24px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,0.6)}
        #c{position:absolute;top:12px;right:16px;width:50px;height:50px;font-size:40px;background:none;border:none;cursor:pointer;color:#555;display:flex;align-items:center;justify-content:center}
        h2{color:#1d9bf0;margin:0 0 24px;text-align:center;font-size:28px;font-weight:600}
        #controls{display:flex;flex-direction:column;gap:16px;margin:20px 0}
        #connect,#send,#loadMore{padding:16px 20px;border-radius:14px;font-size:18px;font-weight:600;cursor:pointer}
        #connect,#send{background:#1d9bf0;color:white;border:none}
        #loadMore{background:#0d8bf0;color:white;border:none;display:none}
        input,select{padding:14px 16px;border:1px solid #ddd;border-radius:14px;font-size:17px}
        #input-wrapper{position:relative;margin:24px 0}
        #input{width:100%;min-height:120px;padding:18px 18px 50px;border:2px solid #e2e8f0;border-radius:16px;font-size:17px;background:#fafbfc;resize:none}
        #send{position:absolute;bottom:12px;right:12px;padding:14px 32px;border-radius:12px}
        #list{max-height:48vh;overflow-y:auto;background:#f8f9fa;padding:20px;border-radius:16px;margin:20px 0}
        .c{background:white;padding:18px;margin:12px 0;border-radius:16px;border-left:6px solid #1d9bf0;box-shadow:0 3px 12px rgba(0,0,0,0.08)}
        .v{font-size:28px;background:none;border:none;cursor:pointer;padding:8px 12px;min-width:56px}
        .h{opacity:0.5;font-style:italic;cursor:pointer;padding:30px;background:#f0f0f0;border-radius:16px;text-align:center;font-size:18px}
        #donate{text-align:center;margin:20px 0 10px;font-size:14px;color:#666}
        #donate a{color:#f7931a;text-decoration:none;font-weight:600}
        #donate a:hover{text-decoration:underline}
        @media(min-width:768px){#controls{flex-direction:row;align-items:center}#search{width:260px}}
        </style>
        <div id="m">
        <div id="p">
        <button id="c">×</button>
        <h2>NostrComments</h2>
        <div id="controls">
        <button id="connect">Connect Nostr</button>
        <span id="status" style="color:#c62828;font-weight:bold">Not connected</span>
        <input id="search" placeholder="Search comments…">
        <select id="sort">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="upvotes">Most upvotes</option>
        </select>
        </div>
        <div id="list"><i>No comments yet – be the first!</i></div>
        <button id="loadMore">Load more</button>
        <div id="input-wrapper">
        <textarea id="input" placeholder="Write your comment…"></textarea>
        <button id="send">Post</button>
        </div>
        <div id="donate">
        Enjoying NostrComments? <a href="bitcoin:198yNVWJz2H8PwmNsX72URVVV9pRbxMb18" target="_blank">Send a tip (Bitcoin/Lightning)</a>
        </div>
        </div>
        </div>
        `;

        const modal = s.getElementById('m');
        const list = s.getElementById('list');
        const input = s.getElementById('input');
        const send = s.getElementById('send');
        const connectBtn = s.getElementById('connect');
        const status = s.getElementById('status');
        const search = s.getElementById('search');
        const sort = s.getElementById('sort');
        const loadMore = s.getElementById('loadMore');

        btn.onclick = () => modal.style.display = 'grid';
        s.getElementById('c').onclick = () => modal.style.display = 'none';

        let myPub = null;
        const comments = [];
        const scores = new Map();
        let lastTs = Math.floor(Date.now()/1000);
        let q = '';

        async function connect() {
            if (!window.nostr) return status.textContent = "Install Alby/nos2x";
            try { myPub = await window.nostr.getPublicKey();
                status.textContent = `Connected …${myPub.slice(-8)}`;
                status.style.color = "#2e7d32";
                connectBtn.disabled = true;
            } catch(e) {}
        }
        connectBtn.onclick = connect;
        setInterval(connect, 5000);

        function render() {
            let shown = comments.filter(c => c.content.toLowerCase().includes(q));
            if (sort.value === 'oldest') shown.sort((a,b) => a.created_at - b.created_at);
            if (sort.value === 'newest') shown.sort((a,b) => b.created_at - a.created_at);
            if (sort.value === 'upvotes') shown.sort((a,b) => (scores.get(b.id)?.up||0) - (scores.get(a.id)?.up||0));

            const total = Array.from(scores.values()).reduce((a,s)=>a+s.up+s.down,0);
            const hide = Math.max(5, Math.round(0.1 * total));

            list.innerHTML = shown.map(ev => {
                const s = scores.get(ev.id) || {up:0,down:0};
                const short = ev.pubkey.slice(-8);
                const date = new Date(ev.created_at*1000).toLocaleString();
                const hidden = s.down >= hide;

                return hidden ?
                `<div class="c h" onclick="this.classList.remove('h');this.onclick=null;">Hidden (${s.down} downvotes) — tap to show</div>` :
                `<div class="c">
                <small style="color:#666">${date} · …${short}</small><br>
                <div style="margin:12px 0;font-size:17px;line-height:1.6">${ev.content.replace(/\n/g,'<br>')}</div>
                <div style="margin-top:12px;">
                <button class="v" data-id="${ev.id}" data-val="1">↑ ${s.up}</button>
                <button class="v" data-id="${ev.id}" data-val="-1">↓ ${s.down}</button>
                </div>
                </div>`;
            }).join('') || '<i style="color:#888;font-size:18px;">No comments yet – be the first!</i>';

            loadMore.style.display = comments.length >= 20 ? 'block' : 'none';
        }

        search.addEventListener('input', () => { q = search.value.toLowerCase(); render(); });
        sort.onchange = render;

        s.addEventListener('click', e => {
            if (e.target.classList.contains('v')) {
                const id = e.target.dataset.id;
                const val = Number(e.target.dataset.val);
                if (!myPub) return alert("Connect first!");
                vote(id, val);
            }
        });

        async function vote(id, val) {
            const s = scores.get(id) || {up:0,down:0};
            const ev = {kind:7,created_at:Math.floor(Date.now()/1000),tags:[["e",id],["p",comments.find(c=>c.id===id).pubkey]],content:val===1?'+':'-',pubkey:myPub};
            const signed = await window.nostr.signEvent(ev);
            ["wss://nos.lol","wss://relay.damus.io"].forEach(r=>{
                try{const ws=new WebSocket(r);ws.onopen=()=>ws.send(JSON.stringify(["EVENT",signed]));}catch(e){}
            });
            if (s.my===1) s.up--; if (s.my===-1) s.down--;
            if (val===1) s.up++; if (val===-1) s.down--;
            s.my = val;
            scores.set(id, s);
            render();
        }

        send.onclick = async () => {
            if (!myPub) return alert("Connect first!");
            const text = input.value.trim();
            if (!text) return;
            const ev = {kind:1,created_at:Math.floor(Date.now()/1000),tags:[["r",location.href]],content:text,pubkey:myPub};
            const signed = await window.nostr.signEvent(ev);
            ["wss://nos.lol","wss://relay.damus.io"].forEach(r=>{
                try{const ws=new WebSocket(r);ws.onopen=()=>ws.send(JSON.stringify(["EVENT",signed]));}catch(e){}
            });
            input.value = '';
        };

        // Load everything
        ["wss://nos.lol","wss://relay.damus.io"].forEach(r => {
            const ws = new WebSocket(r);
            ws.onopen = () => ws.send(JSON.stringify(["REQ","nc18",{kinds:[1,7],"#r":[location.href],limit:500}]));
            ws.onmessage = m => {
                const [,,ev] = JSON.parse(m.data);
                if (!ev) return;
                if (ev.kind===1 && ev.tags?.some(t=>t[0]==="r"&&t[1]===location.href)) {
                    if (!comments.find(c=>c.id===ev.id)) comments.push(ev);
                }
                if (ev.kind===7) {
                    const e = ev.tags?.find(t=>t[0]==="e")?.[1];
                    if (e) {
                        const s = scores.get(e) || {up:0,down:0};
                        const val = ev.content === '+' || ev.content === '' ? 1 : ev.content === '-' ? -1 : 0;
                        if (val) { if (val===1) s.up++; if (val===-1) s.down++; scores.set(e, s); render(); }
                    }
                }
                render();
            };
        });

        setInterval(render, 15000);
        render();
    }
})();
