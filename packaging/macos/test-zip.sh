#!/bin/bash
# Self-test for the zip build-zip.sh produces. Runs entirely on Linux: checks the archive's file
# tree, permission bits, and the absence of secrets/excluded paths, then runs the bundled app's
# JS directly with THIS box's own node (the bundled darwin binaries cannot run here) to make sure
# the app code itself boots and serves.
#
# Usage: test-zip.sh [path-to-zip]  (default: dist/BrainLink-<major.minor>-mac.zip)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION_FULL="$(node -p "require('$ROOT/package.json').version")"
VERSION="$(node -p "'$VERSION_FULL'.split('.').slice(0,2).join('.')")"
ZIP="${1:-$ROOT/dist/BrainLink-$VERSION-mac.zip}"

[ -f "$ZIP" ] || { echo "FAIL: zip not found: $ZIP" >&2; exit 1; }

TMP="$(mktemp -d)"
cleanup() {
  if [ -n "${PID:-}" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== unzip =="
unzip -q "$ZIP" -d "$TMP"
BASE="$TMP/BrainLink"
[ -d "$BASE" ] || { echo "FAIL: zip does not contain a top-level BrainLink/ folder" >&2; exit 1; }
echo "ok"

echo "== file tree =="
REQUIRED=(
  "app/bin/brainlink.mjs" "app/src/runtime.mjs" "app/src/connectors.mjs" "app/ui/index.html"
  "app/samples/acme-studio" "app/package.json" "app/LICENSE.txt" "app/README.md"
  "app/node_modules/brainlink-store/memory-store.mjs" "app/node_modules/brainlink-store/package.json"
  "runtime/arm64/bin/node" "runtime/arm64/LICENSE" "runtime/x64/bin/node" "runtime/x64/LICENSE"
  "Start BrainLink.command" "Install BrainLink.command" "Connect AI apps.command" ".install.sh" "READ ME FIRST.txt"
)
for p in "${REQUIRED[@]}"; do
  [ -e "$BASE/$p" ] || { echo "FAIL: missing $p" >&2; exit 1; }
done
echo "ok: all required paths present"

echo "== permission bits =="
for p in "Start BrainLink.command" "Install BrainLink.command" "Connect AI apps.command" "runtime/arm64/bin/node" "runtime/x64/bin/node"; do
  [ -x "$BASE/$p" ] || { echo "FAIL: not executable: $p" >&2; exit 1; }
done
echo "ok: executable bits preserved through the zip"

echo "== excluded paths and secrets =="
for bad in app/test app/docs app/.git app/dist app/samples/../../.git; do
  [ -e "$BASE/$bad" ] && { echo "FAIL: excluded path present: $bad" >&2; exit 1; }
done
if grep -q "BOX-AUTHORED STAND-IN" "$BASE/app/src/license-key.mjs" 2>/dev/null; then
  echo "FAIL: dev stand-in license-key.mjs leaked into the bundle" >&2; exit 1
fi
HITS="$(find "$BASE" -type f \( -iname '*.pem' -o -iname '*secret*' -o -iname 'id_rsa*' -o -iname '*.key' \) || true)"
if [ -n "$HITS" ]; then
  echo "FAIL: possible secret/key file(s) in bundle:" >&2; echo "$HITS" >&2; exit 1
fi
echo "ok: no excluded paths or obvious secret files"

echo "== install script safety (set -euo pipefail, copy-then-mv, refuses to run from the installed copy) =="
for p in "Start BrainLink.command" "Install BrainLink.command" "Connect AI apps.command"; do
  grep -q '^set -euo pipefail$' "$BASE/$p" || { echo "FAIL: $p is missing set -euo pipefail" >&2; exit 1; }
done
grep -q 'mktemp -d' "$BASE/Install BrainLink.command" || { echo "FAIL: Install BrainLink.command does not copy to a temp dir before moving into place" >&2; exit 1; }

FAKEHOME="$(mktemp -d)"
DOWNLOAD_PARENT="$(mktemp -d)"
DOWNLOAD="$DOWNLOAD_PARENT/BrainLink"
cp -R "$BASE" "$DOWNLOAD"
DEST="$FAKEHOME/Applications/BrainLink"

# First run from a Downloads-style folder installs to ~/Applications/BrainLink without touching
# the original download, via a real .command file (not just the shared .install.sh helper) so the
# set -euo pipefail / shebang / quoting are exercised the same way a double-click would. The
# trailing "press any key" read hits EOF against </dev/null and returns non-zero under set -e --
# expected for this harness, not a sign the install itself failed -- so `|| true` here; the real
# check is the filesystem state asserted below.
(HOME="$FAKEHOME" bash "$DOWNLOAD/Install BrainLink.command" < /dev/null > /dev/null || true)
[ -e "$DEST/app/bin/brainlink.mjs" ] || { echo "FAIL: Install BrainLink.command did not install to \$HOME/Applications/BrainLink" >&2; exit 1; }
[ -e "$DOWNLOAD/app/bin/brainlink.mjs" ] || { echo "FAIL: the original download folder was removed instead of copied" >&2; exit 1; }
[ -x "$DEST/Start BrainLink.command" ] || { echo "FAIL: installed Start BrainLink.command lost its executable bit" >&2; exit 1; }
find "$FAKEHOME/Applications" -maxdepth 1 -name '.BrainLink-install.*' | grep -q . && { echo "FAIL: a temp install dir was left behind" >&2; exit 1; }
echo "ok: installs from a Downloads-style folder to \$HOME/Applications/BrainLink, original download untouched"

# Re-running Install from inside $DEST must refuse (no rm -rf of its own running copy) rather
# than silently re-copying itself into itself.
BEFORE="$(find "$DEST" -type f | sort | xargs -I{} stat -c '%n %Y %s' {} | sort)"
OUT="$(HOME="$FAKEHOME" bash "$DEST/Install BrainLink.command" < /dev/null || true)"
AFTER="$(find "$DEST" -type f | sort | xargs -I{} stat -c '%n %Y %s' {} | sort)"
echo "$OUT" | grep -qi "already installed" || { echo "FAIL: running Install from inside \$DEST did not refuse: $OUT" >&2; exit 1; }
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL: running Install from inside \$DEST modified the installed copy" >&2; exit 1; }
find "$FAKEHOME/Applications" -maxdepth 1 -name '.BrainLink-install.*' | grep -q . && { echo "FAIL: a temp install dir was left behind by the refused run" >&2; exit 1; }
echo "ok: refuses to run from inside \$DEST"
rm -rf "$FAKEHOME" "$DOWNLOAD_PARENT"

echo "== running the bundled app (with this box's own node) =="
cd "$BASE"
export BRAINLINK_HOME="$TMP/home"
export HOME="$TMP/home"
mkdir -p "$HOME"
LOG="$TMP/demo.log"
# BRAINLINK_SHOW_TOKEN: bin/brainlink.mjs masks the token (?t=...) in anything it prints to the
# terminal by default (RB3); this harness needs the real URL to curl it, so it opts in via the
# same env var real test/debug harnesses use. Terminal output for end users stays masked.
BRAINLINK_SHOW_TOKEN=1 node app/bin/brainlink.mjs demo --no-open > "$LOG" 2>&1 &
PID=$!

URL=""
for _ in $(seq 1 50); do
  URL="$(grep -oE 'http://[0-9.]+:[0-9]+[^[:space:]]*' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.2
done

if [ -z "$URL" ]; then
  echo "FAIL: app did not print a URL within 10s" >&2; cat "$LOG" >&2; exit 1
fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL")"
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
PID=""

if [ "$CODE" != "200" ]; then
  echo "FAIL: expected HTTP 200 from $URL, got $CODE" >&2; cat "$LOG" >&2; exit 1
fi
echo "ok: demo served HTTP $CODE at $URL"

echo "SELF-TEST PASSED"
