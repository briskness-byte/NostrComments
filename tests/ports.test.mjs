// No two browser suites may claim the same port.
//
// They bind real servers on 127.0.0.1 — a relay, a site, a webdriver — so two suites holding the
// same number collide the moment they overlap, and a leftover process from a crashed run collides
// with the next suite that starts. The failure does not look like a port problem: the extension
// simply never injects, and the suite reports "extension injects into the page → null", which
// points nowhere near the cause. That cost twenty minutes on 19 Aug 2026 before the real reason
// turned up, and by then it had been blamed on Firefox.
//
// Derived ports are included, because `RELAY_PORT + 3` is a port like any other and colliding
// silently is exactly what it does.
import fs from 'fs';
import path from 'path';

const DIR = new URL('./', import.meta.url);

export async function run() {
    let p = 0, f = 0;
    const ok = (n, c, extra) => {
        c ? p++ : f++;
        if (!c) console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
    };

    const files = fs.readdirSync(DIR).filter(n => /^browser-.*\.mjs$/.test(n)).sort();
    ok('there are browser suites to check', files.length > 0, files.length);

    // suite -> every port it will try to bind
    const claimed = new Map();
    for (const name of files) {
        const src = fs.readFileSync(new URL(name, DIR), 'utf8');
        const ports = new Map();               // port -> how it was written
        for (const m of src.matchAll(/(QA_\w+)\s*\|\|\s*(\d+)/g)) ports.set(Number(m[2]), m[1]);
        // `const X = Number(process.env.QA_Y || 1234)` then `X + 3` elsewhere.
        for (const m of src.matchAll(/(\w*(?:RELAY|SITE|CD)_PORT)\s*\+\s*(\d+)/g)) {
            const base = new RegExp(`${m[1]}\\s*=\\s*Number\\(process\\.env\\.QA_\\w+\\s*\\|\\|\\s*(\\d+)`).exec(src);
            if (base) ports.set(Number(base[1]) + Number(m[2]), `${m[1]}+${m[2]}`);
        }
        claimed.set(name, ports);
    }

    const owners = new Map();                  // port -> [suite (how)]
    for (const [suite, ports] of claimed)
        for (const [port, how] of ports)
            owners.set(port, [...(owners.get(port) || []), `${suite} (${how})`]);

    const clashes = [...owners.entries()].filter(([, v]) => v.length > 1).sort((a, b) => a[0] - b[0]);
    for (const [port, who] of clashes) ok(`port ${port} is claimed once`, false, who);
    ok('no two suites claim the same port', clashes.length === 0, clashes.length);

    return { name: 'suite port allocation', pass: p, fail: f };
}
