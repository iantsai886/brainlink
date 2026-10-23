#!/bin/bash
# Builds dist/BrainLink-<version>-win.zip: a self-contained Node runtime + app bundle that runs on
# a clean Windows 10/11 PC (no Node install, no admin rights). Built and zipped from Linux/macOS --
# no Windows needed to build it (packaging/windows/build-windows.sh/.ps1 + the .nsi/.iss remain as
# the separate signed-installer path, for later).
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
WORK="$ROOT/build/windows-zip"
DIST="$ROOT/dist"
STAGE="$WORK/BrainLink"

echo "BrainLink $VERSION_FULL windows zip · Node $NODE_VERSION"
rm -rf "$WORK" && mkdir -p "$STAGE/app" "$STAGE/node" "$DIST"

# 1. Node runtime: verify the official zip against the SHA256 sums downloaded alongside it, then
#    extract only node.exe + LICENSE (no npm, no headers, no docs).
(cd "$NODE_RT" && grep -E "win-x64\.zip$" SHASUMS256.txt | sha256sum -c --quiet)
unzip -q -j "$NODE_RT/node-v$NODE_VERSION-win-x64.zip" \
  "node-v$NODE_VERSION-win-x64/node.exe" "node-v$NODE_VERSION-win-x64/LICENSE" -d "$STAGE/node"

# 2. App files: only what customers need to run it (no test/, docs, vendor tools, issuer keys --
#    and no src/license-key.mjs: there is no licence gating to ship, see src/core.mjs FEATURES).
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/ui" "$ROOT/samples" "$STAGE/app/"
cp "$ROOT/package.json" "$ROOT/LICENSE.txt" "$ROOT/README.md" "$STAGE/app/"
rm -f "$STAGE/app/src/license-key.mjs"

# 3. Vendor brainlink-store so the bare `import ... from 'brainlink-store'` resolves with no
#    npm install and no network.
mkdir -p "$STAGE/app/node_modules/brainlink-store"
cp "$STORE_SRC/memory-store.mjs" "$STORE_SRC/errors.mjs" "$STORE_SRC/interface.d.ts" \
   "$STORE_SRC/package.json" "$STORE_SRC/README.md" "$STAGE/app/node_modules/brainlink-store/"

# 4. The double-click launcher, uninstaller and icon. BrainLink.vbs runs node hidden (no console
#    window ever) on `win-start` (src/winapp.mjs + bin/brainlink.mjs), which installs into
#    %LOCALAPPDATA%\BrainLink and writes a Startup-folder autostart entry (the no-admin-needed
#    stand-in for macOS's LaunchAgent) before opening the dashboard -- every later double-click
#    just reopens it. Windows line endings for the scripts Windows runs directly.
cp "$HERE/BrainLink.vbs" "$HERE/Uninstall BrainLink.cmd" "$HERE/BrainLink.ico" "$STAGE/"
mkdir -p "$STAGE/bin" && cp "$HERE/brainlink.cmd" "$STAGE/bin/brainlink.cmd"
for f in "$STAGE/BrainLink.vbs" "$STAGE/Uninstall BrainLink.cmd" "$STAGE/bin/brainlink.cmd"; do
  perl -pi -e 's/\r?\n/\r\n/' "$f"
done

# 5. READ ME FIRST.txt: plain-language steps for someone who has never used a terminal. English,
#    Português and 繁體中文, in that order (same languages, same order, as the macOS zip's READ ME).
cat > "$STAGE/READ ME FIRST.txt" <<TXT
BrainLink $VERSION_FULL for Windows

======================================================================
ENGLISH
======================================================================

GETTING STARTED (one time only)
1. Unzip this (right-click the .zip and choose "Extract All..." if it did not unzip itself).
   You should see a BrainLink folder with this file inside it.
2. In that folder, double-click "BrainLink.vbs".
3. Windows may show "Windows protected your PC" (SmartScreen, because this app is not yet
   code-signed). Click "More info", then "Run anyway". You only need to do this once.
4. BrainLink installs itself and your browser opens to it automatically -- no console window,
   no typing. You can now delete the downloaded BrainLink folder if you like; BrainLink itself
   now lives in your user folder and starts automatically whenever you log in.

EVERY DAY AFTER THAT
BrainLink runs quietly in the background and starts itself at login. To open the dashboard
again, double-click "BrainLink.vbs" from wherever you kept it (or re-download and unzip it --
it will find the already-running BrainLink instead of starting a second one).

TO REMOVE BRAINLINK
Double-click "Uninstall BrainLink.cmd" in the same folder. Your notes are kept; only BrainLink
itself (and its Startup-folder entry) is removed. No administrator rights are needed to
install or uninstall.

No installation of Node.js is required -- BrainLink bundles its own Node runtime.

======================================================================
PORTUGUÊS
======================================================================

PRIMEIROS PASSOS (só uma vez)
1. Descompacte este ficheiro (clique com o botão direito no .zip e escolha "Extrair Tudo..."
   se não abrir automaticamente). Vai aparecer uma pasta BrainLink com este texto lá dentro.
2. Nessa pasta, clique duas vezes em "BrainLink.vbs".
3. O Windows pode mostrar "O Windows protegeu o seu PC" (SmartScreen, porque esta aplicação
   ainda não tem assinatura de código). Clique em "Mais informações" e depois em "Executar
   mesmo assim". Só precisa de fazer isto uma vez.
4. O BrainLink instala-se sozinho e o navegador abre automaticamente a seguir -- sem janela de
   consola, sem escrever nada. Pode agora apagar a pasta BrainLink que descarregou, se quiser;
   o BrainLink já está instalado na sua pasta de utilizador e arranca sozinho sempre que iniciar
   sessão.

NO DIA A DIA
O BrainLink fica a funcionar discretamente em segundo plano e arranca sozinho ao iniciar
sessão. Para abrir o painel novamente, clique duas vezes em "BrainLink.vbs" onde o guardou (ou
descarregue e descompacte de novo -- vai encontrar o BrainLink já em execução em vez de abrir
um segundo).

PARA REMOVER O BRAINLINK
Clique duas vezes em "Uninstall BrainLink.cmd" na mesma pasta. As suas notas são mantidas; só
o BrainLink em si (e a sua entrada na pasta de Inicialização) é removido. Não são necessários
privilégios de administrador para instalar ou remover.

Não é preciso instalar Node.js -- o BrainLink já vem com o seu próprio Node incluído.

======================================================================
繁體中文
======================================================================

開始使用（只需做一次）
1. 解壓縮這個檔案（如果沒有自動解壓，右鍵點擊 .zip 檔並選擇「解壓全部...」）。你會看到一個
   BrainLink 資料夾，這份說明就在裡面。
2. 在該資料夾中，雙擊「BrainLink.vbs」。
3. Windows 可能會顯示「您的電腦已被 Windows 保護」（SmartScreen 提示，因為這個應用程式尚未經過
   程式碼簽署）。點擊「更多資訊」，然後點擊「仍要執行」。只需做一次。
4. BrainLink 會自動完成安裝，瀏覽器也會自動打開——不會有主控台視窗，也不需要打字。這時你可以
   刪除下載的 BrainLink 資料夾；BrainLink 本身已經安裝在你的使用者資料夾中，並會在每次登入時
   自動啟動。

之後每天怎麼用
BrainLink 會在背景安靜運作，並在登入時自動啟動。若要再次打開面板，在你保留的位置雙擊
「BrainLink.vbs」即可（或重新下載並解壓縮——它會找到已經在執行的 BrainLink，而不會另外啟動
第二個）。

如何移除 BrainLink
在同一個資料夾中雙擊「Uninstall BrainLink.cmd」。你的筆記會被保留；只會移除 BrainLink 本身
（以及它在「啟動」資料夾中的項目）。安裝或移除都不需要系統管理員權限。

不需要另外安裝 Node.js——BrainLink 已經內建了自己的 Node 執行環境。
TXT
perl -pi -e 's/\r?\n/\r\n/' "$STAGE/READ ME FIRST.txt"

# 6. Zip with a stable layout, preserved from this Linux box (no exec bits needed on Windows; .vbs
#    and .cmd run by double-click regardless of the zip's stored permission bits).
OUT="$DIST/BrainLink-$VERSION_FULL-win.zip"
rm -f "$OUT"
python3 - "$WORK" "BrainLink" "$OUT" <<'PY'
import os, sys, zipfile

work, name, out = sys.argv[1], sys.argv[2], sys.argv[3]
base = os.path.join(work, name)
entries = []
for root, dirs, files in os.walk(base):
    dirs.sort()
    for fn in sorted(files):
        entries.append(os.path.join(root, fn))

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
