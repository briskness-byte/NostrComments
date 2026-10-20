// The settings panel is one scroll in five groups, with a row of buttons that jumps to each. This
// pins which control lives in which group, so a later edit cannot quietly drop one between groups
// or leave a jump button pointing at nothing. Read from the shipped markup, both builds.
import fs from 'fs';

const FILES = {
    chrome:  new URL('../NostrComments-Chrome/content.js', import.meta.url),
    firefox: new URL('../NostrComments-FireFox/content.js', import.meta.url),
};

const GROUPS = {
    'set-g-you':      ['identity-section', 'keypair-section', 'import-section', 'signer-section'],
    'set-g-reading':  ['muted-section', 'muteword-section', 'autoimg-toggle', 'nip05-toggle'],
    'set-g-button':   ['hidebtn-toggle', 'quietbtn-toggle', 'btnpos-row', 'btndefault-btn', 'site-disable-btn', 'disabled-list'],
    'set-g-relays':   ['relay-list', 'relay-add', 'widepub-toggle', 'worker-toggle', 'clienttag-toggle'],
    'set-g-activity': ['mythreads', 'notiflist'],
};

export async function run() {
    let pass = 0, fail = 0;
    const ok = (n, c, extra) => { c ? pass++ : (fail++, console.log('  ✗ FAIL ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))); };

    for (const [name, url] of Object.entries(FILES)) {
        const src = fs.readFileSync(url, 'utf8');
        const a = src.indexOf('<div id="settings">'), b = src.indexOf('<div id="notif-banner">', a);
        ok(`${name}: the settings markup can be found`, a >= 0 && b > a);
        const html = src.slice(a, b);
        const ids = Object.keys(GROUPS);
        const at = id => html.indexOf(`id="${id}"`);
        ok(`${name}: the groups come in order`, ids.every((g, i) => at(g) >= 0 && (i === 0 || at(ids[i - 1]) < at(g))), ids.map(at));
        for (const [g, controls] of Object.entries(GROUPS)) {
            const start = at(g);
            const next = ids[ids.indexOf(g) + 1];
            const end = next ? at(next) : html.length;
            for (const c of controls) ok(`${name}: ${c} is in ${g}`, at(c) > start && at(c) < end, { at: at(c), start, end });
            ok(`${name}: a jump button points at ${g}`, html.includes(`data-g="${g}"`));
        }
    }
    return { name: 'settings groups', pass, fail };
}
