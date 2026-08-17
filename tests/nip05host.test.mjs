// Which hosts a NIP-05 identifier is allowed to send the reader's browser to.
//
// The identifier comes from somebody else's profile, and checking it means fetching from the domain
// it names. The pattern that used to guard that let through a port, an IPv6 literal, and every bare
// address — so a profile could point at 192.168.1.1 or 127.0.0.1 and have a reader's own browser
// knock on their network. The response is unreadable across origins, but whether anything answers,
// and how fast, is not something the author of a comment should be able to collect.
//
// So: domains only. Anything that is not a plain domain name is refused rather than parsed
// carefully, which is both simpler and stricter than listing the ranges that matter.
import { extensionCode } from './harness.mjs';

export async function run() {
    const { nip05Host } = extensionCode();
    const out = { name: 'NIP-05 host validation', pass: 0, fail: 0, lines: [] };
    const ok = (n, c, e) => c ? (out.pass++, out.lines.push('  ✓ ' + n))
                              : (out.fail++, out.lines.push('  ✗ ' + n + (e !== undefined ? '  → ' + JSON.stringify(e) : '')));

    const allow = [
        ['example.com', 'example.com'],
        ['sub.example.com', 'sub.example.com'],
        ['EXAMPLE.COM', 'example.com'],
        ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
        ['a-b.co.uk', 'a-b.co.uk'],
    ];
    for (const [input, want] of allow) ok(`allows ${input}`, nip05Host(input) === want, nip05Host(input));

    const refuse = [
        ['192.168.1.1',      'a private address'],
        ['10.0.0.5',         'another private range'],
        ['127.0.0.1',        'loopback'],
        ['169.254.169.254',  'the link-local address cloud metadata answers on'],
        ['localhost',        'loopback by name'],
        ['printer.local',    'mDNS on the local network'],
        ['[::1]',            'an IPv6 literal'],
        ['example.com:8080', 'a port, which turns this into a scanner'],
        ['10.0.0.5:22',      'a private address with a port'],
        ['user:pw@evil.com', 'credentials in the authority'],
        ['evil.com/../x',    'a path'],
        ['evil.com?a=1',     'a query'],
        ['evil.com#f',       'a fragment'],
        ['evil.com%2f',      'an encoded separator'],
        ['.example.com',     'a leading dot'],
        ['example.com.',     'a trailing dot'],
        ['exam..ple.com',    'an empty label'],
        ['-bad.example.com', 'a label starting with a hyphen'],
        ['bad-.example.com', 'a label ending with a hyphen'],
        ['example',          'a single label'],
        ['',                 'nothing at all'],
        [null,               'not a string'],
        ['a'.repeat(260) + '.com', 'longer than a domain name can be'],
    ];
    for (const [input, why] of refuse) ok(`refuses ${JSON.stringify(input)} — ${why}`, nip05Host(input) === null, nip05Host(input));

    // The check the autofix suggested upstream would have passed the first four of those: it blocked
    // ports and brackets but allowed bare addresses, and named localhost as explicitly permitted.
    ok('an address is never accepted, in any of its forms',
       ['192.168.1.1', '127.0.0.1', '0.0.0.0', '8.8.8.8'].every(a => nip05Host(a) === null));

    return out;
}
