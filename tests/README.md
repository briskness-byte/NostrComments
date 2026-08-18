# Tests

Dependency-free tests for the parts of NostrComments where a silent regression would hurt
most: the hand-rolled secp256k1 / BIP-340 Schnorr crypto, event verification, URL
normalization, and the Lightning payment path. They extract and run the **real code** from the
shipped source files, so they fail if the shipped behaviour changes.

## Run

```sh
node tests/run.mjs
```

Requires Node 18+ (uses the built-in `crypto.subtle` and `URL`). No packages to install.

## What's covered

- **secp.test.mjs** — sign→verify round-trips, rejection of tampered content / forged pubkeys /
  broken signatures, and the official BIP-340 reference vector (interop with other Nostr clients).
- **normalize.test.mjs** — `normalizeUrl()` strips tracking params, keeps meaningful query params
  (distinct pages ⇒ distinct threads), sorts the rest, and keeps only hash-router fragments.
- **zap.test.mjs** — `lnurlPay()` against a stubbed lnurl provider and wallet: sats→msat
  conversion, NIP-57 zap request shape (`p`/`e`/`amount` tags), degradation to plain lnurl-pay
  when no payee pubkey is set, min/max range errors, and that malformed addresses or provider
  errors never look like a completed payment.
- **relaymigration.test.mjs** — `migrateRelays()`, the one-time retirement of relays dropped from
  the defaults for not answering. A saved list wins over `DEFAULT_RELAYS` and should, but
  `saveRelays()` only runs on an add or a remove, so the list froze on the day it was last touched
  — dead relays included. Most of these assertions are about when it must *not* act: an
  already-migrated list, a user who never saved one, a list somebody deliberately trimmed. Getting
  those wrong overwrites a preference, which is worse than the dead relay it would be fixing.
- **parity.test.mjs** — the crypto, `verifyEvent`, `normalizeUrl`, relay migration, and voting snippets are
  byte-identical across the Chrome extension, Firefox extension, and userscript (guards against
  drift). Voting is in there because the browser QA only loads the Chrome build.

## Browser QA (separate, before a release)

`browser-qa.mjs` is **not** part of `run.mjs`: that suite is dependency-free and instant, while
this one needs a browser. It loads the real unpacked Chrome extension in chromium and checks what
only a browser can answer — does the panel render, does the consent overlay cover it beforehand,
does "Other…" reveal and focus the custom field, do the amount buttons lock while a payment is in
flight, and is every piece of text readable in both themes.

```sh
node tests/browser-qa.mjs                 # full run
node tests/browser-qa.mjs --no-live       # skip the step that contacts the Lightning provider
node tests/browser-qa.mjs --shots /tmp/x  # also write light + dark screenshots
CHROMIUM=/path/to/chrome node tests/browser-qa.mjs
```

Requires `chromium` (or Chrome) and a matching `chromedriver` on PATH. The binary is
auto-detected; override with `CHROMIUM`.

It measures **WCAG AA contrast** against the colour actually painted behind each element, in both
themes. That is worth running: it is how the contrast failures fixed in v22.41 were found — the
CSS looked perfectly reasonable.

Since v23.0.3 it measures **every element that paints its own text**, rather than four hand-picked
ids in the support block. It had been passing since v22.41 while eleven hint lines in Settings sat
at 3.40:1 on the dark panel: a contrast check aimed at one corner mostly proves that corner is
fine. Broadening it surfaced eighteen failures at once. Two things to know about reading its output:

- A gradient reports `backgroundColor: transparent`, so the original `bgOf` walked straight past a
  filled button and measured white text against the pale panel behind it — 1.08:1 for something
  that is really white on blue. It now takes the gradient's first colour stop.
- The brand blue is 3.00:1 against white, as text and as button background. Reaching 4.5:1 means a
  visibly darker blue across the whole UI, which is a decision about what the thing looks like.
  Those cases are listed in `BRAND_DEBT` with the ratio they had when measured and asserted as *no
  worse than that*, so the suite stays green, prints the debt every run, and still fails the moment
  one slips further. Delete an entry when its colour is fixed.

Two things to know. The live step makes a real request to the developer's Lightning provider and
creates an invoice; nothing is paid and it expires, but use `--no-live` if you would rather not.
And the one path it cannot cover is a **confirmed** payment — headless Chrome has no WebLN wallet,
so the supporter state and the thank-you message still need a manual check with a real wallet.

`browser-identity.mjs` covers the identity paths that cannot be undone: importing a key over one
that is already stored must warn, name the identity that will disappear, offer to copy it first,
and change nothing when cancelled. It also checks that the Connect button tracks the identity —
shown when nothing is connected, gone once something is, back again when the stored key is deleted.

```sh
node tests/browser-identity.mjs
```

`browser-votes.mjs` covers up- and downvoting, which needs a relay to mean anything — so it starts
a throwaway one on localhost, seeds it with a comment and three votes, and points the extension at
it. **Nothing is sent to a public relay.** It checks the half that broke silently for many
versions (votes cast by other people never loaded, including ones published without an `r` tag by
earlier versions) and the half that keeps a new vote findable (the reaction goes out tagged with
the comment, the author, and the page URL, and it verifies).

```sh
node tests/browser-votes.mjs
```

`browser-deletion.mjs` covers NIP-09 in the same way, and for the same reason — the interesting
part of a deletion is what *other* readers see. It checks that deleting a comment with replies
under it leaves a tombstone rather than taking somebody else's replies down with it, that one with
no replies disappears completely, that the published request is signed and tagged (`e`, `k`, `r`),
and that a comment posted and then deleted while you are reading leaves the screen without a
reload.

```sh
node tests/browser-deletion.mjs
```

`deletion.test.mjs` in the fast suite covers the security half — only the author can delete, and a
forged request is rejected. This one covers the blast radius, which only a rendered thread shows.

`browser-notifications.mjs` covers replies to you. The relay deliberately delivers a matching event
to the notification subscription before the thread subscription, because that is the order in which
the two used to fight over a shared seen-set and the thread lost — the badge counted a reply that
was never drawn. It also checks that a mention on a page you are not reading raises the badge
without appearing in this page's thread.

```sh
node tests/browser-notifications.mjs
```

`browser-publish.mjs` points the extension at a relay that refuses everything, which is what a
paid relay, a proof-of-work relay or a spam filter looks like from here. Nothing may pretend to
have worked: a refused comment must not appear in the thread, its text must stay in the box, and
the reason must reach the user instead of being swallowed. Same for a vote and for a deletion
request. It then lets the relay accept, to check the ordinary path still behaves.

```sh
node tests/browser-publish.mjs
```

`browser-muting.mjs` covers the other two ways a comment gets hidden. Muting somebody must not
take replies by people you did not mute down with them, and "tap to show" on a comment downvoted
past the threshold must actually show it — it used to drop the styling and leave the placeholder
sentence sitting there, revealing nothing.

```sh
node tests/browser-muting.mjs
```

All the relay-backed suites also need `openssl`: the extension only accepts `wss://` relay URLs, so
they generate a throwaway self-signed certificate and start Chrome with
`--ignore-certificate-errors`. Their default ports differ, so they can run alongside each other.

`browser-limits.mjs` seeds a thread big enough to matter: 40 comments with 20 reactions each, all
of the reactions newer than all of the comments. Against a shared `limit: 500` across kinds 1, 5
and 7 the reactions fill the whole budget and **not one comment arrives** — the thread renders
empty while every comment sits on the relay. The suite checks that a filter per kind loads all of
them, and that no truncation notice appears while everything fits.

```sh
node tests/browser-limits.mjs
```

The other half — the notice that *does* appear once a thread outgrows a single request — is not
covered: it needs more than 500 signed comments, which costs more run time than the string is
worth. The negative case above guards against it firing when it should not.

`browser-signer.mjs` installs a NIP-07 signer in the page that reports one key and signs with
another — what a hostile page can do, because the bridge to `window.nostr` runs on DOM events in
the page's own world and cannot be authenticated. It checks that the panel ends up believing the
key that signed rather than the one that was claimed, and that what goes out is the real signer's
event. The same path is what catches a signer that honestly switched account.

```sh
node tests/browser-signer.mjs
```

`browser-auth.mjs` points the extension at a relay that demands NIP-42 before it will serve or
accept anything. It checks that the thread behind that wall loads at all, that what gets sent is a
kind-22242 answering the relay's own challenge and signed by the connected identity, and that
posting works through it. `startRelay({ requireAuth: true })` verifies the signature properly — a
relay that accepted any old event would let a broken client look like a working one.

```sh
node tests/browser-auth.mjs
```

`browser-nip05.mjs` pins the default as much as the feature. A local TLS server stands in for the
claimed domain and counts its callers: with the setting off it must never be called at all, and no
mark may appear; switched on, it is asked for the claimed name and the mark appears only once the
key is confirmed; switched off again, the mark goes and nothing more is fetched.

```sh
node tests/browser-nip05.mjs
```

`browser-keypassword.mjs` covers the one-time offer to encrypt the stored key: that it is made when
a key first appears, that "not now" leaves a working identity alone and says where to find it later,
and — the part that matters most — that a reload does not bring the question back. A nag would be
worse than the unencrypted key.

```sh
node tests/browser-keypassword.mjs
```

`browser-lazyconnect.mjs` covers the deferred connection: a visit abandoned inside a second opens
nothing at all, a page that is actually read still connects and loads, and — the guarantee most
likely to be broken by a later refactor — opening the panel skips the wait entirely.

```sh
node tests/browser-lazyconnect.mjs
```

`browser-signeroffer.mjs` covers what the onboarding block offers somebody who already has a
signer. Its two wallet buttons were unconditional links to the store pages for Alby and nos2x —
shown even to a reader with one of them running at that moment, who was sent off to install an
extension already in their browser. Meanwhile the thing they wanted, *connect the signer I have*,
existed only behind the Connect button in the header, which does not say what it will do. Reported
from real use, exactly that way round.

The signer in this suite refuses until it is approved, which is what nos2x and Alby actually do on a
site they have not seen. That is the point: a signer that answers immediately is picked up by
auto-connect and the block is gone before anything could be pressed, so the awaiting-approval case
is the one the button exists for. Four of its thirteen checks fail against the code before.

```sh
node tests/browser-signeroffer.mjs
```

`browser-signerchoice.mjs` covers which key speaks for you, and whether the panel remembers what
you told it. Reported from real use as a worry about losing keys when switching between a stored key
and Alby or nos2x — the worry was right and the bug was worse than key loss: the stored key was
never deleted, but the choice was ignored, so choosing "Key stored here" and reloading with a signer
installed connected you as the signer's identity instead. The suite pins both directions, that
switching back finds the key still there, and that a signer which finishes injecting after the first
check is still picked up. Four of its checks fail against the code before the fix.

```sh
node tests/browser-signerchoice.mjs
```

`browser-csp.mjs` covers a site whose own Content-Security-Policy forbids the relay connections.
x.com names every host its code may reach in `connect-src` and nothing else, so every relay socket
is refused before it opens. **Chrome exempts a content script's requests from the page's policy;
Firefox does not, for WebSockets** — so on Firefox the panel emptied itself on any strict site, all
six relays sat at "not contacted yet", and the reader was told nobody had commented. Reported from
real use, and invisible from the panel: the console said it plainly and nothing else did.

The two engines are asserted differently on purpose, because they genuinely differ. On Firefox the
relay must be reported as blocked by the site and the thread must say so. On Chromium the same
header must not stop anything — which pins the exemption this extension relies on there, and would
catch it going away.

```sh
node tests/browser-csp.mjs
NC_BROWSER=firefox node tests/browser-csp.mjs
```

`browser-emptystate.mjs` covers what the panel says when it has nothing to show, and what it hands
to third-party image hosts. "No comments yet – be the first!" was said whatever the reason, so a
thread muted into silence and a search that matched nothing both reported a page nobody had ever
commented on — reported from real use, on a page with twenty-one comments all from one muted key.
Only one of the three situations is an invitation to write something. The same report turned up a
picture that appeared and vanished between reloads: that was the onerror fallback working correctly
against a flaky public gateway, but it exposed that images were fetched eagerly and without a
referrer policy, so the server hosting somebody's avatar was told the address of every page the
reader opened where that person had commented. It also covers the other half of that message: it
sends the reader to Settings, which used to hide the muted-users and disabled-sites lists whenever
they were empty — so somebody arriving to check who they had muted found no such section, which
looks exactly like an extension that cannot mute anyone. Eleven of its fifteen checks fail against
the code before the fix.

Note the two ways an earlier draft of this suite passed while testing nothing: it pointed the images
at a hostname that never resolves, so every one of them had already been replaced by the link
fallback, and it asserted on the thread before the relay had answered. It now serves a real image and
polls for the thread.

```sh
node tests/browser-emptystate.mjs
```

`browser-redundancy.mjs` covers how many relays actually end up holding a comment. Publishing
resolves on the first acceptance, which keeps posting quick and meant one relay and nine looked
identical from the outside — and they are not: measured 14 Aug 2026 over the previous 180 days,
counting only comments with the tag shape this extension writes (the wider NIP-22 web corpus on
those relays is mostly one CLI client, so it says nothing about us), 20% of 86 such comments sat on
exactly one relay and 34% on two. It happened for real on 20min.ch, where a surviving vote names a
comment no relay serves any more and no deletion request was ever published. Three relays are used: one that
accepts, one that refuses the first delivery and accepts the second, and one that refuses on policy
every time. The suite pins that a transient refusal is retried, that landing on exactly one relay is
reported rather than looking like a clean success, and — so the warning does not become noise — that
two acceptances stay quiet. Three of its eight checks fail against the code before the fix.

```sh
node tests/browser-redundancy.mjs
```

`browser-signerdead.mjs` covers the other half of that: a signer that was answering and stops.
Disabling nos2x or Alby does not take `window.nostr` off a page that is already open — the object
belongs to the page, the extension behind it does not — so the provider keeps accepting `signEvent`
and forwarding it to a background script that is gone. No answer ever comes back, and no check the
panel can make sees anything wrong, including its own `check`, which reads `!!window.nostr` and
nothing more. Reported from real use as "the Post button goes dead and nothing is said": it was
waiting the full minute, and the message that finally arrived hid itself again after 2.5 seconds.
The suite installs a signer that answers once and then returns a promise that never settles, and
pins that the panel says so within seconds, keeps saying it, holds the button, and loses nothing
that was typed. Three of its checks fail against the code before the fix; the other three are
guards that already held and have to keep holding.

```sh
node tests/browser-signerdead.mjs
```

`browser-keyboard.mjs` covers typing into the panel on a page that binds keys itself. The panel
renders inside somebody else's document, so its keystrokes travel through whatever that page
listens for. Reported from real use on a Nostr client where the space bar did nothing inside the
comment box: the site reads space off `document` and cancels it, and the character goes with it.
Most clients bind space, and so do GitHub, YouTube and Reddit.

Two different failures hide behind one symptom, so the suite's page installs two listeners. A
capture-phase listener that cancels space runs before anything in the shadow tree and cannot be
stopped from inside it, so the character has to be reinserted afterwards; a bubble-phase listener
can be stopped, and is, because a page has no business acting on what is typed into a comment box
on top of it. The third assertion keeps the fix honest — keys pressed in the page itself must still
reach the page, since blocking everything would pass the first two and break the site.

Keys go through the WebDriver actions endpoint rather than a constructed `KeyboardEvent`: a
synthetic event has no default action, so it would insert nothing whether the fix is present or
not, and the suite would pass against both. Two of its six checks fail against the code before the
fix.

```sh
node tests/browser-keyboard.mjs
```

`browser-pagekey.mjs` covers the line naming the address a thread is filed under. A thread is keyed
to `normalizeUrl(location.href)`, not to what is in the address bar, and the two disagree more often
than it looks: anchors are dropped, tracking parameters removed, query parameters sorted. Somebody
who followed a link to `#section-3` is reading one part of an article and commenting on all of it,
and nothing said so.

The line appears only when the two differ, so the suite proves both halves — that it shows up when
it matters and stays away when it does not. A line repeating the address bar on every ordinary page
is the clutter that teaches people to stop reading the panel.

The anchor case is checked after a click rather than on load. Clicking a same-page anchor is the one
navigation that changes nothing the panel would otherwise react to — same thread, no reload — and
the early return in the navigation watcher used to skip the repaint. That single check fails against
the code before the fix; the other nine hold.

```sh
node tests/browser-pagekey.mjs
```

`browser-pictures.mjs` covers the switch that holds pictures back until they are asked for. A
picture in a comment is fetched from wherever its author chose, which hands that server the reader's
IP address — and nothing here is moderated, so a thread can carry a picture nobody should have
downloaded. Automatic loading makes both of those the reader's problem before they have seen
anything. The switch is on by default; a thread of grey boxes is a worse product, and what matters
is that the way out exists and is easy to find.

One assertion carries the suite: with the switch off, the server hosting the picture must see
nothing. "No `<img>` on screen" would not do — a hidden image, a preload, a lazily-loaded one that
fires anyway all look right and still make the request. So the picture host counts hits, and the
count is the test. Sixteen checks, including that clicking one placeholder produces exactly one
request and leaves the avatar alone.

Avatars are covered because they are the worse half: an avatar is fetched on every page where its
owner has commented, so one host collects a reading list rather than a single visit.

```sh
node tests/browser-pictures.mjs
```

`browser-share.mjs` covers sharing your own comment to your feed. A comment here is a kind 1111
scoped to a page address, which keeps comments out of the timelines of everyone who follows you —
the problem NIP-22 exists to solve — but it also means only somebody with this extension, on that
page, can ever see it. Sharing publishes a second, separate event: an ordinary note carrying the
comment and a link back.

Two clicks, and the suite checks that the first one publishes nothing: a stray click must not
broadcast to everybody following you.

The assertion that pins the design is the last: the note carries **no `r` tag**. The panel reads
kind 1 with `#r` as a legacy comment, so tagging the share with the page would make it appear a
second time inside the thread it was shared from. Adding that tag fails two of the fifteen checks —
the tag assertion, and the count of comments in the thread afterwards.

```sh
node tests/browser-share.mjs
```

`browser-xss.mjs` is written from the attacker's seat. Everything the panel draws comes from
strangers — comment text, the name on a profile, the address of an avatar — and none of it is
escaped anywhere, because none of it is ever parsed as markup: the DOM is built with `createElement`
and `textContent`, and the one template that is parsed is a static literal with no interpolation.

That holds today, and nothing made it hold. A single `innerHTML` added in passing would undo all of
it silently, which is the same shape as two defects this codebase has already shipped — signature
verification sat dead for eleven versions, and the contrast suite passed for eleven more while
measuring the wrong four elements.

The suite publishes eight payloads and a hostile profile, then checks three separate things: that
nothing executed, that the markup was never built at all (a `<script>` inserted through `innerHTML`
never runs, so counting execution alone would miss an inert parse), and that each payload is on
screen as text. Replacing one `textContent` with `innerHTML` fails four of its checks; loosening the
`https?://` requirement in the link pattern fails three others.

```sh
node tests/browser-xss.mjs
```

`nip05host.test.mjs` covers which hosts a NIP-05 identifier may send the reader's browser to. The
identifier comes from somebody else's profile, and checking it means fetching from the domain it
names. The pattern that used to guard that allowed a port, an IPv6 literal and every bare address,
so a profile could name `192.168.1.1` or `127.0.0.1` and have a reader's own browser knock on their
network. The response is unreadable across origins, but whether anything answers and how fast is not
something the author of a comment should be able to collect.

Domains only, therefore: anything that is not a plain domain name is refused rather than parsed
carefully. Twenty-nine cases, and the suite is worth its length because a plausible-looking fix
fails it — the one CodeQL's autofix proposed blocked ports and brackets but allowed every private
address and named `localhost` as explicitly permitted, which is seven failures here.

It runs as part of `node tests/run.mjs`.

`browser-relaystate.mjs` covers what the relay list says each relay is doing. Sockets fail quietly
in this codebase — `onerror` closes, `onclose` retries and gives up after six attempts — so a relay
that never answered looked exactly like one with nothing to say, and the only symptom was a thinner
thread. Three relays are used: one that works, one that is not there, and one that completes the
WebSocket handshake and then says nothing at all. That third one is the reason this is not a
connection check, and it needs a raw TLS server rather than `startRelay`, which answers every REQ
with EOSE whatever its options say — the first version of this suite "tested" a relay that was
politely replying the whole time.

```sh
node tests/browser-relaystate.mjs
```

`browser-buttoncss.mjs` serves seven pages with real stylesheets and measures where the floating
button's badges land. The button used to hang in the page's DOM, so ordinary site CSS reached it —
`span{position:static !important}` put the notification badge to the right of the count, and
`span[id]{display:none}` removed both. It now lives in the same shadow root as the panel. The
assertions are about behaviour, not location: `BADGE` in the harness looks in the shadow root *and*
the document, so the suite fails against the old arrangement for the real reasons instead of
reporting that it cannot find anything.

```sh
node tests/browser-buttoncss.mjs
```

`browser-legacy.mjs` covers kind 1 notes that carry an `r` tag for the page: that they are read
again, marked as notes rather than comments, threaded, and votable; that the reply button on one
refuses with a reason rather than doing nothing; and — from the other end — that posting still
produces a 1111 with an `I` tag and no `r` tag, so nothing quietly starts writing kind 1 again. The
badge assertion is the one that matters most: it compares the count against the rows actually drawn,
which is the promise that broke when the thread stopped reading a kind the notifications still
listened for.

```sh
node tests/browser-legacy.mjs
```

`browser-keyexposure.mjs` is written from the attacker's seat: WebDriver's execute runs in page
context, which is exactly where a hostile script on the host site sits. The panel's shadow root is
open by design — see `docs/SECURITY-AUDIT-2026-08.md` for why closing it is mostly theatre — so the
guarantee under test is not that the page cannot reach in, but that it finds nothing worth having
when it does. It sweeps every input value, attribute and text node for the private key and the
password, before and after revealing the key, across closing and reopening Settings, and after the
identity is deleted. Against the code before August 2026 it fails seven checks and prints the key.

```sh
node tests/browser-keyexposure.mjs
```

`measure-connections.mjs` is not a test and asserts nothing. It reports what one page visit costs
in sockets and bytes, counted at the relay, so a change to connection behaviour can be stated in
numbers instead of adjectives. Nothing is added to the extension for it: `startRelay` exposes an
`onTraffic` hook, because instrumenting the thing you are measuring changes what you measure.

```sh
node tests/measure-connections.mjs
```

`browser-setname.mjs` covers publishing a display name without destroying the rest of a profile.
Kind 0 is replaceable, so publishing one replaces the whole object rather than the field being set —
a name written over a profile made elsewhere destroys its picture, about, website and nip05 at once.
The panel merges, and the suite proves it: a full profile goes on the relay, the name is changed
through the panel, and every other field is checked to have survived. It also pins the two cases
where merging is impossible and publishing must not happen — a profile that is not readable JSON,
and no relay answering at all, which is indistinguishable from "this key has no profile" unless you
check. The first version refused whenever any profile existed, which made a typo permanent unless
the user exported their key to another app; that is recorded in the suite's header so it is not
reintroduced as a safety measure.

```sh
node tests/browser-setname.mjs
```

## Running against Firefox

Every suite takes `NC_BROWSER=firefox` and needs no other change:

```sh
node tests/browser-votes.mjs                    # chromium, the default
NC_BROWSER=firefox node tests/browser-votes.mjs # the same suite, the Firefox build
```

Firefox needs `geckodriver` on `PATH`, in `~/tools/`, or at `GECKODRIVER=`. Set `FIREFOX=` if the
binary is not found — note that `/usr/local/bin/firefox` is a firejail symlink on some systems and
geckodriver needs the real one, usually `/usr/lib/firefox/firefox`.

The difference from Chromium is that Firefox installs an add-on rather than loading a folder, so the
harness zips `NostrComments-FireFox/` into the throwaway workdir on every run. That is deliberate:
reusing `dist/` would let a suite quietly test a stale package.

**Why it exists.** Every suite ran against Chromium only until 9 August 2026, and all four bugs found
in real use that day were on Firefox — an identity substituted when a signer was installed, a signer
that stopped being looked for, "no key stored here" for a key that was in storage. As of that date
all nineteen suites pass under both, so those were not rendering-engine differences.

**What this still does not cover.** The suites install their own `window.nostr`. The bugs came from a
real signer extension injecting asynchronously alongside several other extensions, and a stub cannot
reproduce that timing. Firefox coverage narrows the gap; using the thing is what closed it.

`harness.mjs` holds what the relay-backed suites share: the throwaway wss:// relay, the page they
visit, the chromium started over WebDriver, and the extension's own secp256k1 lifted out of the
shipped source so that a test never signs with crypto of its own. A suite keeps what makes it that
suite — the events on the relay, the clicks, the assertions. `startRelay({ onEvent })` is how a
suite makes the relay refuse, delay or misbehave. It honours `limit` per filter, newest first, the
way a relay does — it did not at first, which is exactly why nothing caught the shared budget.

`browser-qa.mjs` and `browser-identity.mjs` predate it and still stand alone; neither needs a
relay, which is most of what the harness is for.

If a session fails to start, a stale `chromedriver` on the same port is the usual cause
(`pkill -x chromedriver`), or a working directory long enough to overflow Chrome's UNIX socket
path limit.
