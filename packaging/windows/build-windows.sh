#!/bin/bash
# Builds the Windows installer on macOS or Linux with NSIS (brew install makensis):
#   dist/BrainLink-Setup-<version>.exe   per-user installer (no admin)
#   dist/BrainLink-<version>-windows-x64.zip   portable copy
# Optional Authenticode signing: WINDOWS_SIGN_CMD='osslsigncode sign -pkcs12 cert.pfx -pass ... -t http://timestamp.digicert.com -in %1 -out %1.signed && mv %1.signed %1'
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NODE_VERSION="$(cat "$ROOT/vendor/node/VERSION")"
ZIP="$ROOT/vendor/node/node-$NODE_VERSION-win-x64.zip"
WORK="$ROOT/build/windows"
STAGE="$WORK/stage"
DIST="$ROOT/dist"
command -v makensis >/dev/null || { echo "makensis not found (brew install makensis)"; exit 1; }
[ -f "$ZIP" ] || curl -sfo "$ZIP" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-win-x64.zip"
(cd "$ROOT/vendor/node" && grep " node-$NODE_VERSION-win-x64.zip$" SHASUMS256.txt | shasum -a 256 -c --quiet)

rm -rf "$WORK" && mkdir -p "$STAGE/node" "$STAGE/app" "$STAGE/bin" "$DIST"
unzip -q -j "$ZIP" "node-$NODE_VERSION-win-x64/node.exe" "node-$NODE_VERSION-win-x64/LICENSE" -d "$STAGE/node"
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/ui" "$ROOT/samples" "$ROOT/package.json" "$ROOT/LICENSE.txt" "$ROOT/README.md" "$STAGE/app/"
cp "$HERE/brainlink.cmd" "$STAGE/bin/brainlink.cmd"
cp "$HERE/BrainLink.vbs" "$HERE/BrainLink.ico" "$STAGE/"
# Windows line endings for the scripts Windows runs directly.
for f in "$STAGE/bin/brainlink.cmd" "$STAGE/BrainLink.vbs"; do perl -pi -e 's/\r?\n/\r\n/' "$f"; done

OUT="$DIST/BrainLink-Setup-$VERSION.exe"
ARGS=(-V2 "-DVERSION=$VERSION" "-DSTAGE=$STAGE" "-DOUTFILE=$OUT")
[ -n "${WINDOWS_SIGN_CMD:-}" ] && ARGS+=("-DSIGN=$WINDOWS_SIGN_CMD")
# makensis crashes (std::bad_alloc) when the locale is not UTF-8.
(cd "$HERE" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 makensis "${ARGS[@]}" BrainLink.nsi)
(cd "$WORK" && rm -f "$DIST/BrainLink-$VERSION-windows-x64.zip" && cp -R stage BrainLink && zip -qr "$DIST/BrainLink-$VERSION-windows-x64.zip" BrainLink && rm -rf BrainLink)
(cd "$DIST" && shasum -a 256 "BrainLink-Setup-$VERSION.exe" > "BrainLink-Setup-$VERSION.exe.sha256" && shasum -a 256 "BrainLink-$VERSION-windows-x64.zip" > "BrainLink-$VERSION-windows-x64.zip.sha256")
echo "Built $OUT ($(du -h "$OUT" | cut -f1)) and the portable zip."
[ -z "${WINDOWS_SIGN_CMD:-}" ] && echo "Unsigned: Windows SmartScreen will warn on first run until it is Authenticode-signed."
exit 0
