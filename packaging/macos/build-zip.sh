#!/bin/bash
# Builds dist/BrainLink-<major.minor>-mac.zip: a self-contained Node runtime + app bundle that
# installs and runs on a CLEAN Mac (no Node, no Xcode, no dev tools). Built and zipped from
# Linux -- no pkgbuild, no codesign, no notarisation (that is packaging/macos/build-pkg.sh).
#
# Usage: build-zip.sh [app-source-dir]
#   app-source-dir defaults to the repo root (two levels up from this script).
#
# Env overrides (for testing against a different checkout/runtime cache):
#   BRAINLINK_STORE_SRC  optional override (default: checked-in vendor/brainlink-store)
#   BRAINLINK_NODE_RT    path to the downloaded, SHA-checked Node tarballs (default: /workspace/brainlink-runs/node-rt)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${1:-$HERE/../..}" && pwd)"
STORE_SRC="$(cd "${BRAINLINK_STORE_SRC:-$ROOT/vendor/brainlink-store}" && pwd)"
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
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/ui" "$ROOT/samples" "$ROOT/skills" "$STAGE/app/"
rm -rf "$STAGE/app/ui/app/test"
cp "$ROOT/package.json" "$ROOT/LICENSE.txt" "$ROOT/README.md" "$STAGE/app/"

# 3. Vendor brainlink-store so the bare `import ... from 'brainlink-store'` resolves with no
#    npm install and no network (test/ and python-noncanonical/ are not runtime dependencies).
mkdir -p "$STAGE/app/node_modules/brainlink-store"
cp "$STORE_SRC/memory-store.mjs" "$STORE_SRC/errors.mjs" "$STORE_SRC/interface.d.ts" \
   "$STORE_SRC/package.json" "$STORE_SRC/README.md" "$STAGE/app/node_modules/brainlink-store/"
node "$ROOT/scripts/stage-runtime-dependencies.mjs" "$STAGE/app/node_modules"
mkdir -p "$STAGE/app/src/ingestion"
cp "$ROOT/src/ingestion/image-ocr.mjs" "$STAGE/app/src/ingestion/image-ocr.mjs"
node "$ROOT/scripts/stage-ocr-data.mjs" "$STAGE/app/src/ingestion/tessdata"

# 4. The BrainLink.app launcher bundle: a minimal double-clickable app (Info.plist + a small
#    shell launcher in Contents/MacOS, no Node inside it). This IS the Finder install/open path:
#    double-click it straight from the downloaded, unzipped folder and it installs itself (copies
#    the payload into ~/Applications, writes and loads the LaunchAgent) on first run, then opens
#    the dashboard every time after -- no Terminal window ever appears, unlike a .command file
#    (which Terminal.app visibly runs). Install/Uninstall BrainLink.command still exist as a
#    secondary fallback for anyone who prefers that route.
#    BRAINLINK_PORT must match bin/brainlink.mjs's SETUP_PORT -- both are the fixed local port
#    the background dashboard listens on.
BRAINLINK_PORT=47800
mkdir -p "$STAGE/BrainLink.app/Contents/MacOS"

cat > "$STAGE/BrainLink.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>BrainLink</string>
  <key>CFBundleDisplayName</key><string>BrainLink</string>
  <key>CFBundleIdentifier</key><string>ai.brainlink.app</string>
  <key>CFBundleExecutable</key><string>BrainLink</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION_FULL</string>
  <key>CFBundleVersion</key><string>$VERSION_FULL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$STAGE/BrainLink.app/Contents/MacOS/BrainLink" <<SH
#!/bin/bash
# BrainLink.app launcher: on first double-click (from a freshly downloaded, unzipped folder) this
# installs BrainLink -- copies app/+runtime/ into ~/Applications/BrainLink, copies itself into
# ~/Applications/BrainLink.app, writes and loads the per-user ai.brainlink LaunchAgent -- then
# opens the dashboard. On every later double-click (from ~/Applications or Launchpad) the install
# step is already done, so this just opens the dashboard, starting the background service first
# if it is not answering yet. No Terminal window: macOS launches this script directly as the
# app's CFBundleExecutable.
PORT=$BRAINLINK_PORT
TOKEN_FILE="\$HOME/Library/Application Support/BrainLink/setup-token"
PLIST="\$HOME/Library/LaunchAgents/ai.brainlink.plist"
BUNDLE_DIR="\$(cd "\$(dirname "\$0")/../.." && pwd -P)"
HERE="\$(dirname "\$BUNDLE_DIR")"
DEST="\$HOME/Applications/BrainLink"
APPDEST="\$HOME/Applications/BrainLink.app"

alert() { osascript -e "display alert \"BrainLink\" message \"\$1\"" >/dev/null 2>&1 || true; }
up() { if curl -fsS -m 1 "http://127.0.0.1:\$PORT/health" >/dev/null 2>&1; then return 0; else return 1; fi; }

install_if_needed() {
  if [ -f "\$PLIST" ] && up; then return 0; fi
  # The payload (app/, runtime/) sits next to this bundle on a fresh download; once installed it
  # lives in \$DEST instead. Either way, find it before copying anything.
  local SRC=""
  if [ -d "\$HERE/app" ] && [ -d "\$HERE/runtime" ]; then SRC="\$HERE"
  elif [ -d "\$DEST/app" ] && [ -d "\$DEST/runtime" ]; then SRC="\$DEST"
  else
    alert "Could not find BrainLink's app files next to BrainLink.app. Re-download BrainLink and try again."
    exit 1
  fi
  mkdir -p "\$HOME/Applications" "\$HOME/Library/LaunchAgents" "\$HOME/Library/Logs/BrainLink"
  if [ "\$SRC" != "\$DEST" ]; then
    TMP="\$(mktemp -d "\$HOME/Applications/.BrainLink-install.XXXXXX")"
    cp -R "\$SRC/app" "\$SRC/runtime" "\$TMP/"
    rm -rf "\$DEST"
    mv "\$TMP" "\$DEST"
  fi
  if [ "\$BUNDLE_DIR" != "\$APPDEST" ]; then
    APPTMP="\$(mktemp -d "\$HOME/Applications/.BrainLink-app-install.XXXXXX")"
    cp -R "\$BUNDLE_DIR/." "\$APPTMP/"
    rm -rf "\$APPDEST"
    mv "\$APPTMP" "\$APPDEST"
    chmod +x "\$APPDEST/Contents/MacOS/BrainLink"
  fi
  case "\$(uname -m)" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) alert "BrainLink does not support this Mac's processor (\$(uname -m))."; exit 1 ;;
  esac
  NODE_BIN="\$DEST/runtime/\$ARCH/bin/node"
  CLI_PATH="\$DEST/app/bin/brainlink.mjs"
  cat > "\$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.brainlink</string>
  <key>ProgramArguments</key>
  <array>
    <string>\$NODE_BIN</string>
    <string>\$CLI_PATH</string>
    <string>setup</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>\$HOME/Library/Logs/BrainLink/stdout.log</string>
  <key>StandardErrorPath</key><string>\$HOME/Library/Logs/BrainLink/stderr.log</string>
</dict>
</plist>
PLIST
  launchctl unload "\$PLIST" >/dev/null 2>&1 || true
  launchctl load "\$PLIST" >/dev/null 2>&1 || true
}

install_if_needed

if ! up; then
  for _ in \$(seq 1 20); do
    if up; then break; fi
    sleep 0.5
  done
fi

if ! up; then
  alert "BrainLink could not start. Open the BrainLink folder in Applications and double-click BrainLink.app again."
  exit 1
fi

for _ in \$(seq 1 20); do
  if [ -s "\$TOKEN_FILE" ]; then break; fi
  sleep 0.3
done
TOKEN="\$(cat "\$TOKEN_FILE" 2>/dev/null || true)"
open "http://127.0.0.1:\$PORT/?t=\$TOKEN" >/dev/null 2>&1 || true
SH
chmod 755 "$STAGE/BrainLink.app/Contents/MacOS/BrainLink"
chmod 644 "$STAGE/BrainLink.app/Contents/Info.plist"

# 5. Install BrainLink.command: a SECONDARY fallback for anyone who prefers it (or whose Mac
#    balks at double-clicking an unsigned .app). BrainLink.app above is the lead install/open
#    path. Same effect either way: copies the payload (runtime/ + app/) to ~/Applications/
#    BrainLink, copies the launcher to ~/Applications/BrainLink.app, writes and loads the
#    per-user ai.brainlink LaunchAgent (RunAtLoad + KeepAlive, logs to ~/Library/Logs/BrainLink),
#    then opens the dashboard once so Install feels instant.
cat > "$STAGE/Install BrainLink.command" <<SH
#!/bin/bash
set -euo pipefail
cd "\$(dirname "\$0")"
HERE="\$(pwd -P)"
DEST="\$HOME/Applications/BrainLink"
APPDEST="\$HOME/Applications/BrainLink.app"
PLIST="\$HOME/Library/LaunchAgents/ai.brainlink.plist"
LOGDIR="\$HOME/Library/Logs/BrainLink"
PORT=$BRAINLINK_PORT

echo "Installing BrainLink..."
mkdir -p "\$HOME/Applications" "\$HOME/Library/LaunchAgents" "\$LOGDIR"

# Payload: copy to a temp dir first and mv into place (never rm -rf the old copy before the new
# one is ready); a no-op if this folder is already \$DEST.
if [ "\$HERE" != "\$(cd "\$DEST" 2>/dev/null && pwd -P || true)" ]; then
  TMP="\$(mktemp -d "\$HOME/Applications/.BrainLink-install.XXXXXX")"
  cp -R "\$HERE/." "\$TMP/"
  rm -rf "\$DEST"
  mv "\$TMP" "\$DEST"
fi
chmod +x "\$DEST/Install BrainLink.command" "\$DEST/Uninstall BrainLink.command"

# Launcher app: same copy-then-mv safety, always refreshed so an upgrade's launcher replaces the
# old one.
APPTMP="\$(mktemp -d "\$HOME/Applications/.BrainLink-app-install.XXXXXX")"
cp -R "\$HERE/BrainLink.app/." "\$APPTMP/"
rm -rf "\$APPDEST"
mv "\$APPTMP" "\$APPDEST"
chmod +x "\$APPDEST/Contents/MacOS/BrainLink"

case "\$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "BrainLink does not support this Mac's processor (\$(uname -m))."; read -n1 -r -p "Press any key to close..."; exit 1 ;;
esac
NODE_BIN="\$DEST/runtime/\$ARCH/bin/node"
CLI_PATH="\$DEST/app/bin/brainlink.mjs"

cat > "\$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.brainlink</string>
  <key>ProgramArguments</key>
  <array>
    <string>\$NODE_BIN</string>
    <string>\$CLI_PATH</string>
    <string>setup</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>\$LOGDIR/stdout.log</string>
  <key>StandardErrorPath</key><string>\$LOGDIR/stderr.log</string>
</dict>
</plist>
PLIST

launchctl unload "\$PLIST" >/dev/null 2>&1 || true
launchctl load "\$PLIST" >/dev/null 2>&1 || echo "Could not start the background service automatically; restart your Mac or run this installer again."

echo "Waiting for BrainLink to start..."
for _ in \$(seq 1 30); do
  if curl -fsS -m 1 "http://127.0.0.1:\$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

TOKEN_FILE="\$HOME/Library/Application Support/BrainLink/setup-token"
for _ in \$(seq 1 20); do
  if [ -s "\$TOKEN_FILE" ]; then break; fi
  sleep 0.3
done
TOKEN="\$(cat "\$TOKEN_FILE" 2>/dev/null || true)"
open "http://127.0.0.1:\$PORT/?t=\$TOKEN" >/dev/null 2>&1 || true

echo "Installed. BrainLink now runs quietly in the background and starts automatically when you log in."
echo "Open it any time from the BrainLink icon in Applications or Launchpad -- you will not need this window again."
read -n1 -r -p "Press any key to close this window..."
SH
chmod 755 "$STAGE/Install BrainLink.command"

# 6. Uninstall BrainLink.command: stops and removes the background service, the launcher app and
#    the logs. Never touches a vault folder, so notes are always kept.
cat > "$STAGE/Uninstall BrainLink.command" <<'SH'
#!/bin/bash
set -euo pipefail
DEST="$HOME/Applications/BrainLink"
APPDEST="$HOME/Applications/BrainLink.app"
PLIST="$HOME/Library/LaunchAgents/ai.brainlink.plist"
LOGDIR="$HOME/Library/Logs/BrainLink"

echo "Uninstalling BrainLink..."
launchctl unload "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
rm -rf "$APPDEST"
rm -rf "$LOGDIR"
rm -rf "$DEST"
echo "BrainLink has been removed. Your notes were not touched -- they are still in their own folder."
read -n1 -r -p "Press any key to close this window..."
SH
chmod 755 "$STAGE/Uninstall BrainLink.command"

# 7. READ ME FIRST.txt: the exact Gatekeeper steps for an unsigned, unnotarised app, for someone
#    who has never used Terminal. Leads with double-clicking BrainLink.app (the install and the
#    everyday-open path are the same icon); Install/Uninstall BrainLink.command are mentioned
#    only as a fallback. English, 繁體中文 and Português, in that order.
cat > "$STAGE/READ ME FIRST.txt" <<TXT
BrainLink $VERSION_FULL for Mac

======================================================================
ENGLISH
======================================================================

GETTING STARTED (one time only)
1. Unzip this (double-click the .zip if it did not unzip itself). You should see a BrainLink
   folder with this file inside it.
2. In that folder, right-click "BrainLink.app" and choose Open.
3. macOS will warn that the app is from an unidentified developer. Click Open (you only need
   to do this once).
4. If macOS instead says the app "cannot be opened" or is blocked:
   - Open System Settings > Privacy & Security, scroll to the Security section, and click
     "Open Anyway" next to BrainLink. Then try step 2 again.
   - Or open Terminal and run:
       xattr -dr com.apple.quarantine ~/Downloads/BrainLink
     (adjust the path if you unzipped somewhere other than Downloads), then try step 2 again.
5. BrainLink installs itself and your browser opens to it automatically -- no window, no typing.
   You can now delete the downloaded BrainLink folder; BrainLink itself now lives in
   Applications.

EVERY DAY AFTER THAT
Open BrainLink from the same BrainLink icon, now in Applications or Launchpad, like any other
app. No Terminal, no windows to keep open -- BrainLink runs quietly in the background and
starts itself whenever you log in.

IF BRAINLINK.APP WON'T OPEN
Use the fallback instead: in the BrainLink folder, right-click "Install BrainLink.command" and
choose Open. It does the same install, in a Terminal window this time.

TO REMOVE BRAINLINK
Open the BrainLink folder in Applications and double-click "Uninstall BrainLink.command". Your
notes are kept; only BrainLink itself is removed.

No installation of Node.js or Xcode is required -- BrainLink bundles its own Node runtime.

======================================================================
繁體中文
======================================================================

開始使用（只需做一次）
1. 解壓縮這個檔案（如果沒有自動解壓，雙擊 .zip 檔即可）。你會看到一個 BrainLink 資料夾，這份說明
   就在裡面。
2. 在該資料夾中，右鍵點擊「BrainLink.app」，選擇「打開」。
3. macOS 會提示此應用程式來自不明開發者。點擊「打開」即可（只需做一次）。
4. 如果 macOS 顯示應用程式「無法打開」或被封鎖：
   - 打開「系統設定」>「隱私權與安全性」，往下捲動到「安全性」區塊，點擊 BrainLink 旁邊的
     「仍要打開」，然後重做步驟 2。
   - 或者打開「終端機」，執行：
       xattr -dr com.apple.quarantine ~/Downloads/BrainLink
     （如果你把檔案解壓到別的資料夾，請改成對應路徑），然後重做步驟 2。
5. BrainLink 會自動完成安裝，瀏覽器也會自動打開——不會有視窗，也不需要打字。這時你可以刪除下載
   的 BrainLink 資料夾；BrainLink 本身已經安裝在「應用程式」資料夾裡了。

之後每天怎麼用
之後只要點同一個 BrainLink 圖示（現在在「應用程式」或 Launchpad 裡），跟打開其他 App 一樣。不需
要開終端機，也不需要留著任何視窗——BrainLink 會在背景安靜運作，而且每次登入都會自動啟動。

如果 BrainLink.app 打不開
改用備用方式：在 BrainLink 資料夾中，右鍵點擊「Install BrainLink.command」，選擇「打開」。效果
相同，只是這次會開一個「終端機」視窗。

如何移除 BrainLink
打開「應用程式」裡的 BrainLink 資料夾，雙擊「Uninstall BrainLink.command」。你的筆記會被保留，
只會移除 BrainLink 本身。

不需要另外安裝 Node.js 或 Xcode——BrainLink 已經內建了自己的 Node 執行環境。

======================================================================
PORTUGUÊS
======================================================================

PRIMEIROS PASSOS (só uma vez)
1. Descompacte este ficheiro (se não abrir automaticamente, basta clicar duas vezes no .zip).
   Vai aparecer uma pasta BrainLink com este texto lá dentro.
2. Nessa pasta, clique com o botão direito em "BrainLink.app" e escolha Abrir.
3. O macOS vai avisar que a aplicação é de um desenvolvedor não identificado. Clique em Abrir
   (só precisa fazer isso uma vez).
4. Se em vez disso o macOS disser que a aplicação "não pode ser aberta" ou foi bloqueada:
   - Abra Definições do Sistema > Privacidade e Segurança, desça até a secção Segurança e
     clique em "Abrir Mesmo Assim" junto ao BrainLink. Depois repita o passo 2.
   - Ou abra o Terminal e execute:
       xattr -dr com.apple.quarantine ~/Downloads/BrainLink
     (ajuste o caminho se descompactou noutro sítio que não a pasta Downloads), depois repita
     o passo 2.
5. O BrainLink instala-se sozinho e o navegador abre automaticamente a seguir -- sem janelas,
   sem escrever nada. Pode agora apagar a pasta BrainLink que descarregou; o BrainLink já está
   instalado em Aplicações.

NO DIA A DIA
Abra o BrainLink pelo mesmo ícone, agora na pasta Aplicações ou na Launchpad, como qualquer
outra aplicação. Sem Terminal, sem janelas para manter abertas -- o BrainLink fica a funcionar
discretamente em segundo plano e arranca sozinho sempre que iniciar sessão.

SE O BRAINLINK.APP NÃO ABRIR
Use o método alternativo: na pasta BrainLink, clique com o botão direito em "Install
BrainLink.command" e escolha Abrir. Faz a mesma instalação, só que numa janela do Terminal.

PARA REMOVER O BRAINLINK
Abra a pasta BrainLink em Aplicações e clique duas vezes em "Uninstall BrainLink.command". As
suas notas são mantidas; só o BrainLink em si é removido.

Não é preciso instalar Node.js nem Xcode -- o BrainLink já vem com o seu próprio Node incluído.
TXT

# 8. Zip with a stable layout and unix executable bits preserved (no `zip` binary on this box;
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
