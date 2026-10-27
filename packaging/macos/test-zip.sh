#!/bin/bash
# Self-test for the zip build-zip.sh produces. Runs entirely on Linux: checks the archive's file
# tree, permission bits, the BrainLink.app bundle and the LaunchAgent plist it generates at
# install time, the absence of secrets/excluded paths, and that the installer scripts are clean
# bash and actually install/uninstall into a fake $HOME with no Terminal interaction required.
# Then it runs the bundled app's JS directly with THIS box's own node (the bundled darwin
# binaries cannot run here) to make sure the app code itself boots and serves.
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

# Validates a plist (Info.plist or a generated LaunchAgent plist): plutil if this box has it,
# otherwise a Python plistlib parse as the XML sanity check -- either way this fails loudly on
# malformed XML instead of silently accepting it.
lint_plist() {
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$1" >/dev/null
  else
    python3 -c "import plistlib,sys; plistlib.load(open(sys.argv[1], 'rb'))" "$1"
  fi
}
# Reads one key out of a plist as text, same plutil-or-plistlib fallback.
plist_get() {
  if command -v plutil >/dev/null 2>&1; then
    plutil -extract "$2" raw -o - "$1" 2>/dev/null
  else
    python3 -c "
import plistlib, sys
v = plistlib.load(open(sys.argv[1], 'rb'))[sys.argv[2]]
print(v if isinstance(v, str) else ('true' if v is True else ('false' if v is False else v)))
" "$1" "$2"
  fi
}

echo "== unzip =="
unzip -q "$ZIP" -d "$TMP"
BASE="$TMP/BrainLink"
[ -d "$BASE" ] || { echo "FAIL: zip does not contain a top-level BrainLink/ folder" >&2; exit 1; }
echo "ok"

echo "== file tree =="
REQUIRED=(
  "app/bin/brainlink.mjs" "app/src/runtime.mjs" "app/src/connectors.mjs" "app/ui/index.html"
  "app/ui/locales/en.json" "app/ui/locales/zh-TW.json" "app/ui/locales/pt.json"
  "app/samples/acme-studio" "app/skills/brainlink-session-closeout/SKILL.md" "app/skills/brainlink-graph-curation/SKILL.md" "app/package.json" "app/LICENSE.txt" "app/README.md"
  "app/node_modules/brainlink-store/memory-store.mjs" "app/node_modules/brainlink-store/package.json"
  "app/node_modules/yaml/package.json" "app/node_modules/yaml/dist/index.js"
  "runtime/arm64/bin/node" "runtime/arm64/LICENSE" "runtime/x64/bin/node" "runtime/x64/LICENSE"
  "Install BrainLink.command" "Uninstall BrainLink.command" "READ ME FIRST.txt"
  "BrainLink.app/Contents/Info.plist" "BrainLink.app/Contents/MacOS/BrainLink"
)
for p in "${REQUIRED[@]}"; do
  [ -e "$BASE/$p" ] || { echo "FAIL: missing $p" >&2; exit 1; }
done
echo "ok: all required paths present"

echo "== permission bits =="
for p in "Install BrainLink.command" "Uninstall BrainLink.command" "runtime/arm64/bin/node" "runtime/x64/bin/node" "BrainLink.app/Contents/MacOS/BrainLink"; do
  [ -x "$BASE/$p" ] || { echo "FAIL: not executable: $p" >&2; exit 1; }
done
echo "ok: executable bits preserved through the zip"

echo "== excluded paths and secrets =="
for bad in app/test app/docs app/.git app/dist; do
  [ -e "$BASE/$bad" ] && { echo "FAIL: excluded path present: $bad" >&2; exit 1; }
done
HITS="$(find "$BASE" -type f \( -iname '*.pem' -o -iname '*secret*' -o -iname 'id_rsa*' -o -iname '*.key' \) || true)"
if [ -n "$HITS" ]; then
  echo "FAIL: possible secret/key file(s) in bundle:" >&2; echo "$HITS" >&2; exit 1
fi
if grep -rqi "trial\|licen[cs]e.key\|licence key" "$BASE/app/ui/index.html" "$BASE/app/ui/locales" 2>/dev/null; then
  echo "FAIL: trial/licence wording leaked into the shipped UI" >&2; exit 1
fi
echo "ok: no excluded paths, secret files, or trial/licence wording"

echo "== BrainLink.app bundle structure =="
APP="$BASE/BrainLink.app"
lint_plist "$APP/Contents/Info.plist" || { echo "FAIL: Info.plist is not a valid property list" >&2; exit 1; }
[ "$(plist_get "$APP/Contents/Info.plist" CFBundleExecutable)" = "BrainLink" ] || { echo "FAIL: Info.plist CFBundleExecutable != BrainLink" >&2; exit 1; }
[ "$(plist_get "$APP/Contents/Info.plist" CFBundleIdentifier)" = "ai.brainlink.app" ] || { echo "FAIL: Info.plist CFBundleIdentifier != ai.brainlink.app" >&2; exit 1; }
bash -n "$APP/Contents/MacOS/BrainLink" || { echo "FAIL: BrainLink.app launcher has a bash syntax error" >&2; exit 1; }
echo "ok: Info.plist valid, identifiers correct, launcher is clean bash"

echo "== installer scripts: clean bash, safe install pattern =="
for p in "Install BrainLink.command" "Uninstall BrainLink.command"; do
  bash -n "$BASE/$p" || { echo "FAIL: $p has a bash syntax error" >&2; exit 1; }
  grep -q '^set -euo pipefail$' "$BASE/$p" || { echo "FAIL: $p is missing set -euo pipefail" >&2; exit 1; }
done
grep -q 'mktemp -d' "$BASE/Install BrainLink.command" || { echo "FAIL: Install BrainLink.command does not copy to a temp dir before moving into place" >&2; exit 1; }
echo "ok"

echo "== Install BrainLink.command: installs app + LaunchAgent into a fake \$HOME, no Terminal needed =="
FAKEHOME="$(mktemp -d)"
DOWNLOAD_PARENT="$(mktemp -d)"
DOWNLOAD="$DOWNLOAD_PARENT/BrainLink"
cp -R "$BASE" "$DOWNLOAD"
DEST="$FAKEHOME/Applications/BrainLink"
APPDEST="$FAKEHOME/Applications/BrainLink.app"
PLIST="$FAKEHOME/Library/LaunchAgents/ai.brainlink.plist"
NOTES="$FAKEHOME/Documents/My Brain"
mkdir -p "$NOTES"
echo "a real note, must survive uninstall" > "$NOTES/note.md"

# A real macOS `open` returns immediately; some Linux boxes alias it to xdg-open, which can
# launch an actual browser and block for a long time (or forever) with no display to open it on.
# Stub it out so this self-test's timing depends only on our own scripts, not the host's open(1).
STUBBIN="$(mktemp -d)"
printf '#!/bin/sh\nexit 0\n' > "$STUBBIN/open"
chmod 755 "$STUBBIN/open"

# Runs without a real `launchctl`/background server (none can run on this Linux box), so the
# health-check and token-file waits inside the script time out and it still finishes; the
# "press any key" read then hits EOF against </dev/null -- expected for this harness, not a sign
# the install itself failed, so `|| true` here. The real checks are the filesystem state below.
# `timeout` is a backstop in case some other host quirk blocks a step we have not anticipated.
(HOME="$FAKEHOME" PATH="$STUBBIN:$PATH" timeout 90 bash "$DOWNLOAD/Install BrainLink.command" < /dev/null > /dev/null || true)

[ -e "$DEST/app/bin/brainlink.mjs" ] || { echo "FAIL: Install BrainLink.command did not install to \$HOME/Applications/BrainLink" >&2; exit 1; }
[ -e "$DOWNLOAD/app/bin/brainlink.mjs" ] || { echo "FAIL: the original download folder was removed instead of copied" >&2; exit 1; }
find "$FAKEHOME/Applications" -maxdepth 1 -name '.BrainLink-install.*' | grep -q . && { echo "FAIL: a temp install dir was left behind" >&2; exit 1; }
echo "ok: installs from a Downloads-style folder to \$HOME/Applications/BrainLink, original download untouched"

[ -x "$APPDEST/Contents/MacOS/BrainLink" ] || { echo "FAIL: \$HOME/Applications/BrainLink.app launcher missing or not executable" >&2; exit 1; }
lint_plist "$APPDEST/Contents/Info.plist" || { echo "FAIL: installed BrainLink.app/Contents/Info.plist is not a valid property list" >&2; exit 1; }
find "$FAKEHOME/Applications" -maxdepth 1 -name '.BrainLink-app-install.*' | grep -q . && { echo "FAIL: a temp app-install dir was left behind" >&2; exit 1; }
echo "ok: \$HOME/Applications/BrainLink.app installed"

[ -f "$PLIST" ] || { echo "FAIL: LaunchAgent plist was not written to \$HOME/Library/LaunchAgents/ai.brainlink.plist" >&2; exit 1; }
lint_plist "$PLIST" || { echo "FAIL: ai.brainlink.plist is not a valid property list" >&2; exit 1; }
[ "$(plist_get "$PLIST" Label)" = "ai.brainlink" ] || { echo "FAIL: ai.brainlink.plist Label != ai.brainlink" >&2; exit 1; }
[ "$(plist_get "$PLIST" RunAtLoad)" = "true" ] || { echo "FAIL: ai.brainlink.plist RunAtLoad is not true" >&2; exit 1; }
[ "$(plist_get "$PLIST" KeepAlive)" = "true" ] || { echo "FAIL: ai.brainlink.plist KeepAlive is not true" >&2; exit 1; }
grep -q "$DEST/runtime" "$PLIST" || { echo "FAIL: ai.brainlink.plist does not point at the installed bundled Node runtime" >&2; exit 1; }
grep -q "$DEST/app/bin/brainlink.mjs" "$PLIST" || { echo "FAIL: ai.brainlink.plist does not point at the installed brainlink.mjs" >&2; exit 1; }
grep -q 'setup' "$PLIST" || { echo "FAIL: ai.brainlink.plist does not run the setup command" >&2; exit 1; }
grep -q "$FAKEHOME/Library/Logs/BrainLink" "$PLIST" || { echo "FAIL: ai.brainlink.plist does not log to ~/Library/Logs/BrainLink" >&2; exit 1; }
echo "ok: ai.brainlink.plist is a valid per-user LaunchAgent (RunAtLoad+KeepAlive, logs to ~/Library/Logs/BrainLink)"

echo "== Uninstall BrainLink.command: removes app/plist/logs, keeps notes =="
(HOME="$FAKEHOME" PATH="$STUBBIN:$PATH" timeout 90 bash "$DEST/Uninstall BrainLink.command" < /dev/null > /dev/null || true)
[ -e "$DEST" ] && { echo "FAIL: Uninstall did not remove \$HOME/Applications/BrainLink" >&2; exit 1; }
[ -e "$APPDEST" ] && { echo "FAIL: Uninstall did not remove \$HOME/Applications/BrainLink.app" >&2; exit 1; }
[ -e "$PLIST" ] && { echo "FAIL: Uninstall did not remove the LaunchAgent plist" >&2; exit 1; }
[ -e "$FAKEHOME/Library/Logs/BrainLink" ] && { echo "FAIL: Uninstall did not remove ~/Library/Logs/BrainLink" >&2; exit 1; }
[ -f "$NOTES/note.md" ] || { echo "FAIL: Uninstall touched the user's notes" >&2; exit 1; }
echo "ok: uninstall removes app, plist and logs; notes are kept"
rm -rf "$FAKEHOME" "$DOWNLOAD_PARENT" "$STUBBIN"

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
