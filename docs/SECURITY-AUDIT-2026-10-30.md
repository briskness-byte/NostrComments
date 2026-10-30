# Security audit, 30 October 2026

A third pass, covering what was added after the [October audit](SECURITY-AUDIT-2026-10.md) and the
private review that led to 23.10.8: inline quotes and the "look it up on <relay>" button, NIP-65
inbox delivery, NIP-27 mentions and the @ picker, NIP-36 content warnings, the reader's NIP-51 mute
list, hashtags, the first-run signer states, and the popup's "Turn it back on here". It does not
repeat what the earlier audits found sound.

The premise is unchanged: the panel lives in an **open** shadow root, so the page can read everything
drawn in it and call `.click()` on its buttons, but cannot produce a trusted event, which is what
`byUser()` checks. A commenter controls the content of their events; anyone can publish a relay list
or a profile.

No critical or high findings. Four low ones, all fixed in 23.10.12.

---

## N1. One comment could launch many quote lookups at once — low, fixed

Every quoted `nostr:note/nevent/naddr` drawn in the thread was added to the lookup queue with no
limit, and the queue was sent to every relay in batches of twenty, all at the same time. A single
comment with four hundred different quotes made twenty parallel lookups to each of the reader's
relays as soon as the panel opened: load on the reader's browser, and the kind of request rate that
gets a client rate-limited by its relays. Now one batch at a time, and at most 60 quotes per page;
beyond that a quote stays a short link. Test: `tests/browser-audit1030.mjs` (48 messages before, a
handful after).

## N2. Profile requests were not batched — low, fixed

`fetchProfiles()` sent its own request to every relay on each call, and it was called once per
comment as a thread streamed in and once per mentioned name. A thread of 150 different commenters,
each mentioning a different stranger, produced over 300 profile requests. With the background socket
(the default) these were requests over a shared connection; with it switched off, separate sockets.
This predates the mentions, which made it easier to trigger. Requests are now collected for 150 ms
and sent together, at most 150 authors per request, and at most 100 mentioned names per page are
looked up. Test: `tests/browser-audit1030.mjs` (353 messages before, a handful after).

## N3. The backup bar stayed on the page after the panel closed — low, fixed

The rule adopted after the 21 October review is that nothing which identifies the reader is drawn
while the panel is shut. The backup reminder that replaced the "Save your key?" dialog in 23.10.10
("Your key exists only in this browser…") appears right after a first comment with a key made here,
and it was left on screen when the panel closed. A page could read it, and with it tell that the
visitor had just posted with a local key — linking them to the newest comment. The bar is now hidden
on close and shown again on the next open while unanswered. Its button still requires a trusted click.

## N4. The mute-list count stayed on the page after the panel closed — low, fixed

Settings says how many people and words came from the reader's NIP-51 mute list. That line was not
cleared with the other Settings lists when the panel closed. It is now.

---

## Checked and sound

- **No markup from other people's text.** No `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `document.write`, `eval` or `new Function` anywhere in the shipped files. Quote cards, mention
  names, content-warning reasons and the @ picker are built with `createElement` and `textContent`;
  a content-warning reason goes through `quoteThirdParty()`.
- **Gestures.** The controls added since 23.10.8 that change what leaves the browser or reveal the
  key check for a trusted gesture: "Back up my key", "Look it up on …", "Make a key and post" (through
  the confirm dialog), "Ask my signer again", and the mute-list and inbox settings
  (`byUserSettled`).
- **Relays named by others.** A quote's relay hint, or a relay from somebody's NIP-65 list, passes
  `safeForeignRelay()`: `wss://` with a hostname only — no IP literals, no local names, no
  credentials. Hints are contacted only on a trusted click, at most two; inbox delivery uses at most
  three of the answered person's read relays, only when posting, and can be switched off.
- **Fetched events are checked.** A quoted event is accepted only if it is exactly the id (or kind,
  author and `d` tag) asked for and its signature verifies; a mute list only if it is kind 10000,
  signed by the reader's own key. Encrypted mute entries are not read.
- **Messages.** `nc-toggle` and `nc-enable` can reach a content script only from the extension's own
  pages; a web page cannot message it. The background accepts relay ports only from this extension.
- **Existing suites.** Key exposure (37), privacy gates (16), strict-CSP styles (12) and sockets (5),
  dialog gestures (16), hostile relays (10), page-driven publishing (21) and the password flow (15)
  pass unchanged.

## Known and accepted

- **The page can type into the comment box.** Being an open shadow root, the box is writable by the
  page, so a page could add text — including a `nostr:npub…` that would become a mention. The text is
  on screen before Post is pressed. The structural fix is moving the panel off the page (the sidebar
  work).
- **A reply goes to relays the answered person chose**, which see the replier's IP address. Disclosed
  in PRIVACY.md, and a setting.
