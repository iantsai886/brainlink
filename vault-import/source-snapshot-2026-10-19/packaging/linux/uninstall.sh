#!/bin/sh
# Removes BrainLink from your AI apps (with backups), then removes the program.
# Your notes and settings (~/.config/brainlink) are kept.
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA/brainlink"
[ -x "$DEST/bin/brainlink" ] && "$DEST/bin/brainlink" disconnect-all || true
rm -f "$HOME/.local/bin/brainlink" "$DATA/applications/brainlink.desktop"
rm -rf "$DEST"
echo "BrainLink removed. Your notes and ~/.config/brainlink were kept."
