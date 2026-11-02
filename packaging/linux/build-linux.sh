#!/bin/bash
# Builds Linux packages on macOS or Linux, for x64 and arm64:
#   dist/brainlink-<v>-linux-<arch>.tar.gz   per-user: extract, run ./install.sh (no root)
#   dist/brainlink_<v>_<deb-arch>.deb        Debian/Ubuntu: /opt/brainlink + /usr/bin/brainlink + app menu entry
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NODE_VERSION="$(tr -d '\r\n' < "$ROOT/vendor/node/VERSION")"
if [[ ! "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid pinned Node.js version in vendor/node/VERSION" >&2
  exit 1
fi
NODE_DIST="https://nodejs.org/dist/v$NODE_VERSION"
WORK="$ROOT/build/linux"
DIST="$ROOT/dist"
rm -rf "$WORK" && mkdir -p "$WORK" "$DIST"
TAR=tar; command -v gtar >/dev/null && TAR=gtar
TAR_OPTS=(--no-xattrs)
TAR_FORMAT=gnutar
TAR_OWNERSHIP_OPTS=(--uid 0 --gid 0 --uname root --gname root)
if "$TAR" --version 2>&1 | grep -q 'GNU tar'; then
  TAR_FORMAT=gnu
  TAR_OWNERSHIP_OPTS=(--owner=root:0 --group=root:0)
fi
"$TAR" --help 2>&1 | grep -q -- '--no-mac-metadata' && TAR_OPTS+=(--no-mac-metadata)
[ -f "$ROOT/vendor/node/SHASUMS256.txt" ] || curl -fsS "$NODE_DIST/SHASUMS256.txt" -o "$ROOT/vendor/node/SHASUMS256.txt"
ICON="$ROOT/packaging/linux/brainlink.svg"
[ -f "$ICON" ] || { echo "Missing Linux icon: $ICON" >&2; exit 1; }
cp "$ICON" "$WORK/brainlink.svg"

for ARCH in x64 arm64; do
  NAME="brainlink-$VERSION-linux-$ARCH"
  S="$WORK/$NAME"
  NT="$ROOT/vendor/node/node-v$NODE_VERSION-linux-$ARCH.tar.xz"
  [ -f "$NT" ] || curl -fsS "$NODE_DIST/$(basename "$NT")" -o "$NT"
  (cd "$ROOT/vendor/node" && grep " $(basename "$NT")$" SHASUMS256.txt | shasum -a 256 -c --quiet)
  mkdir -p "$S/node/bin" "$S/app" "$S/bin"
  tar -xJf "$NT" -C "$WORK" "node-v$NODE_VERSION-linux-$ARCH/bin/node" "node-v$NODE_VERSION-linux-$ARCH/LICENSE"
  mv "$WORK/node-v$NODE_VERSION-linux-$ARCH/bin/node" "$S/node/bin/node"
  mv "$WORK/node-v$NODE_VERSION-linux-$ARCH/LICENSE" "$S/node/LICENSE"
  rm -rf "$WORK/node-v$NODE_VERSION-linux-$ARCH"
  cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/ui" "$ROOT/samples" "$ROOT/skills" "$ROOT/package.json" "$ROOT/LICENSE.txt" "$ROOT/README.md" "$S/app/"
  rm -rf "$S/app/ui/app/test"
  mkdir -p "$S/app/node_modules/brainlink-store"
  cp "$ROOT/vendor/brainlink-store/memory-store.mjs" "$ROOT/vendor/brainlink-store/errors.mjs" "$ROOT/vendor/brainlink-store/package.json" "$S/app/node_modules/brainlink-store/"
  node "$ROOT/scripts/stage-runtime-dependencies.mjs" "$S/app/node_modules"
  cp "$HERE/brainlink.sh" "$S/bin/brainlink"
  cp "$HERE/install.sh" "$HERE/uninstall.sh" "$S/"
  cp "$WORK/brainlink.svg" "$S/brainlink.svg"
  chmod 755 "$S/bin/brainlink" "$S/install.sh" "$S/uninstall.sh" "$S/node/bin/node"
  COPYFILE_DISABLE=1 "$TAR" "${TAR_OPTS[@]}" -czf "$DIST/$NAME.tar.gz" -C "$WORK" "$NAME"

  # .deb: files owned by root, installed to /opt/brainlink.
  DEBARCH=$([ "$ARCH" = x64 ] && echo amd64 || echo arm64)
  D="$WORK/deb-$DEBARCH"
  mkdir -p "$D/root/opt/brainlink" "$D/root/usr/bin" "$D/root/usr/share/applications" "$D/root/usr/share/icons/hicolor/scalable/apps" "$D/control"
  cp -R "$S/node" "$S/app" "$S/bin" "$D/root/opt/brainlink/"
  ln -s /opt/brainlink/bin/brainlink "$D/root/usr/bin/brainlink"
  cp "$WORK/brainlink.svg" "$D/root/usr/share/icons/hicolor/scalable/apps/brainlink.svg"
  printf '[Desktop Entry]\nType=Application\nName=BrainLink\nComment=One Markdown second brain for every AI\nExec=/opt/brainlink/bin/brainlink setup --app\nIcon=brainlink\nTerminal=false\nCategories=Office;Utility;\n' > "$D/root/usr/share/applications/brainlink.desktop"
  SIZE=$(du -sk "$D/root" | cut -f1)
  printf 'Package: brainlink\nVersion: %s\nArchitecture: %s\nMaintainer: Iango <support@iango.ai>\nInstalled-Size: %s\nSection: utils\nPriority: optional\nHomepage: https://iango.ai/brainlink\nDescription: One Markdown second brain for every AI\n BrainLink connects an Obsidian or Markdown folder to Claude, ChatGPT Codex,\n Cursor, Gemini and other MCP clients, with safe, attributed writes.\n' "$VERSION" "$DEBARCH" "$SIZE" > "$D/control/control"
  printf '#!/bin/sh\n# Remove BrainLink from the invoking user'"'"'s AI apps is per-user; see brainlink disconnect-all.\nexit 0\n' > "$D/control/prerm"; chmod 755 "$D/control/prerm"
  (cd "$D" && echo "2.0" > debian-binary \
    && COPYFILE_DISABLE=1 "$TAR" --format "$TAR_FORMAT" "${TAR_OPTS[@]}" "${TAR_OWNERSHIP_OPTS[@]}" -czf control.tar.gz -C control . \
    && COPYFILE_DISABLE=1 "$TAR" --format "$TAR_FORMAT" "${TAR_OPTS[@]}" "${TAR_OWNERSHIP_OPTS[@]}" -czf data.tar.gz -C root . \
    && node "$HERE/ar.mjs" "$DIST/brainlink_${VERSION}_$DEBARCH.deb" debian-binary control.tar.gz data.tar.gz)
done
(cd "$DIST" && for f in brainlink-$VERSION-linux-*.tar.gz brainlink_${VERSION}_*.deb; do shasum -a 256 "$f" > "$f.sha256"; done)
ls -la "$DIST" | grep -i -E "linux|\.deb"

