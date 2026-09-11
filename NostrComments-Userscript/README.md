# NostrComments userscript — frozen at 23.2.0

`NostrComments.js` is the last userscript release, byte-identical to tag `v23.2.0` and to the copy
on Greasyfork. It still works, but it is no longer updated: no new features and no fixes, security
fixes included. The browser extensions are where NostrComments continues:

- Firefox: https://addons.mozilla.org/firefox/addon/nostrcomments/
- Chrome, Brave, Edge: https://chromewebstore.google.com/detail/nostrcomments/ebmgdpicceaencegknannfaljhbfgido

## Why

Since 23.2.0 the extensions open their relay connections from a background script. That is the only
place a site's Content-Security-Policy does not reach, and on sites with a strict `connect-src` —
x.com among them — Firefox refuses relay connections made from inside the page. A userscript lives
inside the page and has no background to move them to, so on those sites it cannot load comments.
Keeping it in step would mean a third copy of every change for the one build that cannot get the
change that mattered most.

## Moving to the extension with the same identity

1. In the userscript panel, open ⚙ Settings and press **Copy nsec**.
2. Install the extension, open its panel, and paste the key into the import box in ⚙ Settings.
3. Remove the userscript from your script manager.

Comments are stored on relays, not in the script, so everything you posted stays visible.
