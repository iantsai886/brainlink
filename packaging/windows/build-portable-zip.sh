#!/bin/bash
# Today's quick Windows preview: no installer, no bundled Node (Ian's PC already has Node 24).
# Mirrors the sibling-repo layout exactly (brainlink-src/ next to brainlink-store/) so
# `npm install`'s "brainlink-store": "file:../brainlink-store" dependency resolves unmodified.
# Full installer path (bundled Node, NSIS) is packaging/windows/build-windows.sh, for later.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STORE_SRC="$(cd "$ROOT/../brainlink-store" && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
WORK="$ROOT/build/windows-portable"
DIST="$ROOT/dist"
NAME="BrainLink-Preview-$VERSION"
STAGE="$WORK/$NAME"

rm -rf "$WORK" && mkdir -p "$STAGE/brainlink-src" "$STAGE/brainlink-store" "$DIST"
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/ui" "$ROOT/samples" "$ROOT/docs" "$ROOT/package.json" "$ROOT/LICENSE.txt" "$ROOT/README.md" "$STAGE/brainlink-src/"
cp "$STORE_SRC/memory-store.mjs" "$STORE_SRC/errors.mjs" "$STORE_SRC/interface.d.ts" "$STORE_SRC/contract-tests.mjs" "$STORE_SRC/package.json" "$STORE_SRC/README.md" "$STAGE/brainlink-store/"

cat > "$STAGE/GETTING-STARTED-WINDOWS.txt" <<'TXT'
BrainLink -- Windows preview (unsigned, no installer yet)

You need Node 24 (or any Node 22+) already installed. Check with:  node -v

1. Unzip this folder anywhere, e.g. Desktop\BrainLink-Preview.
   Keep "brainlink-src" and "brainlink-store" side by side -- do not separate them.
2. Open a terminal (PowerShell or cmd) in the "brainlink-src" folder.
3. Run:
     npm install
     node bin\brainlink.mjs demo
   This opens a browser to a throwaway sample vault (made-up notes) -- nothing on your
   real computer is touched. Press Control-C in the terminal when you are done.
4. To try it on your own notes instead:
     node bin\brainlink.mjs init --vault "C:\path\to\your\notes"
     node bin\brainlink.mjs ui
   "ui" opens the same app on the vault(s) in your config instead of the sample one.

A signed .exe installer and a macOS .pkg follow later; this zip is just for today's look.
TXT
command -v perl >/dev/null && perl -pi -e 's/\r?\n/\r\n/' "$STAGE/GETTING-STARTED-WINDOWS.txt"

OUT="$DIST/$NAME-windows.zip"
rm -f "$OUT"
(cd "$WORK" && python3 -m zipfile -c "$OUT" "$NAME")
(cd "$DIST" && (shasum -a 256 "$(basename "$OUT")" 2>/dev/null || sha256sum "$(basename "$OUT")") > "$(basename "$OUT").sha256")
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
exit 0
