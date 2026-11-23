#!/bin/bash
# Builds dist/BrainLink-<version>.pkg: BrainLink.app (universal pinned Node runtime + app) and the
# `brainlink` command. Signs and notarises when certificates are configured:
#   DEVELOPER_ID_APP="Developer ID Application: Name (TEAMID)"
#   DEVELOPER_ID_INSTALLER="Developer ID Installer: Name (TEAMID)"
#   NOTARY_PROFILE=<profile saved with: xcrun notarytool store-credentials>
# Without them it builds an ad-hoc signed test installer (right-click → Open to install).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
BUNDLE_ID="${BUNDLE_ID:-com.iango.brainlink}"
NODE_VERSION="22.23.3"
NODE_DIST="https://nodejs.org/dist/v$NODE_VERSION"
NODE_RT="${BRAINLINK_MAC_NODE_RT:-$ROOT/vendor/node-macos}"
WORK="$ROOT/build/macos"
DIST="$ROOT/dist"
APP="$WORK/root/Applications/BrainLink.app"

echo "BrainLink $VERSION · Node $NODE_VERSION · $BUNDLE_ID"
rm -rf "$WORK" && mkdir -p "$WORK/node" "$APP/Contents/MacOS" "$APP/Contents/Resources/bin" "$APP/Contents/Resources/node/bin" "$DIST" "$NODE_RT"

# 1. Universal Node runtime from the checksum-verified official tarballs.
[ -f "$NODE_RT/SHASUMS256.txt" ] || curl -fsS "$NODE_DIST/SHASUMS256.txt" -o "$NODE_RT/SHASUMS256.txt"
for arch in arm64 x64; do
  archive="$NODE_RT/node-v$NODE_VERSION-darwin-$arch.tar.gz"
  [ -f "$archive" ] || curl -fsS "$NODE_DIST/$(basename "$archive")" -o "$archive"
done
(cd "$NODE_RT" && grep -E "node-v$NODE_VERSION-darwin-(arm64|x64)\.tar\.gz$" SHASUMS256.txt | shasum -a 256 -c --quiet)
for arch in arm64 x64; do
  mkdir -p "$WORK/node/$arch"
  tar -xzf "$NODE_RT/node-v$NODE_VERSION-darwin-$arch.tar.gz" -C "$WORK/node/$arch" --strip-components=1 "node-v$NODE_VERSION-darwin-$arch/bin/node" "node-v$NODE_VERSION-darwin-$arch/LICENSE"
done
lipo -create "$WORK/node/arm64/bin/node" "$WORK/node/x64/bin/node" -output "$APP/Contents/Resources/node/bin/node"
cp "$WORK/node/arm64/LICENSE" "$APP/Contents/Resources/node/LICENSE"

# 2. App files (only what customers need: no tests, tools, vendor or issuer keys).
mkdir -p "$APP/Contents/Resources/app"
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/ui" "$ROOT/samples" "$ROOT/skills" "$ROOT/package.json" "$ROOT/LICENSE.txt" "$ROOT/README.md" "$APP/Contents/Resources/app/"
rm -rf "$APP/Contents/Resources/app/ui/app/test"
mkdir -p "$APP/Contents/Resources/app/node_modules/brainlink-store"
cp "$ROOT/vendor/brainlink-store/memory-store.mjs" "$ROOT/vendor/brainlink-store/errors.mjs" "$ROOT/vendor/brainlink-store/package.json" "$APP/Contents/Resources/app/node_modules/brainlink-store/"
node "$ROOT/scripts/stage-runtime-dependencies.mjs" "$APP/Contents/Resources/app/node_modules"
npm --prefix "$ROOT" run stage:canvas-platforms -- "$APP/Contents/Resources/app/node_modules" darwin-x64 darwin-arm64
mkdir -p "$APP/Contents/Resources/app/src/ingestion"
cp "$ROOT/src/ingestion/image-ocr.mjs" "$APP/Contents/Resources/app/src/ingestion/image-ocr.mjs"
node "$ROOT/scripts/stage-ocr-data.mjs" "$APP/Contents/Resources/app/src/ingestion/tessdata"
cp "$HERE/icon/BrainLink.icns" "$APP/Contents/Resources/BrainLink.icns"

cat > "$APP/Contents/Resources/bin/brainlink" <<'SH'
#!/bin/bash
# BrainLink command: runs the bundled Node runtime, so no system Node is needed.
SELF="$0"; while [ -L "$SELF" ]; do T="$(readlink "$SELF")"; case "$T" in /*) SELF="$T";; *) SELF="$(dirname "$SELF")/$T";; esac; done
RES="$(cd "$(dirname "$SELF")/.." && pwd)"
exec "$RES/node/bin/node" "$RES/app/bin/brainlink.mjs" "$@"
SH
chmod +x "$APP/Contents/Resources/bin/brainlink"
cp "$HERE/scripts/install-cli-link" "$APP/Contents/Resources/bin/install-cli-link"
chmod 755 "$APP/Contents/Resources/bin/install-cli-link"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>BrainLink</string>
  <key>CFBundleDisplayName</key><string>BrainLink</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>BrainLink</string>
  <key>CFBundleIconFile</key><string>BrainLink</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHumanReadableCopyright</key><string>© $(date +%Y) Iango. All rights reserved.</string>
</dict>
</plist>
PLIST

# 2b. A native AppKit + WebKit host keeps one responsive BrainLink window in the Dock.
SDK="$(xcrun --sdk macosx --show-sdk-path)"
swiftc -O -parse-as-library -target arm64-apple-macos11.0 -sdk "$SDK" -framework AppKit -framework WebKit -framework Foundation "$HERE/BrainLinkApp.swift" -o "$WORK/BrainLink-arm64"
swiftc -O -parse-as-library -target x86_64-apple-macos11.0 -sdk "$SDK" -framework AppKit -framework WebKit -framework Foundation "$HERE/BrainLinkApp.swift" -o "$WORK/BrainLink-x86_64"
lipo -create "$WORK/BrainLink-arm64" "$WORK/BrainLink-x86_64" -output "$APP/Contents/MacOS/BrainLink"
chmod 755 "$APP/Contents/MacOS/BrainLink"

# 3. Code signing (hardened runtime for notarisation; ad-hoc otherwise).
if [ -n "${DEVELOPER_ID_APP:-}" ]; then
  codesign --force --options runtime --timestamp --entitlements "$HERE/entitlements.plist" -s "$DEVELOPER_ID_APP" "$APP/Contents/Resources/node/bin/node"
  codesign --force --options runtime --timestamp -s "$DEVELOPER_ID_APP" "$APP"
else
  codesign --force -s - "$APP/Contents/Resources/node/bin/node"
  codesign --force -s - "$APP"
fi
codesign --verify --strict "$APP"

# 4. Installer: component package (not relocatable) wrapped in a product archive.
pkgbuild --analyze --root "$WORK/root" "$WORK/component.plist" >/dev/null
/usr/libexec/PlistBuddy -c "Set :0:BundleIsRelocatable false" "$WORK/component.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :0:BundleIsRelocatable bool false" "$WORK/component.plist"
pkgbuild --root "$WORK/root" --component-plist "$WORK/component.plist" --scripts "$HERE/scripts" --identifier "$BUNDLE_ID.pkg" --version "$VERSION" --install-location / "$WORK/BrainLink-component.pkg" >/dev/null
cp "$ROOT/LICENSE.txt" "$HERE/resources/license.txt"
cat > "$WORK/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>BrainLink $VERSION</title>
  <welcome file="welcome.html"/>
  <license file="license.txt"/>
  <conclusion file="conclusion.html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_localSystem="true"/>
  <os-version min="11.0"/>
  <choices-outline><line choice="default"><line choice="$BUNDLE_ID"/></line></choices-outline>
  <choice id="default"/>
  <choice id="$BUNDLE_ID" visible="false"><pkg-ref id="$BUNDLE_ID.pkg"/></choice>
  <pkg-ref id="$BUNDLE_ID.pkg" version="$VERSION" onConclusion="none">BrainLink-component.pkg</pkg-ref>
</installer-gui-script>
XML
OUT="$DIST/BrainLink-$VERSION.pkg"
SIGN_ARGS=()
[ -n "${DEVELOPER_ID_INSTALLER:-}" ] && SIGN_ARGS=(--sign "$DEVELOPER_ID_INSTALLER" --timestamp)
productbuild --distribution "$WORK/distribution.xml" --resources "$HERE/resources" --package-path "$WORK" ${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"} "$OUT" >/dev/null

# 5. Notarise + staple when configured.
if [ -n "${NOTARY_PROFILE:-}" ] && [ -n "${DEVELOPER_ID_INSTALLER:-}" ]; then
  xcrun notarytool submit "$OUT" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$OUT"
fi
(cd "$DIST" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
[ -z "${DEVELOPER_ID_INSTALLER:-}" ] && echo "Unsigned test build: right-click → Open in Finder to install (Gatekeeper blocks a double-click)."
exit 0
