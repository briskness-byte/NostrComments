#!/bin/sh
# Build all three distributables into dist/, version-stamped.
# Reads the version from the Chrome manifest so you never pass it by hand.
#   dist/NostrComments-Chrome-vX.Y.zip     (Chrome Web Store)
#   dist/NostrComments-Firefox-vX.Y.xpi    (addons.mozilla.org)
#   dist/NostrComments-vX.Y.user.js        (Greasyfork / Tampermonkey / Greasemonkey)
set -eu
cd "$(dirname "$0")"

# Tests run BEFORE anything is built, so a failure leaves no artifacts lying around for someone
# to upload by hand. set -e aborts here, which also stops release.sh from pushing.
echo "Running tests…"
node tests/run.mjs

# The browser QA needs chromium + chromedriver and makes a real request to the developer's
# Lightning provider, so it is opt-in rather than part of every build:
#   BROWSER_QA=1 sh build.sh
# Run it before a store upload — see tests/README.md.
if [ "${BROWSER_QA:-0}" = "1" ]; then
    echo "Running browser QA…"
    node tests/browser-qa.mjs
else
    echo "Skipping browser QA (set BROWSER_QA=1 to include it)"
fi

# Store screenshots are listing assets rather than build output: most releases do not change a
# visible pixel, and regenerating needs chromium. So this is opt-in for the same reason the browser
# QA is — a flaky headless browser must never be able to block shipping a fix.
#   SHOTS=1 sh build.sh
# all.mjs exits non-zero when a scene did not reach a usable state, so set -e stops here rather
# than leaving screenshots of the wrong thing ready to upload.
#
# The kit itself is not in this repository: it is listing tooling, it needs chromium, and nobody
# installing or auditing the extension has any use for it. Both branches below check for it first,
# so a clone builds normally without it.
if [ "${SHOTS:-0}" = "1" ]; then
    if [ -d screenshot-kit ]; then
        echo "Regenerating store screenshots…"
        ( cd screenshot-kit && node all.mjs )
    else
        echo "  ! SHOTS=1 given, but screenshot-kit/ is not here — skipping"
    fi
elif [ -f screenshot-kit/out/thread.png ] && [ NostrComments-Chrome/content.js -nt screenshot-kit/out/thread.png ]; then
    # Cheap, no browser needed: just says the UI moved after the screenshots were taken. It cannot
    # tell whether anything visible changed, so it warns rather than fails.
    echo "  ! store screenshots predate the current content.js — SHOTS=1 sh build.sh regenerates them"
fi
echo

VER=$(grep '"version"' NostrComments-Chrome/manifest.json | head -1 | sed 's/[^0-9.]//g')
[ -n "$VER" ] || { echo "could not read version"; exit 1; }
echo "Building NostrComments v$VER"

rm -rf dist
mkdir -p dist

# Every file named here has to exist, and every file the extension needs has to be named here.
# A build that quietly ships without one of them is not a hypothetical: an .xpi once went out
# missing a whole feature because nobody checked what was inside it.
PACKED="content.js injected.js popup.html popup.js manifest.json icon48.png icon128.png"

# A zip stores each file's modification time in local time with no zone recorded. Next to a GitHub
# release, whose publication time is UTC, that is enough to work out where the machine that built it
# was — so every entry is stamped at one fixed UTC instant instead. -X already drops uid/gid.
#
# The same change makes the archives reproducible: build the same tag twice, on any machine, and the
# bytes match. For a project that asks people to check that the file they install is the file in the
# repository, being able to rebuild the artefact and compare hashes is the stronger version of that
# claim.
STAMP=198001010000.00

pack() { # pack <src-folder> <output-path>
    src="$1"; out="$2"
    tmp=$(mktemp -d)
    for f in $PACKED; do
        if [ -f "$src/$f" ]; then cp "$src/$f" "$tmp/"
        elif [ -f "$f" ]; then cp "$f" "$tmp/"
        else rm -rf "$tmp"; echo "missing from $src: $f"; exit 1; fi
    done
    ( cd "$tmp" && TZ=UTC touch -t "$STAMP" $PACKED && TZ=UTC zip -qrX out.zip $PACKED )
    mv "$tmp/out.zip" "$out"
    rm -rf "$tmp"
}

pack NostrComments-Chrome  "dist/NostrComments-Chrome-v$VER.zip"
pack NostrComments-FireFox "dist/NostrComments-Firefox-v$VER.xpi"
cp NostrComments-Userscript/NostrComments.js "dist/NostrComments-v$VER.user.js"

# Signed package for the Chrome Web Store, when a key is given:
#   CRX_KEY=/path/outside/this/repo/key.pem sh build.sh
#
# The key is passed in rather than named here, because it must not live in this repository and a
# path in a tracked file is an invitation to put it there.
#
# Both files are kept, because they go to different places. Once the store account is opted in to
# verified uploads it refuses a plain .zip — but the .zip is still what a GitHub release needs, since
# Chrome will not install a .crx from outside the store and "Load unpacked" wants the folder inside
# a zip. Deleting one to avoid confusion would just move the confusion to whichever destination lost
# its file.
if [ -n "${CRX_KEY:-}" ]; then
    [ -f "$CRX_KEY" ] || { echo "CRX_KEY is set but is not a file: $CRX_KEY"; exit 1; }
    CHROME=${CHROMIUM:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}
    [ -n "$CHROME" ] || { echo "no chromium/chrome found to sign with — set CHROMIUM=/path/to/binary"; exit 1; }
    echo "Signing the Chrome package with $CRX_KEY"
    tmp=$(mktemp -d)
    mkdir -p "$tmp/home"
    cp -r NostrComments-Chrome "$tmp/pkg"
    cp icon48.png icon128.png "$tmp/pkg/"
    for f in $PACKED; do
        [ -f "$tmp/pkg/$f" ] || { rm -rf "$tmp"; echo "missing from the signed package: $f"; exit 1; }
    done
    # Chrome derives its crashpad directory from HOME; give it a scratch one so a locked-down HOME
    # cannot make this fail in a way that looks like a missing browser.
    HOME="$tmp/home" "$CHROME" --pack-extension="$tmp/pkg" --pack-extension-key="$CRX_KEY" >/dev/null 2>&1 || true
    if [ ! -f "$tmp/pkg.crx" ]; then
        rm -rf "$tmp"
        echo "signing produced no .crx — refusing to leave an unsigned package the store will reject"
        exit 1
    fi
    mv "$tmp/pkg.crx" "dist/NostrComments-Chrome-v$VER.crx"
    rm -rf "$tmp"
fi

echo "Done:"
ls -1 dist/
if [ -n "${CRX_KEY:-}" ]; then
    echo
    echo "  .crx  -> Chrome Web Store (signed; the store refuses a .zip once you are opted in)"
    echo "  .zip  -> GitHub release, for installing without the store via Load unpacked"
fi
