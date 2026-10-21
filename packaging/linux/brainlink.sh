#!/bin/sh
# BrainLink command: runs the bundled Node runtime, so no system Node is needed.
SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")
ROOT=$(cd "$(dirname "$SELF")/.." && pwd)
exec "$ROOT/node/bin/node" "$ROOT/app/bin/brainlink.mjs" "$@"
