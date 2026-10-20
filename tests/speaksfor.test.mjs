// speaksFor(): when a commenter is labelled "speaks for example.com" (GitHub issue #1).
//
// The label rests on the site's own /.well-known/nostr.json naming the key under "_" — the root
// identifier — for exactly the host the thread is about. It proves control of the domain, not
// authorship, and it must never appear for an unchecked claim, a lookalike domain, or a subdomain
// that may belong to somebody else.
import fs from 'fs';

const FILES = { chrome: '../NostrComments-Chrome/content.js', firefox: '../NostrComments-FireFox/content.js' };

export async function run() {
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };

    for (const [name, rel] of Object.entries(FILES)) {
        const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
        const a = src.indexOf('        function speaksFor('), b = src.indexOf('        async function verifyNip05(', a);
        ok(`${name}: speaksFor() can be read out of content.js`, a >= 0 && b > a);
        if (a < 0 || b < 0) continue;
        const speaksFor = new Function(`${src.slice(a, b)}\nreturn speaksFor;`)();
        const P = 'https://example.com/articles/42';

        ok(`${name}: the site's own key, checked`, speaksFor('_@example.com', true, P) === 'example.com');
        ok(`${name}: www on the page is ignored`, speaksFor('_@example.com', true, 'https://www.example.com/a') === 'example.com');
        ok(`${name}: www in the claim is ignored`, speaksFor('_@www.example.com', true, P) === 'example.com');
        ok(`${name}: case does not matter`, speaksFor('_@Example.COM', true, 'https://EXAMPLE.com/') === 'example.com');
        ok(`${name}: never for a claim that was not checked`, speaksFor('_@example.com', false, P) === null && speaksFor('_@example.com', null, P) === null && speaksFor('_@example.com', undefined, P) === null);
        ok(`${name}: never for an ordinary name at the domain`, speaksFor('bob@example.com', true, P) === null);
        ok(`${name}: never for another domain`, speaksFor('_@example.org', true, P) === null);
        ok(`${name}: never for a lookalike that ends the same`, speaksFor('_@evilexample.com', true, P) === null && speaksFor('_@example.com.evil.net', true, P) === null);
        ok(`${name}: a subdomain does not speak for its parent`, speaksFor('_@blog.example.com', true, P) === null);
        ok(`${name}: nor the parent for a subdomain`, speaksFor('_@example.com', true, 'https://blog.example.com/x') === null);
        ok(`${name}: a bare domain without "_@" does not count`, speaksFor('example.com', true, P) === null);
        ok(`${name}: nothing, or a page address it cannot read, gives nothing`, speaksFor(undefined, true, P) === null && speaksFor('_@example.com', true, 'not a url') === null);

        // The label is drawn only inside the verified branch, and says what it proves.
        const drawn = src.indexOf("badge.className = 'nc-site';");
        const tickBranch = src.lastIndexOf("if (nip05Verified(ev.pubkey)) {", drawn);
        ok(`${name}: the label is drawn only where the name was checked`, drawn > 0 && tickBranch > 0 && drawn - tickBranch < 800);

        // Reported 21 Oct 2026: a check was cached per key, so a newer profile claiming
        // _@victim.example inherited the "true" of an earlier, honest name. A result now belongs to
        // the key and the exact name it was fetched for, and the label reads the current name.
        ok(`${name}: results are keyed by key and name, not by key alone`,
           src.includes("const nip05Key = (pubkey, id) => pubkey + '\\n' + (id || '');") &&
           /nip05Verified = pubkey => nip05Check && nip05s\.has\(pubkey\) && nip05ok\.get\(nip05Key\(pubkey, nip05s\.get\(pubkey\)\)\) === true/.test(src));
        ok(`${name}: no result is ever stored under the key alone`, !/nip05ok\.(set|get|has)\((ev\.)?pubkey[,)]/.test(src));
        ok(`${name}: a newer profile with no name drops the old one`, src.includes('else nip05s.delete(ev.pubkey);'));
        ok(`${name}: a check that finishes after the setting was switched off records nothing`,
           /if \(!nip05Check\) return;\s*nip05ok\.set\(key, ok\);/.test(src));
        ok(`${name}: it says "speaks for", not "author" or "owner"`, /badge\.textContent = `speaks for \$\{site\}`;/.test(src) && !/badge\.textContent = `[^`]*(author|owner)/i.test(src));
    }
    return { name: 'speaks for the site', pass, fail };
}
