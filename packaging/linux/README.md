# Linux build

`npm run build:linux` (runs on macOS or Linux) builds, for x64 and arm64:

- `brainlink-<version>-linux-<arch>.tar.gz`: per-user, no root. Extract it and run `./install.sh`. It installs to `~/.local/share/brainlink`, adds `~/.local/bin/brainlink` and a "BrainLink" app-menu entry, and opens Setup when a desktop is present. Remove it with `~/.local/share/brainlink/uninstall.sh`, which first removes BrainLink from connected AI apps.
- `brainlink_<version>_<amd64|arm64>.deb`: Debian/Ubuntu (`sudo apt install ./brainlink_….deb`). Installs to `/opt/brainlink`, adds `/usr/bin/brainlink` and an app-menu entry.

Both bundle the pinned official Node 24.22.1 runtime (checksum-verified against Node's matching SHA-256 manifest). Settings live in `~/.config/brainlink` (or `$XDG_CONFIG_HOME`). Obsidian vaults are found from native, AppImage, Flatpak and Snap installs. The folder picker uses `zenity` or `kdialog`; without either, Setup asks for the path.

The Linux builder uses its own SVG icon, so Linux packaging does not depend on the macOS icon assets.

**Tested in containers (2026-10-19):** Debian 12 arm64 and amd64, Ubuntu 24.04 arm64 and Fedora 41 arm64 (tarball). Covered: install, `brainlink init`, `connect all` (Claude Desktop and Cursor configs), MCP over stdio (search), the Setup server, `brief`, uninstall (AI configs cleaned, settings kept), `.deb` install and removal with dpkg.

Verified 2026-10-24 in a Debian 12 x64 container: rebuilt x64 and arm64 archives and `.deb` packages, installed the x64 `.deb`, ran the bundled-runtime `brainlink --version`, and initialized an isolated fictional vault. CI now repeats install/version/init on Ubuntu. Not tested: a desktop session (browser opening and the app-menu entry) and real Linux AI apps. Packages are unsigned; an apt repository with a signing key can come later.

**Verified again 2026-10-28:** the current 1.2.8 source built all four x64/ARM64 tar and `.deb` artifacts in Debian 12 with Node.js 24.22.1. Their SHA-256 sidecars matched. In a disposable Debian container, the amd64 `.deb` install/version/init/remove flow and the x64 tarball per-user install/version/init/uninstall flow passed using a fictional vault. The ARM64 `.deb` declares `arm64` and contains an AArch64 Node runtime; it was not executed on this x64 host. The latest source, checksums, test counts and limits are recorded in [`docs/IMPLEMENTATION-STATUS.md`](../../docs/IMPLEMENTATION-STATUS.md). A real desktop session/menu launch and signed distribution remain release checks.

**Refreshed 2026-10-31 on source commit `4a8981c`:** all four unsigned 1.2.8 x64/ARM64 artifacts rebuilt in `node:24-bookworm`; every checksum passed. The amd64 `.deb` was extracted and its bundled runtime passed the staged MCP and private-note canary smoke. ARM64 artifacts were not run on ARM hardware. Outputs stayed in the disposable container and were not published.

`ar.mjs` writes the `.deb` container, because macOS's `ar` only handles object files.

