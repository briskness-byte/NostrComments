# Security Policy

## What this is

A browser extension and userscript that attaches a comment thread to any URL, using the Nostr
protocol. **There is no server.** No account, no backend, no database, nothing to breach that
belongs to this project. Everything happens in the browser or directly between the browser and
public relays that the user chooses.

That shapes the threat model. The things worth attacking are:

- the user's private key, held in extension storage and optionally encrypted at rest;
- anything the extension puts in the page, since it renders inside a shadow root on sites it does
  not control;
- the signing path, where a hostile page could try to get something signed that the user did not
  write;
- the published packages themselves, which is a store-account problem rather than a code one.

## Supported versions

**The current release, and nothing else.**

Chrome, Firefox and Greasyfork all auto-update, releases are frequent, and there is no long-term
branch to backport to. A fix ships as a new version rather than as a patch to an old one. If you
are running something older, updating is the fix.

Version numbers are `MAJOR.MINOR.PATCH` since 23.0.0.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Three private channels. Any of them is fine — use whichever costs you least:

1. **GitHub private vulnerability reporting** — the "Report a vulnerability" button on the Security
   tab of this repository. Nothing becomes public until it is fixed and I publish it.
2. **Email:** `36pfxv8wd@mozmail.com`
3. **A Nostr DM** to `npub1ewxm82gprxwkh9qznauyey6vwx62xetpsux3prnmddkyevasatgswmds9e`, which is
   this project's identity. Fitting, given the subject.

Useful things to include: the version, the browser, and — if you can — the smallest page that
reproduces it. A working proof of concept is worth more than a description; the last serious
finding here was demonstrated with a script that read the private key out of the DOM, which is
what made it undeniable.

## What to expect

This is one person working on it in their own time, not a company with a rota.

- I read reports within a week, usually sooner.
- If it is real, I will say so and tell you roughly when a fix will ship. Small fixes go out in
  days, because releasing is cheap here.
- If I think it is not a problem, I will explain why rather than going quiet. If you disagree, say
  so — I have been wrong before.
- Credit in the release notes if you want it, under whatever name you prefer. **There is no bounty
  and no money**; this project has no income beyond voluntary tips.

Please give me a reasonable window before publishing. I am not going to name a number of days as if
it were a contract — if a fix is taking too long, tell me you intend to publish and that is fair.

## Already known, and deliberate

Please do not report these as new; they are documented decisions, with the reasoning in
[docs/SECURITY-AUDIT-2026-08.md](docs/SECURITY-AUDIT-2026-08.md).

- **The panel's shadow root is `{mode: 'open'}`.** Any script on the page can reach into it. Closing
  it is mostly theatre: a script in `<head>` runs before the content script and can hook
  `Element.prototype.attachShadow`, and it would cut off the test suites, which reach the panel
  exactly the way an attacker would. The rule adopted instead is that nothing sensitive is left in
  the DOM — the private key is held in a variable, and the identity strings and Settings lists are
  written only while the panel is open and cleared when it closes.
- **The relays you configure learn which pages you read.** That is inherent to a comment system
  keyed to URLs, not an oversight, and it is stated plainly in
  [PRIVACY.md](PRIVACY.md) before anybody installs it.
- **A page can remove or cover the panel.** It runs on somebody else's document; that is the deal.
- **A page's Content-Security-Policy can block the relay connections.** On Firefox this silently
  empties the panel, and the extension now says so rather than pretending nobody has commented.
  The real fix needs the connection opened outside the page's reach and is planned.

## Out of scope

- **Relay operators.** They can refuse, drop or fail to keep anything. Comments are published to
  several relays for that reason, and the panel says when only one accepted.
- **Third-party signers** (Alby, nos2x) and Lightning wallets. Report those to their authors.
- **The stores.** Listing or distribution problems belong to Google, Mozilla or Greasyfork.
- Anything requiring an attacker who already controls the user's browser or operating system.

## What has been looked at

There is a published audit with findings, fixes, and the things deliberately not fixed:
[docs/SECURITY-AUDIT-2026-08.md](docs/SECURITY-AUDIT-2026-08.md).

The test suite is dependency-free and runs the shipped code: `node tests/run.mjs`. Several suites
are written from the attacker's seat — `tests/browser-keyexposure.mjs` sweeps every input value,
attribute and text node in the shadow root for the private key and the password, and
`tests/browser-signer.mjs` installs a signer that claims one key and signs with another, and
`tests/browser-xss.mjs` publishes hostile comments and a hostile profile and checks that none of
it is ever parsed as markup.
