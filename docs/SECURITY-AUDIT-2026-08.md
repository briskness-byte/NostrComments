# Security audit, August 2026

A read of the shipped code with one question in front of it: what can a hostile page do to somebody
who has this extension installed? The extension runs on `<all_urls>`, so every page it touches is
potentially that page, and a content script shares the document with whatever the site loads.

Findings are listed with what was done about them. Where nothing was done, the reason is here too —
an accepted risk that is written down is worth more than one that was quietly dropped.

---

## H1. The private key was readable from the page — fixed

**What.** The panel lives in a shadow root attached to `<html>` with `{mode:'open'}`, so any script
on the page can reach it:

```js
const host = [...document.documentElement.children].find(e => e.shadowRoot);
host.shadowRoot.getElementById('privkey-display').value;   // the key, in hex
```

The field was filled the moment Settings was opened — not when the key was shown — and never
emptied again. Opening Settings once left the private key in a page-readable field for the rest of
the page's life. Three further copies of the same mistake:

- the password typed to encrypt the key was blanked when its overlay *opened* rather than when it
  closed, so it survived from one use until the next time the overlay happened to appear;
- a pasted `nsec` stayed in the import field when the replace-identity dialog was cancelled;
- **deleting the identity did not remove the key from the panel** — the field kept it, and pressing
  "Show private key" handed back the identity the user had just destroyed.

This was demonstrated, not deduced. A script with no extension privileges read the key and matched
it against the real one.

**Fixed.** The key now lives in a variable in the content script's own world. The input is filled
only while the user is looking at it and emptied on hide, on closing Settings, and on delete. The
password fields are cleared when their overlays close. Everything that needed the key — copy,
rotate, delete, the confirmation dialogs — reads the variable instead of the DOM.

**Not fixed: the shadow root is still open.** Closing it looks like the obvious hardening and is
mostly theatre. A page script running before the content script can hook `Element.prototype.attachShadow`
and keep the root, and inline scripts in `<head>` do run first, so against a deliberately hostile
page — the actual threat model — `{mode:'closed'}` buys very little. It would also cut off every
browser test suite, which reaches the panel exactly the way an attacker would; the alternative is a
test-only escape hatch, which means shipping something different from what is tested. The rule
adopted instead is the one that holds either way: **nothing secret goes in the DOM.**

**Followed up in v23.0.4.** That rule was written about the private key, so the public one was left
where it was — and it should not have been. The status line, the npub, the hex and the profile name
were written on every page load, whether or not the panel had ever been opened. Being public is not
the same as being linkable: a site reading `npub1…` learns which pseudonym is reading it, on every
page, without the reader posting a word — and unlike the relays, that party was neither chosen nor
disclosed. Those strings are now written only while the panel is on screen and cleared when it
closes. `browser-keyexposure.mjs` covers it; four of its checks fail against the code before.

**And again in v23.0.5, for the four lists in Settings.** They are built when Settings opens and
were never taken down, so opening it once left them readable for the rest of that page. The
disabled-site list is the sharpest: a list of *other* sites the reader visits, sitting in the DOM of
one of them. Muted words can be a name, an illness or a politician; muted keys are a blocklist; and
a relay list is only dull while it is the default one. All four are emptied when Settings closes and
when the panel closes, and rebuilt on the way back in.

`tests/browser-keyexposure.mjs` is written from the attacker's seat and sweeps every input value,
attribute and text node in the shadow root for the key and the password. Against the code before
this fix it fails seven checks and prints the private key.

## M1. The zap callback URL was taken from the recipient's server unchecked — fixed

**What.** `content.js`, the zap path:

```js
await fetch(`${lnurlData.callback}?amount=${amount}${nostrParam}`);
```

`lud16` is validated as an address before the well-known lookup, and the lookup is https. But
`callback` comes back inside that server's JSON and was used as given. A recipient who controls
their own lud16 domain — everyone, that is the point of lud16 — controls that string.

Two things came of it. The security one: a provider could name an `http://` endpoint, and an invoice
fetched over plaintext can be swapped in transit for one that pays somebody else. The other was not
a security problem at all but a plain bug — a callback that already carries a query, which plenty
do, turned `?amount=` into a malformed URL, so the zap failed for reasons nothing in the panel could
explain.

**Fixed.** The callback is parsed with `URL`, required to be `https:`, and the query is built with
`searchParams.set` rather than string concatenation. Anything unparseable, relative, or
non-https is refused before a request goes out. `tests/zap.test.mjs` covers the http refusal, a
callback with its own query, a callback carrying its own `amount`, and the junk cases; ten of those
checks fail against the code before the fix.

**Deliberately not done: requiring the callback host to match the lud16 domain.** lnurl lets a
provider name any payment endpoint and some legitimately use a different host, so enforcing it would
cost real payments. What it would buy is small: the payee learns the reader's IP either way, from
the well-known lookup a moment earlier. The residual is that a payee can point one credential-free
GET at a host of their choosing.

Because this is the money path and a wrong check here silently breaks donations, the real endpoint
was verified rather than assumed: `slurpnc@coinos.io` returns
`https://coinos.io/api/lnurl/…` with no query of its own, and `browser-qa.mjs` — which requests a
genuine invoice — still gets one. That suite's assertion was tightened while doing so: it accepted
*any* message on the feedback line, so a payment path that failed outright would have passed it.

## L1. Avatars and inline images disclose the reader's IP — documented

Profile pictures load from whatever URL a profile event names, and images linked in comments render
inline. Both are requests from the reader's browser to a third-party host chosen by somebody else,
which hands that host the reader's IP address and user agent — for an avatar, on every page where
that person has commented.

This is how every Nostr client behaves and turning it off would make the panel visibly worse, so the
behaviour stands. What was wrong was that `PRIVACY.md` did not say so while its "What it unavoidably
reveals" section existed for exactly this kind of thing. It now does.

A setting to suppress pictures entirely is a reasonable thing to want and is left as a product
decision rather than an audit item — it is a preference, not a defect.

## L2. The floating button lived in the page's DOM — fixed (found in use, after the audit)

Not turned up by reading the code, but in use: the button looked different on different sites, which
raised the question whether the two badges were being drawn on top of each other. They were not —
but finding out why they differed turned up something the audit had walked straight past.

The panel is isolated in a shadow root. The button and its two badges were appended to
`document.documentElement`, so the host page's stylesheet applied to them like any other element.
Measured, with ordinary site CSS rather than anything adversarial:

| page rule | effect |
|---|---|
| `span{position:static !important}` | both badges folded into the middle of the button, notification badge to the **right** of the count, icon squeezed to 4px wide |
| `span[id]{display:none !important}` | both badges gone; the comment count silently disappears |
| `*{margin:0;padding:0}` | badges shrank and the count shifted |
| `svg{width:100%}` | the speech-bubble icon grew from 36px to the full 68px |
| `button svg{width:1em;font-size:40px}` | icon at 40px |
| `svg{display:none !important}` | icon gone; a blank blue circle |

The icon rules are the ordinary ones — `svg{width:100%}` appears in any number of responsive
stylesheets — and they are how this was noticed: the white speech bubble looked bigger on some sites
than others. The `width="36"` on the element is a presentation attribute, and CSS beats those.

A site can therefore hide the unread-reply count, or move it somewhere it reads as something else.
That is a display-integrity problem rather than a data one — nothing leaks — but "the panel states
something that is not so" is the failure this project keeps producing, and a page being able to
cause it deliberately is worse than causing it by accident.

**Fixed** by moving the button and badges into the same shadow root as the panel, where page
selectors cannot reach. `tests/browser-buttoncss.mjs` serves seven pages with real stylesheets and
measures the geometry; it fails seven checks against the previous arrangement, for the reasons in
the table rather than merely because the elements moved.

Residual, unfixed and probably not worth fixing: the shadow **host** is still an ordinary `div` in
the page, so a rule like `div{transform:none !important}` could still create a containing block and
move the fixed-position button. Far less likely than a `span` rule, and the same reasoning as the
open shadow root above — this raises the bar rather than closing the door.

---

# Focused review of the delta, v22.53 → v22.57

Not a second full audit. The August review read the whole codebase and most of it has not moved;
the value is where the code is new, and the newest code is also the part that signs events with the
user's key. Scope: the NIP-10 reply path, the kind 1 read path, and whether moving the floating
button into a shadow root left anything behind.

## D1. The re-enable button could be hidden by the site — fixed

The August fix moved the floating button into a shadow root. It missed the *other* button.

When the extension is switched off for a site, a small 💬 appears instead, and clicking it turns
it back on. It was appended to `document.documentElement` with inline styles, so
`button{display:none !important}` on the page removed it — measured, not argued.

That is worse than it sounds, because it is the only way back. While the extension is disabled
there is no panel, and the per-site list is only reachable from the panel on the site it applies
to. **A page could make itself permanently un-re-enable-able**, and the user would have no
indication of why.

Fixed the same way as the main button. `tests/browser-buttoncss.mjs` now ends by disabling the
extension and checking the control survives four stylesheets including one that hides every
`button`; two of those checks fail against the previous commit.

## D2. Anything thrown while composing a post left the panel dead — fixed

`send.onclick` set `send.disabled = true`, then built the event's tags, then entered the `try`
whose `finally` re-enables the button. An exception in between skipped the `finally`: the Post
button stayed disabled for the rest of the page, with no message and nothing in the panel to
explain it.

Not reachable today — the malformed events that could throw are rejected before they reach
`comments` (see D3) — so this is a latent trap rather than a live bug. It is the kind that only
becomes real once, when somebody adds a line in the wrong place. Tag building now lives in
`buildEvent()`, called inside the `try`, so there is nothing between disabling the button and the
block that re-enables it.

## D3. Malformed events from a relay — checked, holds

A signature covers the serialisation, not the shape: a relay can serve an event whose `tags` is a
string, or a list of strings, or a list of objects, with a correctly computed id and a valid
signature. The new reply path copies values out of exactly such events into one signed with the
user's key, so this was tested rather than reasoned about.

Served: `tags` as a string, tags as a flat list, tags as objects, an `e` tag whose root is not hex,
and a note with sixty `p` tags. Result: the malformed ones never reach the thread, the non-hex root
falls back correctly to a single `root` marker, the thread keeps rendering, and Post never sticks.
The hex validation on ids and pubkeys is what carries this — it was already there, and it is what
turns a class of parsing bugs into a filtered-out event.

Fixing this required fixing the harness first: `matches()` did `(ev.tags || []).some(...)` and
threw on anything that was not an array, so the test relay died before the extension could be
tested. A harness that cannot represent a misbehaving relay cannot test behaviour against one.

## D4. Replying can be used to notify strangers — disclosed

NIP-10 says a reply carries all of the parent's `p` tags plus its author, so that everyone in a
thread is notified. That is what other clients do and what this now does, capped at 20.

The consequence is worth stating plainly: **somebody can arrange to be notified by you.** A note
placed on a page you are likely to read, carrying twenty `p` tags, produces — if you reply — twenty
notifications that came from your key and appear to be your doing. The content is your own words,
nothing is forged, and the cap bounds the blast radius. But the property is invisible at the moment
you press Post.

**Resolved by disclosure, not by changing the behaviour.** The reply strip already existed and
already carried a line for notes, so saying how many people a reply reaches cost one clause rather
than any new UI — which is what made the choice easy once it was priced properly. It reads, before
the box has been typed in:

> This one goes out as an ordinary Nostr note, so your followers can see it too. 4 people will be
> notified: its author and everyone tagged in it.

The count comes from the same function that builds the tags, so the number shown cannot drift from
the number published. When the cap bites it says so rather than reporting the smaller figure as the
whole story: *"the note tags 41, and this stops at 20."*

The alternative — carrying only `p` tags whose authors are visible in the loaded thread — is better
than it first sounded, and it would remove the crafted-tags case entirely. It was not taken because
it is a silent deviation: behaviour would change in a way nobody could observe, and a genuinely deep
thread would quietly stop notifying people who belong in it. Disclosure is also the prerequisite for
choosing it later. If that line routinely reads *"23 people will be notified"* on what is plainly a
link dump, that is the evidence the narrower rule would be built on — and without the line, nobody
would ever see it happening.

The real severity, stated plainly: this is not about volume. An attacker can notify those twenty
people directly. What routing it through a reply buys is that the notification arrives under
someone else's key. Attribution, not amplification.

## Also checked, nothing found

- **Kind 1 content goes through the same signature verification as kind 1111** — `queueVerify` is
  on the shared path, not the 1111 branch.
- **Notes render through the same `renderMarkdown`** as comments, which only ever produces
  `https?:` links; a note is not a new injection surface, only a wider source of text.
- **Deleting your own kind 1 works** — the NIP-09 request already used `String(ev.kind)`.
- **Nothing else of the extension's own UI is left in the page.** After D1 the only things appended
  to the document are two shadow hosts and the NIP-07 bridge `<script>`, which is removed
  immediately after it loads.

---

## K3 — a private key pasted in the wrong box was published

Reported on 11 August 2026 as a layout worry: the nsec import field sat directly above the
muted-words field, two text boxes that look alike, and somebody could put a key in the wrong one.
Following that turned up the larger fact — **no field in the panel knew what a private key was**,
and two of them publish.

| box | what happened |
|---|---|
| **comment** | the key went to public relays, signed by that very key. Permanent, irreversible. |
| **name** | the key went into the kind 0 profile. Also public, also permanent. |
| muted words | stored in plain text, outside every path that handles keys — so `Delete keypair` did not remove it and the at-rest password did not cover it |

The comment box is the serious one: it is open on every page, it is the field people paste into
without looking, and there was nothing between a paste and a publish.

The guard cannot simply refuse anything key-shaped. `nsec1…` is unambiguous — there is no reason to
publish one — so that is refused wherever it appears, including buried in a sentence, and including
somebody else's. Bare 64-character hex is a different matter: an event id and a pubkey have exactly
that shape and quoting them is ordinary, so hex is refused only when it matches the key this browser
is actually holding. A key encrypted at rest cannot be compared against, so there the `nsec1` form is
the only one caught.

The layout was fixed too, since that was the original report: `import-section` now sits directly
after the private-key block and before the signing choice, which both groups it with what it belongs
to and puts a section between it and the word filter. It stays a separate block because the
private-key block is hidden when no key exists, and importing has to work then.

`tests/browser-keypaste.mjs` covers all three boxes, the mid-sentence case, and — the assertion that
stops the fix being worse than the bug — that ordinary comments, a quoted 64-character pubkey, an
npub and the word "nsec" all still post. Ten of its assertions were verified to fail against the
previous commit, where the key was published as a comment, published as a name, and stored as a
muted word.

---

## K2 — a signer that switched account could have its profile overwritten

Found 10 August 2026 by writing the test before trusting the reasoning. The name feature had only
ever been exercised with a key stored in the extension; this is what it did through NIP-07.

`signAsMe` adopts whatever key actually signed. A NIP-07 signer can change account at any time and
never says so, the pubkey in the signature is the only thing that can be proved, so the panel
corrects itself and carries on. For a comment that is exactly right — the words belong to whoever
signed them.

For kind 0 it is the reverse. The name path reads the profile of the account the panel believes in,
merges the new name into it, and hands that to the signer. When the signer answered as a different
account, the event that came back carried one account's picture, about, banner, nip05 and lud16 —
signed by another. Kind 0 is replaceable, so publishing it did not add a stray event: **it replaced
the second account's entire profile with the first one's**, and the panel reported "Name published".

The window is not narrow. The profile lookup waits up to six seconds, and the signer's own approval
prompt stays open for as long as the user takes to click it.

Fixed by recording which account the profile was read from and refusing to publish when the
signature comes back from another one. `tests/browser-setname-signer.mjs` installs a signer that
reports A and signs as B, using a real B signature over the runtime content — a forged one would be
caught by the panel's own verification and would prove nothing about this path. It was written
first and run against the unfixed code, where it reproduced the overwrite exactly. The same run then
signs honestly as A and requires the publish to succeed, since a guard that refused everything would
pass the rest.

---

## K1 — one click could destroy a stored key, with no confirmation

Found on 10 August 2026 while testing something else, not by review. Severity is key loss, which for
this extension is the worst outcome there is: an identity is the key, and there is no reset.

The onboarding block carries **"Start commenting — generate your key"**, which wrote a fresh private
key straight to `chrome.storage.local` with no check and no dialog. That was safe only under an
assumption about who could ever see it. Every other path that replaces a key — Rotate, Import —
stops, names the npub being replaced, warns when there is no confirmed backup, and offers to copy the
current key first. This one did none of that, because it is "only shown when there is no key".

The assumption did not hold. Whether the block was on screen was set by hand at each path that
changed an identity, and **importing a key from settings never set it**, so the block stayed up
behind the settings pane — offering to generate a key over the one just imported. Deleting a keypair
had the mirror image of the same bug: the block did not come back. Both were found by the same test.

Two fixes, because either alone leaves a trap:

1. **`paintOnboard()` derives visibility from state** and is called from `paintIdentity()`, which
   every path that changes an identity already calls. The visibility is no longer something a new
   code path can forget.
2. **The button re-reads storage and refuses** if a key is there, saying so and pointing at Rotate.
   It is deliberately not trusting the in-memory state, because the danger *is* a panel that
   disagrees with what is stored.

`tests/browser-onboarding.mjs` covers both, plus the case that a guard which always refused would
also pass: after deleting the key, the block returns on its own and the button generates again. All
six of the assertions that matter were verified to fail against the previous commit — the identity
came back as a different npub, which is the loss itself.

---

## What was checked and found sound

Recorded so a later reader knows these were looked at rather than skipped.

- **No `eval`, no `innerHTML`, no `document.write`, no `Function()`** anywhere in the three builds.
  Everything user-controlled reaches the DOM through `textContent`.
- **`renderMarkdown` does not create a link it was not given one for.** Link and image URLs must
  match `https?:\/\/`; nothing else becomes an `href` or `src`, so no `javascript:` payload.
- **Every event is signature-checked before it is displayed.** Verification was dead code until
  v22.25; a relay can no longer put words in somebody else's mouth.
- **Deletions are checked for authorship.** A kind 5 only removes events by the same pubkey.
- **Identity comes from the signature, not from `getPublicKey()`.** A NIP-07 bridge cannot be
  authenticated — any script in the page can define `window.nostr` and claim any key — so what the
  signer says its public key is decides nothing. The key that a returned signature verifies against
  is the one used. `tests/browser-signer.mjs` installs a signer that claims one key and signs with
  another.
- **`lud16` is validated** before the well-known lookup (the unchecked part is `callback`, M1 above).
- **The key is encrypted at rest** with PBKDF2 + AES-GCM when the user accepts the offer.
- **Nothing blocks the host page** — the last `prompt()` calls were replaced by the in-panel dialog.

## Still worth having

An external review of the hand-rolled secp256k1/BIP-340 implementation. Nothing above touches it —
this audit read the code around the crypto, not the field arithmetic inside it. That remains the
largest unreviewed surface in the project.
