# Privacy Policy

_Last updated: 8 August 2026_

**NostrComments does not collect, receive, or transmit any data to the developer.**
There is no NostrComments server, no account, no email, no tracking, and no
analytics of any kind. Everything happens locally in your browser or directly
between your browser and the public Nostr relays you connect to.

## What the extension does

- Adds a comment button on every webpage.
- **Only after you explicitly enable it** (a one-time in-product consent step),
  it connects to public Nostr relays to load and publish comments associated
  with the current page's URL.
- Lets you generate a Nostr key locally, or use a Nostr signing extension you
  already have installed (Alby, nos2x). Your private key is used only to sign
  events and never leaves your device.

## Data stored locally (in your browser only)

The extension stores the following in your browser's extension storage. This
data never leaves your browser except as needed to publish events you create,
and is never sent to the developer:

- Your locally generated Nostr private key — only if you choose "generate your
  key" (you are prompted to back it up yourself). You may optionally protect it
  with a password, in which case it is encrypted at rest (PBKDF2 + AES-GCM) and
  decrypted only when you enter your password to post.
- Your relay list, muted users, muted words, per-site disable list, which corner
  the button sits in on each site, theme preference, which signer you chose,
  whether verified names are checked, whether the extra publishing relays are
  used, your consent choice, a flag recording whether you confirmed that you
  saved your private key, a flag recording that you were offered key encryption,
  and a flag recording that you have sent a support zap (used only to stop
  showing you the support message).
- **A list of pages you have opened the comment panel on**, with a timestamp for
  each, so comments posted since your last visit can be marked "new". This is
  capped at the 300 most recent pages, older entries are discarded, and it stays
  in your browser's extension storage — it is never transmitted to anyone,
  including the developer. Clearing the extension's storage removes it.

## Data sent to Nostr relays (third parties)

This happens **only after you enable the extension**. Every item below is tied to
an action you take, with one exception — reply notifications keep a subscription
open on their own, and are described as such:

- **Loading comments:** the current page's URL is sent to relays as a query so
  the extension can show comments for that page.
- **Posting a comment or vote:** your comment or vote, the page URL, and your
  Nostr public key are published to relays.
- **Extra relays for what you post (on by default, and only for posting):** a
  comment sent to a single relay disappears the day that relay's operator decides
  it should — which is the one thing this extension exists not to be. So what you
  post also goes to three relays that are never read from and never queried:
  purplerelay.com, relay.nostrplebs.com and nostr.bitcoiner.social. They receive
  exactly what the relays in your own list receive — the comment, the page URL and
  your public key, all of it public by design — plus your IP address, as any
  server you contact does. They are told nothing about pages you merely read.
  Switch it off under ⚙ Settings and only the relays you listed are used.
- **Sharing your own comment (only when you press Share, and confirm):** an
  ordinary Nostr note is published carrying the text of that comment and a link to
  the page it was written on. This is the one thing here that goes into the feeds
  of people who follow you; comments themselves never do. Nothing is shared unless
  you ask for it, per comment, and the confirm step exists so a stray click cannot
  broadcast anything.
- **Your own threads (only when you open ⚙ Settings):** the extension asks your
  relays for comments written by your public key, so it can list the pages you have
  commented on. Relays cannot be asked "everything under example.com" — a tag query
  matches exactly — so the list is built from the other side. It is fetched when
  Settings opens rather than on every page you read.
- **Deleting your own comment:** a deletion request naming the comment, signed
  with your key, is published to relays. It is a *request*: relays that honour it
  drop the comment, and some will not. Copies already fetched by other people, or
  held by relays you never contacted, are beyond anyone's reach — including
  yours. The extension stops showing it either way.
- **Reply notifications:** while the extension is connected, it keeps a
  subscription open on up to three of your relays asking for events that mention
  your public key, so it can tell you when somebody replies. Unlike the items
  above this is not tied to a page you are reading: those relays see your public
  key and that you are online for as long as the subscription is open, even in a
  session where you never post anything. It starts only after you connect an
  identity, and removing your key stops it.
- **Identifying yourself to a relay (NIP-42):** some relays refuse to serve or accept anything
  until a client proves which key it is. When one of yours does, the extension signs a short
  event naming that relay and its challenge, which tells the relay your public key. This happens
  only in response to an actual refusal — never because a relay merely offered it — so relays
  that do not ask never learn who is reading. It needs a connected identity; without one the
  refusal is simply reported.
- **Verified names (off by default):** a profile can claim a `name@domain`. If you switch
  **Verified names** on in Settings, the extension asks that domain whether the name really
  belongs to that key, once per commenter. That domain then knows somebody is reading a page
  where that person commented, and sees your IP address. It is off until you turn it on, and it
  is the only request this extension makes to anywhere other than your own relays.
- **Zapping (optional):** if you choose to send a Lightning tip — to another
  commenter, or to the developer via "Support the developer" — your browser
  contacts that recipient's Lightning provider to fetch an invoice, and your own
  wallet pays it. That provider sees the request (including your IP address);
  NostrComments has no server in between and receives no data either way. If you
  are connected to Nostr, the tip is sent as a public Nostr zap, so your public
  key is visible alongside it. Supporting the developer is entirely voluntary and
  unlocks nothing — every feature is free for everyone. The on-chain bitcoin and
  monero links in that section make no network request at all: clicking one hands
  the address to whatever wallet your system has registered and copies it to your
  clipboard, both locally.

Nostr relays are open, decentralised servers **not operated by or affiliated
with NostrComments**. Anything you publish to them is public by design.

## What the extension does NOT do

- Does not send any data to the developer. There is no server to send it to.
- Does not use analytics or telemetry of any kind.
- Does not build a profile of you anywhere. The local list of the last 300 pages
  where you opened the panel exists only to mark comments as "new" — see "Data
  stored locally" above — and never leaves your device.
- Does not transmit anything before you explicitly enable it.

## What it unavoidably reveals

To show a thread for a page, the extension has to ask relays about that page. So the
relays you have configured see which pages you read, along with your IP address, and
your public key if one of them asked you to identify yourself (see NIP-42 above).

That is inherent to how a comment system attached to URLs works, rather than a choice
made on your behalf, and it is the thing worth understanding before installing.

Since v22.53 it applies only to pages you actually read. A tab you never look at, or a
page you leave within a couple of seconds, is never mentioned to anyone.

The relays are yours to choose. Remove any you do not trust in ⚙ Settings, or point the
extension at one you run yourself.

### Pictures load from wherever they are hosted

**You can switch this off.** In ⚙ Settings, *Load pictures automatically* holds every picture and
avatar behind its host name until you click it. It is on by default, because a thread of grey boxes
is a worse thing to read — but it is one checkbox, and it applies to avatars as well as to pictures
written into comments. Clicking one fetches that one and nothing else.

Note what it does not do: it does not protect the person who clicks. It is a decision point, not a
shield.

Profile pictures and images linked inside comments are fetched by your browser from
whichever server the person who posted them chose. That server sees your IP address and
your browser's user agent, in the same way it would if you opened the image yourself.

It is **not** told which page you are reading. Since v23.0.2 every one of these requests
is made with a `no-referrer` policy, so the address of the page you are on is withheld.
Before that it was sent, which meant somebody could learn where their own avatar was being
loaded — in other words, every page you opened where they had commented. Images are also
loaded only as they come into view, so a long thread does not fetch everything at once.

Nobody in that chain is chosen by you: an avatar belongs to the person who commented,
and it loads on every page where they have commented. A relay operator is not involved,
and neither is the developer.

This is how Nostr clients generally work, and hiding all pictures would make the panel
worse for everyone to close a gap that most readers do not mind. It is listed here
because you should be able to know it rather than discover it.

## Contact

For questions, open an issue at [github.com/briskness-byte/NostrComments](https://github.com/briskness-byte/NostrComments).
