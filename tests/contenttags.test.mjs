// Hashtags and quotes in what the reader writes (GitHub issues #3 and #4, Oct 2026).
//
// contentTags() turns the text into the tags other clients read: a t tag per hashtag, so a warning
// tagged #scam reaches people following #scam, and a q tag per quoted nostr:note/nevent/naddr, so it
// shows as a quote. plainWithRefs() marks the same things when a comment is drawn.
//
// What must hold: a # inside a URL (a page anchor) is never a hashtag; "#3" is a number, not a tag;
// tags are lowercase, unique and capped; a quote carries only the event, never the relay hints
// inside the nevent; a string that only looks like a nostr: reference is left as text; and the
// display never builds HTML from the text.
import fs from 'fs';

const FILES = { chrome: '../NostrComments-Chrome/content.js', firefox: '../NostrComments-FireFox/content.js' };
// Real references: the nevent is the one in tests/niplink.test.mjs, checked against live relays.
const NEVENT = 'nevent1qvzqqqqy2upzq3hnc7an8npsryzfkaku38dmjm35cfrmmkngk6kcvvngy7fllzs6qy88wumn8ghj7mn0wvhxcmmv9uq3wamnwvaz7tmjv4kxz7fwwpexjmtpdshxuet59uqzqgzxryf57ez3uzwj9v27zkza725nt7p4knatj3ktvzrh5u8rru5m4klnsa';
const NEVENT_ID = '204619134f6451e09d22b15e1585df2a935f835b4fab946cb60877a70e31f29b';
const NADDR = 'naddr1qvzqqqrcvypzq3hnc7an8npsryzfkaku38dmjm35cfrmmkngk6kcvvngy7fllzs6qqsku6ts94kxjmnt94mk2c3dw3hj6mn0wd68ytt9de6xjare94kxjmnt7pzrp0';
const NADDR_ADDR = '30817:46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a:nip-link-web-to-nostr-entity-link';

// Just enough DOM for plainWithRefs: it only creates text nodes, spans and links and appends them.
function fakeDocument() {
    const el = tag => ({ tag, className: '', textContent: '', href: '', title: '', target: '', rel: '', children: [], appendChild(c) { this.children.push(c); } });
    return { createTextNode: t => ({ tag: '#text', textContent: t }), createElement: el, frag: () => el('#frag') };
}

export async function run() {
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };

    const srcs = {};
    for (const [name, rel] of Object.entries(FILES)) srcs[name] = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    const block = (src, tag) => { const a = src.indexOf(`// ${tag}: start`), b = src.indexOf(`// ${tag}: end`, a); return a >= 0 && b > a ? src.slice(a, b) : null; };
    ok('the two builds carry the same contentTags', block(srcs.chrome, 'contentTags') === block(srcs.firefox, 'contentTags'));
    ok('and the same plainWithRefs', block(srcs.chrome, 'plainWithRefs') === block(srcs.firefox, 'plainWithRefs'));

    for (const [name, src] of Object.entries(srcs)) {
        const bech = block(src, 'bech32-to-hex-string'), ct = block(src, 'contentTags'), pr = block(src, 'plainWithRefs');
        ok(`${name}: the blocks can be read out of content.js`, bech && ct && pr);
        if (!bech || !ct || !pr) continue;
        const document = fakeDocument();
        const tb0 = src.indexOf('        function toBech32(hrp, hex) {'), tb1 = src.indexOf('        // bech32-to-hex-string: start', tb0);
        const { contentTags, plainWithRefs } = new Function('document', `${src.slice(tb0, tb1)}\n${bech}\n${ct}\n${pr}\nreturn { contentTags, plainWithRefs };`)(document);
        const t = s => contentTags(s).filter(x => x[0] === 't').map(x => x[1]);
        const q = s => contentTags(s).filter(x => x[0] === 'q');

        // --- hashtags -----------------------------------------------------------------------------
        ok(`${name}: hashtags become t tags`, JSON.stringify(t('Beware of possible #vps #scam')) === '["vps","scam"]', t('Beware of possible #vps #scam'));
        ok(`${name}: lowercase and unique`, JSON.stringify(t('#Scam and #SCAM and #scam')) === '["scam"]');
        ok(`${name}: at the start of the text and of a line`, JSON.stringify(t('#first\n#second')) === '["first","second"]');
        ok(`${name}: inside brackets too`, JSON.stringify(t('(see #vps)')) === '["vps"]');
        ok(`${name}: a page anchor in a URL is not a hashtag`, t('https://example.com/page#section and example.org/#top').length === 0, t('https://example.com/page#section'));
        ok(`${name}: nor a # stuck to a word`, t('C#sharp a#b').length === 0);
        ok(`${name}: a number is not a hashtag`, t('see issue #3 and #42').length === 0);
        ok(`${name}: letters beyond ASCII count`, JSON.stringify(t('#Überwachung #日本')) === '["überwachung","日本"]', t('#Überwachung #日本'));
        ok(`${name}: punctuation ends the tag`, JSON.stringify(t('#vps, #scam.')) === '["vps","scam"]');
        ok(`${name}: at most ten`, t(Array.from({ length: 30 }, (_, i) => '#tag' + i).join(' ')).length === 10);
        ok(`${name}: and none from nothing`, contentTags('').length === 0 && contentTags(undefined).length === 0);

        // --- quotes -------------------------------------------------------------------------------
        const qn = q(`Look at this:\n\nnostr:${NEVENT}`);
        ok(`${name}: a quoted nevent becomes a q tag with its event id`, qn.length === 1 && qn[0][1] === NEVENT_ID, qn);
        ok(`${name}: and only the id — no relay hint from inside the nevent`, qn.length === 1 && qn[0].length === 2, qn);
        ok(`${name}: a quoted naddr carries its address`, q(`nostr:${NADDR}`)[0]?.[1] === NADDR_ADDR, q(`nostr:${NADDR}`));
        ok(`${name}: the same quote twice is one tag`, q(`nostr:${NEVENT} nostr:${NEVENT}`).length === 1);
        ok(`${name}: a broken reference is not tagged`, q('nostr:nevent1qqqqqqqqqqqqqqqqqqqqqq').length === 0);
        ok(`${name}: a bare nevent without nostr: is not tagged`, q(NEVENT).length === 0);
        ok(`${name}: hashtags and a quote together`, JSON.stringify(contentTags(`#vps\n\nnostr:${NEVENT}`)) === JSON.stringify([['t', 'vps'], ['q', NEVENT_ID]]));

        // --- mentions (NIP-27) ---------------------------------------------------------------------
        const PK = '46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a';
        const NPUB = 'npub1gmeu0wenescpjpymwmwgnkaedc6vy3aamf5tdtvxxf5z0yll3gdqatwl3v';
        const p = s2 => contentTags(s2).filter(x => x[0] === 'p');
        ok(`${name}: a mentioned npub becomes a p tag`, p(`thanks nostr:${NPUB}!`)[0]?.[1] === PK, p(`thanks nostr:${NPUB}!`));
        ok(`${name}: the same person twice is one tag`, p(`nostr:${NPUB} and nostr:${NPUB}`).length === 1);
        ok(`${name}: a bare npub without nostr: is not a mention`, p(NPUB).length === 0);
        ok(`${name}: a broken npub is not a mention`, p('nostr:npub1qqqqqqqqqqqqqqqqqq').length === 0);
        ok(`${name}: at most ten`, p(Array.from({ length: 12 }, () => 'nostr:' + NPUB).join(' ')).length === 1);

        // --- display ------------------------------------------------------------------------------
        const draw = s => { const f = document.frag(); plainWithRefs(f, s); return f.children; };
        const d1 = draw('Beware #scam here');
        ok(`${name}: a hashtag is drawn as a marked span`, d1.length === 3 && d1[1].tag === 'span' && d1[1].className === 'nc-hashtag' && d1[1].textContent === '#scam', d1);
        ok(`${name}: with the text around it kept`, d1[0].textContent === 'Beware ' && d1[2].textContent === ' here');
        ok(`${name}: a number stays plain text`, draw('issue #3').every(n => n.tag === '#text'));
        const d2 = draw(`nostr:${NEVENT}`);
        const a = d2[0];
        ok(`${name}: a quote is drawn as a short link`, d2.length === 1 && a.tag === 'a' && a.className === 'nc-quote' && a.textContent.length < 40, a);
        ok(`${name}: to the public viewer`, a.href === 'https://njump.me/' + NEVENT, a.href);
        ok(`${name}: opened without opener or referrer`, a.target === '_blank' && a.rel === 'noopener noreferrer');
        ok(`${name}: saying what it is`, /^↪ quoted note nevent/.test(a.textContent), a.textContent);
        ok(`${name}: an naddr is a quoted post`, /^↪ quoted post naddr/.test(draw(`nostr:${NADDR}`)[0].textContent));
        ok(`${name}: a broken reference stays text`, draw('nostr:nevent1qqqqqqqqqqqqqqqqqqqqqq').every(n => n.tag === '#text'));
        const dm = draw(`hi nostr:${NPUB}`);
        ok(`${name}: a mention is drawn as @ and a short npub when no name is known`, dm.length === 2 && dm[1].tag === 'a' && dm[1].className === 'nc-mention' && /^@npub1/.test(dm[1].textContent), dm[1]);
        ok(`${name}: linking to the profile, without opener or referrer`, dm[1].href === 'https://njump.me/' + NPUB && dm[1].rel === 'noopener noreferrer');
        const all = draw(`<img src=x onerror=alert(1)> #tag nostr:${NEVENT}`);
        ok(`${name}: markup in the text stays text`, all[0].tag === '#text' && all[0].textContent.startsWith('<img'));
        ok(`${name}: and nothing here writes HTML`, !/innerHTML|outerHTML|insertAdjacentHTML/.test(pr));
    }

    // A relay somebody else named: a hint inside a quote, or a relay list in a profile. Only wss://,
    // never an address on the reader's own network, never with a name and password.
    for (const [name, src] of Object.entries(srcs)) {
        const n0 = src.indexOf('        function normRelay(u) {'), n1 = src.indexOf('        function dedupeRelays', n0);
        const fr = block(src, 'safeForeignRelay'), bech = block(src, 'bech32-to-hex-string');
        ok(`${name}: safeForeignRelay and linkedRelays can be read out`, n0 >= 0 && n1 > n0 && fr && bech && bech.includes('function linkedRelays('));
        if (!(n0 >= 0 && n1 > n0 && fr && bech)) continue;
        const { safeForeignRelay, linkedRelays } = new Function(`${src.slice(n0, n1)}\n${fr}\n${bech}\nreturn { safeForeignRelay, linkedRelays };`)();
        ok(`${name}: a normal relay passes, normalised`, safeForeignRelay('wss://Relay.Example.com/') === 'wss://relay.example.com', safeForeignRelay('wss://Relay.Example.com/'));
        for (const bad of ['ws://relay.example.com', 'https://relay.example.com', 'wss://10.0.0.5', 'wss://192.168.1.1:7777', 'wss://[::1]', 'wss://localhost',
                           'wss://router.local', 'wss://printer', 'wss://user:pw@relay.example.com', 'javascript:alert(1)', '', null, 'wss://' + 'a'.repeat(300) + '.com'])
            ok(`${name}: refused: ${String(bad).slice(0, 40)}`, safeForeignRelay(bad) === null, safeForeignRelay(bad));
        const hints = linkedRelays('nostr:' + NEVENT);
        ok(`${name}: the relay hints inside a real nevent are read`, Array.isArray(hints) && hints.length >= 1 && hints.every(h => h.startsWith('wss://')), hints);
        ok(`${name}: a note1 has none`, linkedRelays('note1' + 'q'.repeat(58)).length === 0);
        ok(`${name}: garbage has none`, linkedRelays('nevent1qqqq').length === 0 && linkedRelays(42).length === 0);
    }

    // Every event that carries the reader's words gets them: the NIP-22 comment, the kind 1 reply
    // to a note, and the note "Share" posts to the reader's feed.
    for (const [name, src] of Object.entries(srcs)) {
        ok(`${name}: comments and replies to notes carry the text's tags`, (src.match(/for \(const t of contentTags\(text\)\) if \(!tags\.some\(x => x\[0\] === t\[0\] && x\[1\] === t\[1\]\)\) tags\.push\(t\);/g) || []).length === 2);
        ok(`${name}: and so does the note shared to the feed`, src.includes('tags: [...contentTags(ev.content), ...(labelClient'));
    }
    return { name: 'hashtags and quotes', pass, fail };
}
