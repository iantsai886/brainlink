# Windows build

## The zip release (recommended; no signing, no Windows needed to build)

`npm run build:win-zip` (needs internet access once, to download+checksum the official win-x64
Node runtime into `/workspace/brainlink-runs/node-rt`). Output: `dist/BrainLink-<version>-win.zip`
— unzip it and double-click `BrainLink.vbs` to start, no console window ever. Same install model as
the macOS zip: first double-click installs into `%LOCALAPPDATA%\BrainLink` and writes a
Startup-folder entry (`shell:startup`) that restarts the background Setup server at login — the
no-admin-needed stand-in for macOS's LaunchAgent. `Uninstall BrainLink.cmd` disconnects every AI
app, then removes the installed copy and the Startup entry; vault folders are never touched. See
`bin/brainlink.mjs`'s `win-start`/`win-uninstall` and `src/winapp.mjs` for the logic (tested on
Linux with an injected fake AppData).

Run `npm run test:win-zip` after building: unzips the archive, checks the file list (no
`src/license-key.mjs`, no secrets, launcher/uninstaller/README present), exercises the bundled
`src/winapp.mjs` install/uninstall logic against a fake AppData, and runs the bundled app with
this box's own Node (the bundled `node.exe` is a Windows PE binary and can't run here) to confirm
it actually boots and serves. Prints `WIN SELF-TEST PASSED`. What it can't check from Linux —
SmartScreen, the real folder picker, surviving an actual reboot, Task Manager — is
`packaging/windows/SMOKE-TEST.md`, a checklist for a real Windows PC.

## The signed installer (alternate path, for later)

Built on macOS with NSIS: `npm run build:win` (needs `brew install makensis`). Output in `dist/`:

- `BrainLink-Setup-<version>.exe`: per-user installer, no admin rights. Installs to `%LOCALAPPDATA%\Programs\BrainLink`, adds a Start-menu entry and the `brainlink` command (user PATH), and registers an uninstaller under Settings → Apps. The uninstaller first removes BrainLink from connected AI apps (`brainlink disconnect-all`). Settings in `%APPDATA%\BrainLink` and all notes are kept.
- `BrainLink-<version>-windows-x64.zip`: the same files, portable.

Bundles the official Node 22 `node.exe` (x64, checksum-verified against nodejs.org SHASUMS256). English and Traditional Chinese installer pages.

**Verified on macOS:** the installer compiles; the package layout; Windows line endings; and BrainLink's Windows logic, run in Windows mode in `npm test` (settings in `%APPDATA%`, Obsidian's settings file, every AI app's config path, one-click setup writing `node.exe` paths into Claude Desktop and Codex configs, and disconnect).

**Not yet verified:** running the installer on a real Windows 10/11 PC. Checklist: install → Setup opens → "I don't have notes yet" → Claude Desktop connected → in Claude, "Connect to my brain" → "Close loop" writes a capture → Settings → Apps → Uninstall.

On Windows, Claude Code is connected by editing `%USERPROFILE%\.claude.json` (with a backup), because Node can't safely run the `claude.cmd` shim without a shell.

Signing: without Authenticode, SmartScreen warns on first run. Use Azure Trusted Signing or an OV/EV certificate and set `WINDOWS_SIGN_CMD` (see build-windows.sh). `build-windows.ps1` plus `BrainLink.iss` (Inno Setup) remain as an alternative for building on Windows itself.
