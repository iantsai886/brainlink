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
  "Start BrainLink.command" "Install BrainLink.command" "Connect AI apps.command" "READ ME FIRST.txt"
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

echo "== running the bundled app (with this box's own node) =="
cd "$BASE"
export BRAINLINK_HOME="$TMP/home"
export HOME="$TMP/home"
mkdir -p "$HOME"
LOG="$TMP/demo.log"
node app/bin/brainlink.mjs demo --no-open > "$LOG" 2>&1 &
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
