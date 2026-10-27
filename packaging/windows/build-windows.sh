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
ZIP="$ROOT/vendor/node/node-v$NODE_VERSION-win-x64.zip"
WORK="$ROOT/build/windows"
STAGE="$WORK/stage"
DIST="$ROOT/dist"
command -v makensis >/dev/null || { echo "makensis not found (brew install makensis)"; exit 1; }
NODE_DIST="https://nodejs.org/dist/v$NODE_VERSION"
[ -f "$ROOT/vendor/node/SHASUMS256.txt" ] || curl -fsS "$NODE_DIST/SHASUMS256.txt" -o "$ROOT/vendor/node/SHASUMS256.txt"
[ -f "$ZIP" ] || curl -fsS "$NODE_DIST/node-v$NODE_VERSION-win-x64.zip" -o "$ZIP"
(cd "$ROOT/vendor/node" && grep " node-v$NODE_VERSION-win-x64.zip$" SHASUMS256.txt | shasum -a 256 -c --quiet)

rm -rf "$WORK" && mkdir -p "$STAGE/node" "$STAGE/app" "$STAGE/bin" "$DIST"
unzip -q -j "$ZIP" "node-v$NODE_VERSION-win-x64/node.exe" "node-v$NODE_VERSION-win-x64/LICENSE" -d "$STAGE/node"
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/ui" "$ROOT/samples" "$ROOT/skills" "$ROOT/package.json" "$ROOT/LICENSE.txt" "$ROOT/README.md" "$STAGE/app/"
rm -rf "$STAGE/app/ui/app/test"
mkdir -p "$STAGE/app/node_modules/brainlink-store"
cp "$ROOT/vendor/brainlink-store/memory-store.mjs" "$ROOT/vendor/brainlink-store/errors.mjs" "$ROOT/vendor/brainlink-store/package.json" "$STAGE/app/node_modules/brainlink-store/"
mkdir -p "$STAGE/app/node_modules/yaml"
cp -R "$ROOT/node_modules/yaml/." "$STAGE/app/node_modules/yaml/"
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
