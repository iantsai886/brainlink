#!/bin/sh
# Installs BrainLink for this user (no root needed):
#   ~/.local/share/brainlink        program files
#   ~/.local/bin/brainlink          command
#   app menu entry "BrainLink"      opens Setup in the browser
# Settings (~/.config/brainlink) and your notes are never touched by install or uninstall.
set -e
SRC=$(cd "$(dirname "$0")" && pwd)
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA/brainlink"
BIN="$HOME/.local/bin"
APPS="$DATA/applications"
rm -rf "$DEST.new"
mkdir -p "$DEST.new" "$BIN" "$APPS"
cp -R "$SRC/node" "$SRC/app" "$SRC/bin" "$SRC/brainlink.png" "$SRC/uninstall.sh" "$DEST.new/"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
ln -sf "$DEST/bin/brainlink" "$BIN/brainlink"
cat > "$APPS/brainlink.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=BrainLink
Comment=One Markdown second brain for every AI
Exec="$DEST/bin/brainlink" setup --app
Icon=$DEST/brainlink.png
Terminal=false
Categories=Office;Utility;
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true
echo "BrainLink $("$DEST/bin/brainlink" version) installed in $DEST"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Note: add $BIN to your PATH to use the brainlink command (open a new terminal on most distributions)." ;; esac
if [ "$1" != "--no-open" ] && [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then
  nohup "$DEST/bin/brainlink" setup --app >/dev/null 2>&1 &
  echo "Setup is opening in your browser."
else
  echo "Run: brainlink setup"
fi
