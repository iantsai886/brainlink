# Windows build

Built on macOS with NSIS: `npm run build:win` (needs `brew install makensis`). Output in `dist/`:

- `BrainLink-Setup-<version>.exe`: per-user installer, no admin rights. Installs to `%LOCALAPPDATA%\Programs\BrainLink`, adds a Start-menu entry and the `brainlink` command (user PATH), and registers an uninstaller under Settings → Apps. The uninstaller first removes BrainLink from connected AI apps (`brainlink disconnect-all`). Settings in `%APPDATA%\BrainLink` and all notes are kept.
- `BrainLink-<version>-windows-x64.zip`: the same files, portable.

Bundles the pinned official Node 24.22.1 `node.exe` (x64, checksum-verified against the matching nodejs.org SHASUMS256 manifest). The pin is in `vendor/node/VERSION`; the build scripts fetch the official manifest and runtime when they are absent. English and Traditional Chinese installer pages.

**Verified locally:** the pinned Node 24.22.1 Windows archive matches the official SHA-256 manifest and runs. The GitHub Actions job compiles the installer on Windows and uploads an unsigned artifact; the first remote run is pending. Earlier package-layout and Windows-mode logic checks are recorded in the main implementation status.

GitHub Actions builds the unsigned installer and retains it as a short-lived workflow artifact. **Not yet verified:** running the installer on a real Windows 10/11 PC. Checklist: install → Setup opens → "I don't have notes yet" → Claude Desktop connected → in Claude, "Connect to my brain" → "Close loop" writes a capture → Settings → Apps → Uninstall.

On Windows, Claude Code is connected by editing `%USERPROFILE%\.claude.json` (with a backup), because Node can't safely run the `claude.cmd` shim without a shell.

Signing: without Authenticode, SmartScreen warns on first run. Use Azure Trusted Signing or an OV/EV certificate and set `WINDOWS_SIGN_CMD` (see build-windows.sh). `build-windows.ps1` plus `BrainLink.iss` (Inno Setup) remain as an alternative for building on Windows itself.

## Installed-app smoke test (Windows / Inno Setup)

After `packaging/windows/build-windows.ps1` creates `build/windows/stage`, run `npm run smoke:installed:win`. The script compiles a separate QA installer with its own Inno Setup app ID and shortcut names, installs it under a temporary folder, reads and starts the installed Start menu shortcut's configured launcher and arguments, checks Setup health and its authenticated UI on a free loopback port, then uninstalls it. The launcher only honors `BRAINLINK_SETUP_PORT` when it contains a valid port and `BRAINLINK_NO_OPEN=1` for isolated testing; normal launches still use the default port and open Setup in the browser. The test verifies the QA shortcuts are removed, the pre-test user PATH is restored, and files in the isolated BrainLink data folder survive uninstall. It refuses to replace existing QA shortcuts. A successful run removes its temporary test files; failures leave logs in a named temporary folder. The QA app registration is separate from a normal BrainLink installation.

This smoke checks the installed Inno Setup package path. It does not test Authenticode, SmartScreen reputation, Windows upgrades over a prior customer install, or human usability. The normal installer remains unsigned until signing is configured.
