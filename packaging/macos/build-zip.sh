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

# 3. Vendor brainlink-store so the bare `import ... from 'brainlink-store'` resolves with no
#    npm install and no network (test/ and python-noncanonical/ are not runtime dependencies).
mkdir -p "$STAGE/app/node_modules/brainlink-store"
cp "$STORE_SRC/memory-store.mjs" "$STORE_SRC/errors.mjs" "$STORE_SRC/interface.d.ts" \
   "$STORE_SRC/package.json" "$STORE_SRC/README.md" "$STAGE/app/node_modules/brainlink-store/"

# 4. The BrainLink.app launcher bundle: a minimal double-clickable app (Info.plist + a small
#    shell launcher in Contents/MacOS, no Node inside it) that opens the dashboard that already
#    runs in the background, starting it first if needed. No Terminal window: unlike a .command
#    file, an app bundle's CFBundleExecutable is launched directly by macOS.
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
# BrainLink.app launcher: opens the dashboard that the ai.brainlink LaunchAgent already runs in
# the background; starts that background service first if it is not answering yet. No Terminal
# window -- macOS launches this script directly as the app's CFBundleExecutable.
PORT=$BRAINLINK_PORT
TOKEN_FILE="\$HOME/Library/Application Support/BrainLink/setup-token"
PLIST="\$HOME/Library/LaunchAgents/ai.brainlink.plist"

alert() { osascript -e "display alert \"BrainLink\" message \"\$1\"" >/dev/null 2>&1 || true; }
up() { if curl -fsS -m 1 "http://127.0.0.1:\$PORT/health" >/dev/null 2>&1; then return 0; else return 1; fi; }

if ! up; then
  if [ -f "\$PLIST" ]; then launchctl load "\$PLIST" >/dev/null 2>&1 || true; fi
  for _ in \$(seq 1 20); do
    if up; then break; fi
    sleep 0.5
  done
fi

if ! up; then
  alert "BrainLink could not start. Open the BrainLink folder in Applications and run Install BrainLink.command again."
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

# 5. Install BrainLink.command: one double-click, run once. Copies the payload (runtime/ + app/)
#    to ~/Applications/BrainLink, copies the launcher to ~/Applications/BrainLink.app, writes and
#    loads the per-user ai.brainlink LaunchAgent (RunAtLoad + KeepAlive, logs to
#    ~/Library/Logs/BrainLink), then opens the dashboard once so Install feels instant. After
#    this, nothing ever needs Terminal again -- the BrainLink icon in Applications/Launchpad is
#    the only thing people use day to day.
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
#    who has never used Terminal. English, 繁體中文 and Português, in that order.
cat > "$STAGE/READ ME FIRST.txt" <<TXT
BrainLink $VERSION_FULL for Mac

======================================================================
ENGLISH
======================================================================

GETTING STARTED (one time only)
1. Unzip this (double-click the .zip if it did not unzip itself). You should see a BrainLink
   folder with this file inside it.
2. In that folder, right-click "Install BrainLink.command" and choose Open.
3. macOS will warn that the file is from an unidentified developer. Click Open (you only need
   to do this once).
4. If macOS instead says the file "cannot be opened" or is blocked:
   - Open System Settings > Privacy & Security, scroll to the Security section, and click
     "Open Anyway" next to BrainLink. Then try step 2 again.
   - Or open Terminal and run:
       xattr -dr com.apple.quarantine ~/Downloads/BrainLink
     (adjust the path if you unzipped somewhere other than Downloads), then try step 2 again.
5. A window opens, installs BrainLink, and your browser opens to it automatically. When it says
   "Installed", you are done -- press any key to close that window. You can now delete the
   downloaded BrainLink folder; BrainLink itself now lives in Applications.

EVERY DAY AFTER THAT
Open BrainLink from the BrainLink icon in Applications or Launchpad, like any other app. No
Terminal, no windows to keep open -- BrainLink runs quietly in the background and starts itself
whenever you log in.

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
2. 在該資料夾中，右鍵點擊「Install BrainLink.command」，選擇「打開」。
3. macOS 會提示此檔案來自不明開發者。點擊「打開」即可（只需做一次）。
4. 如果 macOS 顯示檔案「無法打開」或被封鎖：
   - 打開「系統設定」>「隱私權與安全性」，往下捲動到「安全性」區塊，點擊 BrainLink 旁邊的
     「仍要打開」，然後重做步驟 2。
   - 或者打開「終端機」，執行：
       xattr -dr com.apple.quarantine ~/Downloads/BrainLink
     （如果你把檔案解壓到別的資料夾，請改成對應路徑），然後重做步驟 2。
5. 會出現一個視窗開始安裝 BrainLink，安裝完成後瀏覽器會自動打開。看到「Installed」訊息就表示完
   成了——按任意鍵關閉視窗即可。這時你可以刪除下載的 BrainLink 資料夾；BrainLink 本身已經安裝在
   「應用程式」資料夾裡了。

之後每天怎麼用
之後只要在「應用程式」或 Launchpad 裡點 BrainLink 的圖示，跟打開其他 App 一樣。不需要開終端機，
也不需要留著任何視窗——BrainLink 會在背景安靜運作，而且每次登入都會自動啟動。

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
2. Nessa pasta, clique com o botão direito em "Install BrainLink.command" e escolha Abrir.
3. O macOS vai avisar que o ficheiro é de um desenvolvedor não identificado. Clique em Abrir
   (só precisa fazer isso uma vez).
4. Se em vez disso o macOS disser que o ficheiro "não pode ser aberto" ou foi bloqueado:
   - Abra Definições do Sistema > Privacidade e Segurança, desça até a secção Segurança e
     clique em "Abrir Mesmo Assim" junto ao BrainLink. Depois repita o passo 2.
   - Ou abra o Terminal e execute:
       xattr -dr com.apple.quarantine ~/Downloads/BrainLink
     (ajuste o caminho se descompactou noutro sítio que não a pasta Downloads), depois repita
     o passo 2.
5. Vai abrir uma janela que instala o BrainLink, e o navegador abre automaticamente a seguir.
   Quando aparecer "Installed", está feito -- pressione qualquer tecla para fechar essa janela.
   Pode agora apagar a pasta BrainLink que descarregou; o BrainLink já está instalado em
   Aplicações.

NO DIA A DIA
Abra o BrainLink pelo ícone na pasta Aplicações ou na Launchpad, como qualquer outra aplicação.
Sem Terminal, sem janelas para manter abertas -- o BrainLink fica a funcionar discretamente em
segundo plano e arranca sozinho sempre que iniciar sessão.

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
