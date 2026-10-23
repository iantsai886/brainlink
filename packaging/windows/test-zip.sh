#!/bin/bash
# Self-test for the zip build-zip.sh produces. Runs entirely on Linux: checks the archive's file
# tree, the absence of secrets/excluded paths (incl. src/license-key.mjs), the launcher/uninstaller
# scripts' content and line endings, exercises the bundled src/winapp.mjs install/uninstall logic
# (the Startup-folder autostart entry) against a fake AppData, and runs the bundled app's JS
# directly with THIS box's own node (the bundled node.exe is a Windows PE binary and cannot run
# here) to make sure the app code itself boots and serves.
#
# Usage: test-zip.sh [path-to-zip]  (default: dist/BrainLink-<version>-win.zip)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION_FULL="$(node -p "require('$ROOT/package.json').version")"
ZIP="${1:-$ROOT/dist/BrainLink-$VERSION_FULL-win.zip}"

[ -f "$ZIP" ] || { echo "FAIL: zip not found: $ZIP" >&2; exit 1; }

TMP="$(mktemp -d)"
cleanup() { if [ -n "${PID:-}" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi; rm -rf "$TMP"; }
trap cleanup EXIT

echo "== unzip =="
unzip -q "$ZIP" -d "$TMP"
BASE="$TMP/BrainLink"
[ -d "$BASE" ] || { echo "FAIL: zip does not contain a top-level BrainLink/ folder" >&2; exit 1; }
echo "ok"

echo "== file tree =="
REQUIRED=(
  "app/bin/brainlink.mjs" "app/src/runtime.mjs" "app/src/winapp.mjs" "app/src/pathsafe.mjs" "app/src/connectors.mjs"
  "app/ui/index.html" "app/ui/locales/en.json" "app/ui/locales/zh-TW.json" "app/ui/locales/pt.json"
  "app/samples/acme-studio" "app/package.json" "app/LICENSE.txt" "app/README.md"
  "app/node_modules/brainlink-store/memory-store.mjs" "app/node_modules/brainlink-store/package.json"
  "node/node.exe" "node/LICENSE" "bin/brainlink.cmd"
  "BrainLink.vbs" "Uninstall BrainLink.cmd" "READ ME FIRST.txt" "BrainLink.ico"
)
for p in "${REQUIRED[@]}"; do
  [ -e "$BASE/$p" ] || { echo "FAIL: missing $p" >&2; exit 1; }
done
echo "ok: all required paths present"

echo "== excluded paths and secrets =="
[ -e "$BASE/app/src/license-key.mjs" ] && { echo "FAIL: src/license-key.mjs must not ship" >&2; exit 1; }
for bad in app/test app/docs app/.git app/dist; do
  [ -e "$BASE/$bad" ] && { echo "FAIL: excluded path present: $bad" >&2; exit 1; }
done
HITS="$(find "$BASE" -type f \( -iname '*.pem' -o -iname '*secret*' -o -iname 'id_rsa*' -o -iname '*.key' \) || true)"
if [ -n "$HITS" ]; then echo "FAIL: possible secret/key file(s) in bundle:" >&2; echo "$HITS" >&2; exit 1; fi
if grep -rqi "trial\|licen[cs]e.key\|licence key" "$BASE/app/ui/index.html" "$BASE/app/ui/locales" 2>/dev/null; then
  echo "FAIL: trial/licence wording leaked into the shipped UI" >&2; exit 1
fi
echo "ok: no license-key.mjs, excluded paths, secret files, or trial/licence wording"

echo "== launcher and uninstaller: correct commands, CRLF line endings =="
grep -q 'win-start' "$BASE/BrainLink.vbs" || { echo "FAIL: BrainLink.vbs does not run win-start" >&2; exit 1; }
grep -q '"node.exe"\|\\node\\node.exe' "$BASE/BrainLink.vbs" || { echo "FAIL: BrainLink.vbs does not point at the bundled node.exe" >&2; exit 1; }
grep -qE ', 0, False' "$BASE/BrainLink.vbs" || { echo "FAIL: BrainLink.vbs does not run hidden+non-blocking (window style 0, False)" >&2; exit 1; }
grep -q 'win-uninstall' "$BASE/Uninstall BrainLink.cmd" || { echo "FAIL: Uninstall BrainLink.cmd does not run win-uninstall" >&2; exit 1; }
for f in "BrainLink.vbs" "Uninstall BrainLink.cmd" "READ ME FIRST.txt" "bin/brainlink.cmd"; do
  python3 -c "
import sys
data = open(sys.argv[1], 'rb').read()
assert b'\r\n' in data, 'no CRLF found'
assert b'\n\r' not in data.replace(b'\r\n', b''), 'mixed line endings'
" "$BASE/$f" || { echo "FAIL: $f is not CRLF" >&2; exit 1; }
done
echo "ok: launcher/uninstaller point at the right commands, CRLF throughout"

echo "== bundled src/winapp.mjs: install-if-needed + Startup-folder autostart entry, against a fake AppData =="
FAKEHOME="$(mktemp -d)"
cat > "$TMP/winapp-check.mjs" <<'JS'
import { installIfNeeded, installDir, uninstallWindows } from 'WINAPP_MODULE';
import { stat, readFile } from 'node:fs/promises';
const here = process.argv[2];
const home = process.argv[3];
const env = { LOCALAPPDATA: home + '/Local', APPDATA: home + '/Roaming' };
const { dest, startup } = await installIfNeeded({ here, env, home });
if (dest !== installDir(env, home)) throw new Error('installDir mismatch');
await stat(dest + '/app/bin/brainlink.mjs');
await stat(dest + '/node/node.exe');
const script = await readFile(startup, 'utf8');
if (!script.includes('win-start --no-open')) throw new Error('autostart does not run win-start --no-open');
if (!script.includes(dest)) throw new Error('autostart does not point at the installed copy');
await uninstallWindows({ env, home });
if (await stat(dest).then(() => true, () => false)) throw new Error('uninstall left the install dir behind');
if (await stat(startup).then(() => true, () => false)) throw new Error('uninstall left the Startup entry behind');
console.log('winapp-check: ok');
JS
# import specifiers must be string literals, not expressions -- substitute the real path to the
# bundled module (plain string replace, not eval) before running it.
sed -i "s#WINAPP_MODULE#$BASE/app/src/winapp.mjs#" "$TMP/winapp-check.mjs"
node "$TMP/winapp-check.mjs" "$BASE" "$FAKEHOME"
rm -rf "$FAKEHOME"
echo "ok"

echo "== running the bundled app (with this box's own node) =="
cd "$BASE"
export BRAINLINK_HOME="$TMP/home"
export HOME="$TMP/home"
mkdir -p "$HOME"
LOG="$TMP/demo.log"
BRAINLINK_SHOW_TOKEN=1 node app/bin/brainlink.mjs demo --no-open > "$LOG" 2>&1 &
PID=$!

URL=""
for _ in $(seq 1 50); do
  URL="$(grep -oE 'http://[0-9.]+:[0-9]+[^[:space:]]*' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.2
done

if [ -z "$URL" ]; then echo "FAIL: app did not print a URL within 10s" >&2; cat "$LOG" >&2; exit 1; fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL")"
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
PID=""

if [ "$CODE" != "200" ]; then echo "FAIL: expected HTTP 200 from $URL, got $CODE" >&2; cat "$LOG" >&2; exit 1; fi
echo "ok: demo served HTTP $CODE at $URL"

echo "WIN SELF-TEST PASSED"
