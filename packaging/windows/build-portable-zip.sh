#!/bin/bash
# Today's quick Windows preview: no installer, no bundled Node (Ian's PC already has Node 24).
# Uses the checked-in store package, so no sibling checkout is required.
# Full installer path (bundled Node, NSIS) is packaging/windows/build-windows.sh, for later.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
WORK="$ROOT/build/windows-portable"
DIST="$ROOT/dist"
NAME="BrainLink-Preview-$VERSION"
STAGE="$WORK/$NAME"

rm -rf "$WORK" && mkdir -p "$STAGE/brainlink-src/vendor" "$DIST"
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/ui" "$ROOT/samples" "$ROOT/skills" "$ROOT/package.json" "$ROOT/LICENSE.txt" "$ROOT/README.md" "$STAGE/brainlink-src/"
# Ship only the public product documentation referenced by README. The checkout's docs folder
# also contains private reviews, Claude prompts, and project working notes; never copy it wholesale.
mkdir -p "$STAGE/brainlink-src/docs"
for doc in PRODUCT-SPEC.md GRAPH-KNOWLEDGE-MODEL.md SESSION-INDEX.md RELEASE-READINESS.md STORE-RECOVERY.md; do
  cp "$ROOT/docs/$doc" "$STAGE/brainlink-src/docs/$doc"
done
rm -rf "$STAGE/brainlink-src/ui/app/test"
cp -R "$ROOT/vendor/brainlink-store" "$STAGE/brainlink-src/vendor/"

cat > "$STAGE/GETTING-STARTED-WINDOWS.txt" <<'TXT'
BrainLink -- Windows preview (unsigned, no installer yet)

You need Node 24 (or any Node 22+) already installed. Check with:  node -v

1. Unzip this folder anywhere, e.g. Desktop\BrainLink-Preview.
   The storage package is included inside "brainlink-src".
2. Open a terminal (PowerShell or cmd) in the "brainlink-src" folder.
3. Run:
     npm install
     node bin\brainlink.mjs setup
   This opens the guided first-run setup. Choose an existing notes folder or create a new,
   empty brain. No sample company or demo notes are added. Connect AI apps one at a time,
   and skip any connection you do not want.
4. To see made-up sample notes instead, run `node bin\brainlink.mjs demo` explicitly.
   To reopen BrainLink later, run `node bin\brainlink.mjs ui`.

A signed .exe installer and a macOS .pkg follow later; this zip is just for today's look.
TXT
command -v perl >/dev/null && perl -pi -e 's/\r?\n/\r\n/' "$STAGE/GETTING-STARTED-WINDOWS.txt"

OUT="$DIST/$NAME-windows.zip"
rm -f "$OUT"
(cd "$WORK" && python3 -m zipfile -c "$OUT" "$NAME")
(cd "$DIST" && (shasum -a 256 "$(basename "$OUT")" 2>/dev/null || sha256sum "$(basename "$OUT")") > "$(basename "$OUT").sha256")
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
exit 0
