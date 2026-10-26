# Contributing

Thanks for looking. NostrComments is small enough to understand in an afternoon, and help is
welcome — a reproducible bug report as much as a patch.

## Where things are

- `NostrComments-Chrome/` and `NostrComments-FireFox/` — the two extension builds. They are kept
  in lockstep: a change to one is almost always the same change to the other. The differences are
  deliberate and few (the manifest, and Firefox naming nos2x-fox where Chrome names nos2x).
  `tests/parity.test.mjs` fails if they drift.
- `content.js` — nearly everything: the panel, relays, signing, rendering. One file per build, no
  bundler, no build step. The file you install is the file in the repository.
- `background.js`, `popup.*`, `nc-history.*` — the background socket, the toolbar popup and the
  history page.
- `NostrComments-Userscript/` — frozen at 23.2.0; please do not change it.
- `tests/` — unit suites (`*.test.mjs`) and browser suites (`browser-*.mjs`).

## Before you open a pull request

```sh
node tests/run.mjs                              # unit suites, Node 18+, nothing to install
node tests/browser-<the area you touched>.mjs   # needs chromium + chromedriver
NC_BROWSER=firefox node tests/browser-<…>.mjs   # and Firefox + geckodriver, if you can
```

The tests extract and run the real code from the shipped files, so they catch what actually
ships. If you change behaviour, change or add the test that shows it.

## How the code is written

- **No dependencies.** Not in the extension, not in the tests.
- **Nothing from another person becomes HTML.** Text from events goes in with `textContent` and
  `createElement`, never `innerHTML`. Links go through `safeLink()`, pictures through
  `safeMediaUrl()`.
- **Controls that change what leaves the browser need a real click.** The panel lives in an open
  shadow root, so a page can call `.click()` on anything in it; `byUser()` checks for a trusted
  gesture. New buttons of that kind should use it.
- **Nothing is sent before consent, and as little as possible after.** If a change makes a new
  request, say in the pull request what it sends, to whom, and when — and update `PRIVACY.md`.
- **Comments say why**, especially when the obvious alternative was tried and failed. Most of the
  file reads that way; match it.

## Good first issues

Issues labelled [good first issue](https://github.com/briskness-byte/NostrComments/labels/good%20first%20issue)
are small, self-contained and come with a pointer to where to start. Ask in the issue if anything
is unclear — that is a fine first contribution too.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
