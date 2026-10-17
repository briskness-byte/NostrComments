# Security audit, October 2026

A second audit, started on 17 October 2026 right after the strict-CSP key exposure fixed in 23.10.2
(below as C0). That bug was a security decision made on something the page can influence — the
key box's style — so this audit went looking for the same class everywhere: decisions read from
page-writable DOM state, controls that act on a scripted click, and third-party text spoken in the
panel's own voice. It builds on the [August audit](SECURITY-AUDIT-2026-08.md) and does not repeat
what that one found sound.

The premise throughout: the panel lives in an **open** shadow root on the page, so the page can read
everything drawn in it, change any style inside it, and call `.click()` on any of its buttons. What
it cannot do is produce a trusted event, which is what `byUser()` checks.

---

## C0. The private key was written into the panel on strict-CSP pages — fixed in 23.10.2

On a page with `style-src` without `'unsafe-inline'`, Firefox dropped the template's inline styles,
including the `display:none` on the key box. `privkeyBoxOpen()` read that style, counted the box as
open, and the stored key was written into its field on load. Fixed in 6726b6e, 8769a8f, c7808bd
(styles collected before adoption and re-applied with `setProperty`; box state a variable set only by
a real reveal). Test: `tests/browser-csp-style.mjs`. Published as a GitHub Security Advisory.

## A1. "Show my key" in the backup offer answered a scripted click — high, fixed

The "Save your key?" dialog opens by itself after a reader's first comment when the key has never
been backed up. Its confirm button called `done(true)` without `byUser()`, and confirming opens
Settings and writes the key into the field. A page on which the reader had just commented could
press it and read the key. Fixed in 0f68376.

## A2. The password button and dialog answered scripted clicks — high, fixed

`pwBtn` had no gesture check, and neither had the password dialog's buttons. With an unencrypted key
a page could open the dialog, type a password of its own into both fields and confirm: the key was
then encrypted under a password the reader never knew, locking them out of their own identity unless
they had a backup. The same dialog also opens by itself, offering to protect a new key. With an
unlocked encrypted key, a scripted click removed the password and stored the key unencrypted. Fixed
in 0f68376; Enter in the password field now requires a trusted key press.

## A3. Destructive confirmations answered a scripted "yes" — medium, fixed

Replacing, regenerating and deleting the stored key each start with a gesture-checked button, but
the confirmation that follows did not check. A page could confirm the moment the dialog appeared,
before the reader had read the warning. Fixed in 0f68376, together with the dialog's "copy the
current key first" button.

## A4. Third-party text spoken in the panel's voice — low, fixed

A Lightning provider's error text was shown verbatim. The provider is chosen by whoever is being
zapped, so a commenter could make the panel say anything ("paste your nsec here"). Relay refusal
reasons had no length limit. Both are now quoted and attributed, stripped of control and bidi
characters, and cut at 120 characters. Fixed in 0b1401c.

---

## Structural, not fixed by a patch

**S1. Anything typed into the panel is readable by the page while it is there.** A password typed
into the unlock or protect dialog, an nsec pasted into the import field, a comment draft. They are
cleared as soon as they are used, but during typing they sit in an open shadow root. This is the cost
of drawing the panel inside the page. The fix is to move key management (reveal, import, password) to
an extension page that no website can reach, or the whole panel into the browser's sidebar.

**S2. Clickjacking.** The page can style the shadow host — opacity, position, size — and lure a real
click onto a panel button it has made invisible. A lured click is a trusted one, so `byUser()` passes.
Destructive actions are two-step, which limits this, but only the sidebar removes it.

**S3. Remaining decisions read from page-writable state.** Reviewed one by one: the quiet-mode button
visibility, focus trapping, the donate section and the settings re-render on storage changes read
styles, but none of them puts a secret in the DOM or performs an action. Rendering anything that names
the reader is gated by `panelOpen()`, which also requires `_trusted`, set only by a real gesture.

## Checked and sound

- The background relay pipe accepts ports only from this extension (`sender.id`), opens `wss://` only,
  and a page cannot reach `runtime.onConnect`.
- Importing a key requires a gesture (`privkeyImportBtn`), and the field is cleared after use.
- The NIP-05 lookup uses `redirect: 'error'` and omits credentials.
- The history page (`history.html`) makes no network request and writes no HTML.
- The toolbar popup's reader link is built only for http(s) addresses.
- Signer failure messages from the NIP-07 bridge are matched against fixed prefixes and never shown,
  because a page can forge them (415a0ca).

## Still worth having

The hand-rolled secp256k1 / BIP-340 code remains the largest unreviewed surface, as in August. And S1
and S2 have one structural answer: the panel out of the page.
