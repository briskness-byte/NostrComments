# NostrComments

Comment freely on any website — without censorship.

NostrComments adds a comment thread to every webpage, powered by the [Nostr](https://nostr.com)
protocol. Comments live on public Nostr relays — no company owns them, no platform can delete
them, and no moderator can decide the conversation is over.

That matters most where it is least welcome: on a news site that closed its comments, on a
government page, on a corporate announcement, on an article in a country where disagreeing in
public is expensive. The comment thread is attached to the page's URL, not hosted by the page's
owner, so it stays reachable whether or not they want it to exist.

Published on the [Chrome Web Store](https://chromewebstore.google.com/detail/nostrcomments/ebmgdpicceaencegknannfaljhbfgido),
on [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/nostrcomments/) and as a
userscript. In active development since December 2025, with new releases most weeks.

## Privacy

NostrComments has **no server**. There is no account, no email, no telemetry, and no analytics
of any kind — the developer never receives your data, because there is nowhere for it to go.

Because the extension can run on every page you visit, that claim deserves proof rather than
trust. The short version:

- **Nothing is transmitted until you explicitly enable it.** On first use you get a disclosure
  screen; no relay is contacted before you accept it, and you can disable NostrComments per site
  at any time.
- **Your private key never leaves your device.** It is used only to sign events, and can
  optionally be encrypted at rest with a password (PBKDF2 + AES-GCM).
- **Only what you choose to publish is published**: your comment or vote and your public key —
  sent to the public relays you have configured, not to us.
- **But the relays do see which pages you read.** Finding a thread means asking them about a
  page, so the relays you choose learn the URL and your IP address. That is inherent to a comment
  system attached to URLs rather than a choice made for you, and since v22.53 it applies only to
  pages you actually read — never to a tab you did not look at or a page you left in a second.
  The relay list is yours: remove any you do not trust, or run your own.

The full policy is in **[PRIVACY.md](PRIVACY.md)**.

## Features

- **Works on any website** — news, blogs, paywalled content, anything
- **No account required** — generate a keypair in one click, or connect an existing Nostr wallet
- **Truly decentralised** — comments are stored on public relays, not our servers
- **Profile avatars** — fetches Nostr profile pictures and display names
- **Dark mode** — toggle between dark and light mode, or follow system preference
- **Upvote / downvote** — community-driven auto-hide for low-quality comments
- **Delete your own comment** — publishes a NIP-09 request; relays that honour it drop it
- **Mute users** — hide comments from specific users permanently
- **Mute words** — hide any comment containing a word or phrase you choose
- **"New" badges** — comments posted since your last visit to a page are marked
- **Reply notifications** — get notified when someone replies to your comment
- **Zaps** — tip a commenter over Lightning (NIP-57)
- **Portable identity** — copy your key as `nsec` / `npub` (NIP-19) for any other Nostr app
- **Resilient connections** — relays reconnect automatically with a capped backoff
- **Relative timestamps** — shows "2h ago", "3d ago", etc.
- **Inline media** — images and videos embedded directly in comments
- **Copy note link** — share a direct `nostr:` link to any comment
- **Custom relays** — add or remove relays from the Settings panel
- **Search and sort** — newest, oldest, most upvoted
- **Paginated** — loads 20 comments at a time

## Installation

### Chrome / Brave / Edge

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/nostrcomments/ebmgdpicceaencegknannfaljhbfgido).

Or load it manually, without the store:

1. Download `NostrComments-Chrome-vX.Y.zip` from the [latest release](https://github.com/briskness-byte/NostrComments/releases/latest) and unzip it
2. Go to `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** and select the unzipped folder

### Firefox

Install from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/nostrcomments/).

Or manually: download `NostrComments-Firefox-vX.Y.xpi` from the
[latest release](https://github.com/briskness-byte/NostrComments/releases/latest) and drag it into
Firefox, or open `about:addons` → gear icon → **Install Add-on From File**.

### Userscript (Tampermonkey / Greasemonkey)

Download `NostrComments-vX.Y.user.js` from the
[latest release](https://github.com/briskness-byte/NostrComments/releases/latest) and install it
in your userscript manager.

## Getting started

When you open the comment panel for the first time you will see a disclosure screen explaining
what gets sent where. After you accept it, the onboarding screen offers two options:

1. **Generate a key** — click *Start commenting — generate your key*. A keypair is created
   locally in your browser. Back it up from the ⚙ Settings panel — you can copy it as `nsec` to
   use the same identity in any other Nostr app — and consider setting a password to encrypt it
   at rest.
2. **Connect a wallet** — use [Alby](https://getalby.com) or [nos2x](https://github.com/fiatjaf/nos2x)
   for signing via the NIP-07 browser extension standard.

## Default relays

- `wss://nos.lol`
- `wss://relay.damus.io`
- `wss://relay.nostr.band`
- `wss://relay.primal.net`
- `wss://relay.snort.social`
- `wss://offchain.pub`

You can add or remove relays from the ⚙ Settings panel inside the extension.

## Development

No build system, no dependencies, no package manager. The extension is a single content script
per distribution, and the three distributions are kept in lockstep.

```sh
node tests/run.mjs         # run the test suite (Node 18+, no packages to install)
node tests/browser-qa.mjs  # drive the real extension in a browser (needs chromium + chromedriver)
sh build.sh                # produce the Chrome .zip, Firefox .xpi and userscript into dist/
```

The tests extract and exercise the **real code from the shipped source files**, so they fail if
shipped behaviour changes. They cover the hand-rolled secp256k1 / BIP-340 Schnorr implementation
(including the official BIP-340 reference vector, so events interoperate with other Nostr
clients), event signature verification, at-rest key encryption, URL normalisation, NIP-19
identity encoding, the Lightning payment path, and byte-identical parity of the security-critical
code across the Chrome, Firefox and userscript builds.

`browser-qa.mjs` is separate because it needs a browser: it loads the unpacked extension in
chromium, drives the panel, and measures WCAG AA contrast against what is actually painted on
screen. See [tests/README.md](tests/README.md) for what each suite covers.

## Contributing

Pull requests welcome. Please run `node tests/run.mjs` before opening one, and keep the three
distributions in sync — `tests/parity.test.mjs` will tell you if you missed one.

## Support

NostrComments is free and open source, and every feature stays that way — there is no paid tier
and nothing is held back. If it is useful to you, there is a one-line **Support the developer**
row at the bottom of the comment panel — a zap or two, and an arrow that opens the rest — sending
sats straight from your wallet to mine over Lightning. No account, no server in between.

If you have no wallet open and would rather scan something, there is a payment page at
<https://coinos.io/slurpnc> — same wallet as the Lightning address below, showing a QR code and
taking any amount.

Or send to one of these directly:

- **Lightning:** `slurpnc@coinos.io`
- **Nostr:** `npub1ewxm82gprxwkh9qznauyey6vwx62xetpsux3prnmddkyevasatgswmds9e`
- **On-chain Bitcoin:** `198yNVWJz2H8PwmNsX72URVVV9pRbxMb18`
- **Monero:** `87aDTPD9HQx2QenKsS7MvHDdqsziFPD7UB37X6G5XVXc2ZPhAs8DdEKUPYJijVcRjj1gU5KvxLCTfWUKWqrd1D5o8uw5EpM`

## License

MIT
