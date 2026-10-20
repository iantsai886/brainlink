#!/bin/bash
# Keeps the BrainLink source in a second-brain vault (where every AI can read, verify and edit
# it) in step with a build checkout. Never overwrites a newer file on either side and never
# deletes; shows what it would do unless --apply is given.
#   tools/brain-sync.sh push  <brain-project-dir> [--apply]   checkout → vault  (after building/testing here)
#   tools/brain-sync.sh pull  <brain-project-dir> [--apply]   vault → checkout  (before building here)
#   tools/brain-sync.sh status <brain-project-dir>            files that differ, both directions
# <brain-project-dir> is the project folder in the vault; source goes in its source/ subfolder.
# BRAINLINK_BRAIN_DIR can be set instead of passing it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-status}"; DIR="${2:-${BRAINLINK_BRAIN_DIR:-}}"; APPLY="${3:-}"
[ -n "$DIR" ] || { echo "usage: $0 push|pull|status <brain-project-dir> [--apply]"; exit 1; }
DEST="$DIR/source"
EXCLUDES=(--exclude vendor/ --exclude build/ --exclude dist/ --exclude node_modules/ --exclude .DS_Store --exclude '*.tmp-*' --exclude '*.brainlink-tmp')
DRY=(--dry-run); [ "$APPLY" = "--apply" ] && DRY=()
case "$CMD" in
  push) mkdir -p "$DEST"; rsync -a --update --itemize-changes ${DRY[@]+"${DRY[@]}"} "${EXCLUDES[@]}" "$ROOT/" "$DEST/" ;;
  pull) rsync -a --update --itemize-changes ${DRY[@]+"${DRY[@]}"} "${EXCLUDES[@]}" "$DEST/" "$ROOT/" ;;
  status)
    echo "checkout → vault:"; rsync -a --update --dry-run --itemize-changes "${EXCLUDES[@]}" "$ROOT/" "$DEST/" | grep -v '/$' || true
    echo "vault → checkout:"; rsync -a --update --dry-run --itemize-changes "${EXCLUDES[@]}" "$DEST/" "$ROOT/" | grep -v '/$' || true ;;
  *) echo "unknown command $CMD"; exit 1 ;;
esac
[ "$CMD" != status ] && [ "$APPLY" != "--apply" ] && echo "(preview only; add --apply to copy)"
exit 0
