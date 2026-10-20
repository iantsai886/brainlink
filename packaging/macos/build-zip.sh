#!/bin/bash
# Builds dist/BrainLink-<major.minor>-mac.zip: a self-contained Node runtime + app bundle that
# installs and runs on a CLEAN Mac (no Node, no Xcode, no dev tools). Built and zipped from
# Linux -- no pkgbuild, no codesign, no notarisation (that is packaging/macos/build-pkg.sh).
#
# Usage: build-zip.sh [app-source-dir]
#   app-source-dir defaults to the repo root (two levels up from this script).
#
# Env overrides (for testing against a different checkout/runtime cache):
#   BRAINLINK_STORE_SRC  path to the brainlink-store checkout (default: ../brainlink-store)
#   BRAINLINK_NODE_RT    path to the downloaded, SHA-checked Node tarballs (default: /workspace/brainlink-runs/node-rt)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${1:-$HERE/../..}" && pwd)"
STORE_SRC="$(cd "${BRAINLINK_STORE_SRC:-$ROOT/../brainlink-store}" && pwd)"
NODE_RT="${BRAINLINK_NODE_RT:-/workspace/brainlink-runs/node-rt}"
NODE_VERSION="22.23.3"
VERSION_FULL="$(node -p "require('$ROOT/package.json').version")"
VERSION="$(node -p "'$VERSION_FULL'.split('.').slice(0,2).join('.')")"
WORK="$ROOT/build/macos-zip"
DIST="$ROOT/dist"
STAGE="$WORK/BrainLink"

echo "BrainLink $VERSION_FULL mac zip · Node $NODE_VERSION"
rm -rf "$WORK" && mkdir -p "$STAGE/app" "$DIST"

# 1. Node runtimes: verify the official tarballs against the SHA256 sums downloaded alongside
#    them, then extract only bin/node + LICENSE for each architecture (no npm, no headers, no docs).
(cd "$NODE_RT" && grep -E "darwin-(arm64|x64)\.tar\.gz" SHASUMS256.txt | sha256sum -c --quiet)
for arch in arm64 x64; do
  mkdir -p "$STAGE/runtime/$arch/bin"
  tar -xzf "$NODE_RT/node-v$NODE_VERSION-darwin-$arch.tar.gz" -C "$WORK" \
    "node-v$NODE_VERSION-darwin-$arch/bin/node" "node-v$NODE_VERSION-darwin-$arch/LICENSE"
  mv "$WORK/node-v$NODE_VERSION-darwin-$arch/bin/node" "$STAGE/runtime/$arch/bin/node"
  mv "$WORK/node-v$NODE_VERSION-darwin-$arch/LICENSE" "$STAGE/runtime/$arch/LICENSE"
  rm -rf "$WORK/node-v$NODE_VERSION-darwin-$arch"
  chmod 755 "$STAGE/runtime/$arch/bin/node"
done

# 2. App files: only what customers need to run it (no test/, docs, vendor tools or issuer keys).
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/ui" "$ROOT/samples" "$STAGE/app/"
cp "$ROOT/package.json" "$ROOT/LICENSE.txt" "$ROOT/README.md" "$STAGE/app/"

# src/license-key.mjs ships the vendor's real public key in a production build; on this tree it
# is only a throwaway dev stand-in (generates a random key each run, so every licence is refused
# and the free/trial plan applies) and is deliberately not copied into the bundle. A minimal
# stand-in with the same shape is written here instead, so the shipped app still starts.
rm -f "$STAGE/app/src/license-key.mjs"
cat > "$STAGE/app/src/license-key.mjs" <<'JS'
// Public-key placeholder written by build-zip.sh; ships no vendor secret. Without
// BRAINLINK_LICENSE_PUBKEY_FILE pointing at the real vendor public key, every licence key is
// refused and the free/trial plan applies.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fromFile = process.env.BRAINLINK_LICENSE_PUBKEY_FILE ? readFileSync(process.env.BRAINLINK_LICENSE_PUBKEY_FILE, 'utf8') : null;
export const PUBLIC_KEY_PEM = fromFile || generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
export const IS_STAND_IN = !fromFile;
JS

# 3. Vendor brainlink-store so the bare `import ... from 'brainlink-store'` resolves with no
#    npm install and no network (test/ and python-noncanonical/ are not runtime dependencies).
mkdir -p "$STAGE/app/node_modules/brainlink-store"
cp "$STORE_SRC/memory-store.mjs" "$STORE_SRC/errors.mjs" "$STORE_SRC/interface.d.ts" \
   "$STORE_SRC/package.json" "$STORE_SRC/README.md" "$STAGE/app/node_modules/brainlink-store/"

# 4. Launchers (double-click .command files; each locates its own folder, so the zip works
#    wherever it is unzipped -- Downloads, Desktop, or after "Install BrainLink.command").
cat > "$STAGE/Start BrainLink.command" <<'SH'
#!/bin/bash
cd "$(dirname "$0")"
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "BrainLink does not support this Mac's processor ($(uname -m))."; read -n1 -r -p "Press any key to close..."; exit 1 ;;
esac
"./runtime/$ARCH/bin/node" "./app/bin/brainlink.mjs" ui
echo
read -n1 -r -p "BrainLink stopped. Press any key to close this window..."
SH

cat > "$STAGE/Install BrainLink.command" <<'SH'
#!/bin/bash
# Optional: copies this BrainLink folder to ~/Applications so it has a stable home, then you can
# delete the original download. Does not use sudo or touch anything outside your home folder.
cd "$(dirname "$0")"
DEST="$HOME/Applications/BrainLink"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$(pwd)" "$DEST"
chmod +x "$DEST/Start BrainLink.command" "$DEST/Install BrainLink.command" "$DEST/Connect AI apps.command"
echo "Installed BrainLink to: $DEST"
echo "Open that folder and double-click \"Start BrainLink.command\" any time."
read -n1 -r -p "Press any key to close this window..."
SH

cat > "$STAGE/Connect AI apps.command" <<'SH'
#!/bin/bash
cd "$(dirname "$0")"
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "BrainLink does not support this Mac's processor ($(uname -m))."; read -n1 -r -p "Press any key to close..."; exit 1 ;;
esac
"./runtime/$ARCH/bin/node" "./app/bin/brainlink.mjs" connect --all
echo
read -n1 -r -p "Press any key to close this window..."
SH

chmod 755 "$STAGE/Start BrainLink.command" "$STAGE/Install BrainLink.command" "$STAGE/Connect AI apps.command"

# 5. READ ME FIRST.txt: the exact Gatekeeper steps for an unsigned, unnotarised app.
cat > "$STAGE/READ ME FIRST.txt" <<TXT
BrainLink $VERSION_FULL for Mac -- unsigned build (no Apple Developer ID yet)

GETTING STARTED
1. Unzip this (double-click the .zip if it did not unzip itself). You should see a BrainLink
   folder with this file inside it.
2. In the BrainLink folder, right-click "Start BrainLink.command" and choose Open.
3. macOS will warn that the file is from an unidentified developer. Click Open (you only need
   to do this once; a plain double-click works after that).
4. If macOS instead says the file "cannot be opened" or is blocked:
   - Open System Settings > Privacy & Security, scroll to the Security section, and click
     "Open Anyway" next to BrainLink. Then try step 2 again.
   - Or open Terminal and run:
       xattr -dr com.apple.quarantine ~/Downloads/BrainLink
     (adjust the path if you unzipped somewhere other than Downloads), then try step 2 again.
5. A Terminal window opens and your browser opens to BrainLink. Keep the Terminal window open
   while you use BrainLink; closing it stops the app.

OPTIONAL
- "Install BrainLink.command" copies this folder to ~/Applications/BrainLink so it has a
  permanent home (no admin password needed).
- "Connect AI apps.command" wires BrainLink into Claude Desktop, Claude Code, Cursor, Codex,
  Gemini CLI and Windsurf, whichever you have installed.

No installation of Node.js or Xcode is required -- BrainLink bundles its own Node runtime.
TXT

# 6. Zip with a stable layout and unix executable bits preserved (no `zip` binary on this box;
#    python's zipfile module lets us set external_attr directly from each file's real mode).
OUT="$DIST/BrainLink-$VERSION-mac.zip"
rm -f "$OUT"
python3 - "$WORK" "BrainLink" "$OUT" <<'PY'
import os, sys, zipfile

work, name, out = sys.argv[1], sys.argv[2], sys.argv[3]
base = os.path.join(work, name)
entries = []
for root, dirs, files in os.walk(base):
    dirs.sort()
    for fn in sorted(files):
        full = os.path.join(root, fn)
        entries.append(full)

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for full in entries:
        rel = name + '/' + os.path.relpath(full, base)
        mode = os.stat(full).st_mode
        zi = zipfile.ZipInfo(rel, date_time=(2024, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = (mode & 0xFFFF) << 16
        with open(full, 'rb') as f:
            zf.writestr(zi, f.read())
PY

(cd "$DIST" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
echo "SHA256: $(cut -d' ' -f1 "$DIST/$(basename "$OUT").sha256")"
