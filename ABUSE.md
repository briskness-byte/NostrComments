# Abuse, takedown requests and what can be removed

NostrComments puts a comment thread on any web page. The comments are signed Nostr events stored on
public relays, not on the page and not on any server of this project. That is the point of it: the
owner of the page cannot close the thread. It also means that nobody — including the developer —
can make a comment disappear everywhere. This page says plainly who can do what, so that nobody has
to find out when it matters.

## What the developer can and cannot do

- **Cannot remove a comment.** There is no server, no database and no account system. A comment
  lives on whichever relays hold it, and the developer operates none of them.
- **Cannot ban a key.** Nostr keys are free and made locally; there is nothing to suspend.
- **Can** tell you which relays the extension uses by default, how to reach their operators, and
  what the extension does to help readers. That is what this page is.
- **Can** change what the extension shows by default, in a release that every user can read the
  source of. Anything like that is decided in public, in this repository.

## What a comment's author can do

Delete it. The extension's 🗑 Delete button publishes a deletion request (NIP-09) to the relays.
It is a request: relays that honour it drop the comment, and some will not. Copies already fetched
by other people may remain. The extension itself only accepts a deletion when it is signed by the
author of the comment it names.

## What a reader can do

All of these work on the reader's own device, for that reader only:

- **Mute a user** (🚫 Mute on any comment) — every comment from that key is hidden from then on.
- **Mute words or phrases** in Settings — any comment containing them is hidden.
- **Vote.** A comment collapses once enough people down-vote it (at least five); one click still
  shows it.
- **Repeated comments are folded.** Three or more near-identical comments from one key become one
  line, with the rest a click away.
- **Turn it off for a site**, or use quiet mode, from the button or in Settings.

None of these remove anything from the relays or from anyone else's view.

## Who can remove a comment: relay operators

Each relay decides for itself what it stores and serves. To have a comment removed from a relay,
ask that relay's operator. A relay publishes its contact details in its information document
(NIP-11): open the relay's address with `https://` instead of `wss://` and the header
`Accept: application/nostr+json`, or look it up on a relay directory such as nostr.watch.

The extension reads from and publishes to these relays by default (users can change the list):

- `wss://nos.lol`
- `wss://relay.damus.io`
- `wss://relay.primal.net`
- `wss://nostr.oxtr.dev`
- `wss://nostr.mom`
- `wss://relay.nostr.net`

What a user posts is also sent to three extra relays that are never read from, so that one relay
removing it is not the end of it (switchable in Settings):

- `wss://purplerelay.com`
- `wss://relay.nostrplebs.com`
- `wss://nostr.bitcoiner.social`

Give the operator the comment's event id (🔗 on the comment copies a `nostr:` link to it) and the
page address it was posted on.

## Illegal content

Report it to the operators of the relays that hold it (above), and to the authorities or the
reporting hotline in your country. The developer cannot remove it, but will answer questions about
how the extension works and which relays it uses, to help a report reach the people who can act.

## If you own the page

There is no opt-out for a site, by design: a thread that the page's owner could switch off would
be the comment section this project exists to replace. You can read the thread like anyone else —
with the extension, or without installing anything at
<https://briskness-byte.github.io/thread/> — and answer in it. For removing a specific comment,
see relay operators above.

## Writing to the developer

`36pfxv8wd@mozmail.com` — the same address as in [SECURITY.md](SECURITY.md). Please include the
comment's `nostr:` link and the page address. Expect an honest answer about what can and cannot be
done, usually within a week; expect no removal, because there is nothing for the developer to
remove.

This page describes how the extension works. It is not legal advice.
