# Installing an unsigned BrainLink.pkg (macOS 15+)

This build has no Apple Developer ID yet (`DEVELOPER_ID_INSTALLER` / `DEVELOPER_ID_APP` unset in
`build-pkg.sh`), so Gatekeeper blocks it on first try. That's expected — do this once:

1. Double-click `BrainLink-<version>.pkg`. macOS 15 (Sequoia) and later show:
   **"Apple could not verify ... is free of malware"** with only a **Done** button (no "Open
   Anyway" here — that option moved).
2. Click **Done** to dismiss it.
3. Open **System Settings → Privacy & Security**. Scroll to the **Security** section near the
   bottom — you'll see: *"BrainLink-\<version\>.pkg was blocked to protect your Mac."*
4. Click **Open Anyway**, authenticate (Touch ID / password), then double-click the `.pkg` again.
   It now installs normally (component signature is still only ad-hoc, so you won't see a
   publisher name — that's expected for an unsigned build).

If step 3 doesn't show the installer (some macOS 15 builds only list blocked items for a short
window after step 2), use the command-line fallback instead of waiting:

```sh
xattr -d com.apple.quarantine ~/Downloads/BrainLink-<version>.pkg
```

Then double-click the `.pkg` again — with no quarantine flag, Gatekeeper's installer check is
skipped entirely.

## After installing

- `brainlink` is linked into `/usr/local/bin`. **Open a new Terminal window** (one already open
  from before the install won't have picked it up yet) and run `brainlink status`.
- If `brainlink: command not found` persists in a fresh window, check Console.app (or
  `/var/log/install.log`) for `BrainLink postinstall: could not link the brainlink command` — that
  means `/usr/local/bin` couldn't be created/linked for some reason; the app itself still works
  from Launchpad/Finder regardless.
- BrainLink.app itself (`/Applications/BrainLink.app`) was placed by the installer, not
  downloaded directly, so it does not carry a quarantine flag and opens without a second
  Gatekeeper prompt.

## Once there's a Developer ID

Set `DEVELOPER_ID_APP`, `DEVELOPER_ID_INSTALLER` and (for full notarisation) `NOTARY_PROFILE`
before running `npm run build:mac` (see the top of `build-pkg.sh`). A notarised, Developer-ID
signed `.pkg` skips all of the above — it opens on a fresh Mac with no warning at all.
