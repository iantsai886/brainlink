# Windows smoke test (needs a real Windows 10/11 PC)

Everything below could not be verified on the Linux box this zip was built on. Run through it
once per release before calling the Windows build done.

1. **Download & unzip.** Unzip `BrainLink-<version>-win.zip` into Downloads (or anywhere). You
   should see a `BrainLink` folder containing `BrainLink.vbs`, `Uninstall BrainLink.cmd`,
   `READ ME FIRST.txt`, `node\`, `app\`, `bin\`.
2. **Double-click start, no console window.** Double-click `BrainLink.vbs`.
   - Windows SmartScreen may show "Windows protected your PC" (unsigned app) — click "More info",
     then "Run anyway".
   - No console/terminal window should ever appear.
   - Your default browser should open automatically to the BrainLink dashboard within a few
     seconds.
3. **Installed location.** Open `%LOCALAPPDATA%\BrainLink` in File Explorer's address bar — it
   should contain `app\`, `node\`, `BrainLink.vbs`, `Uninstall BrainLink.cmd`,
   `READ ME FIRST.txt`.
4. **Startup-folder entry.** Press Win+R, type `shell:startup`, Enter — it should contain
   `BrainLink.vbs`. Open it in Notepad and confirm it points at
   `%LOCALAPPDATA%\BrainLink\node\node.exe` and `...\app\bin\brainlink.mjs`.
5. **Survives a reboot.** Restart Windows, log back in, wait ~10 seconds, then open
   `http://127.0.0.1:47800/` in a browser — the dashboard should load with no need to double-click
   anything (the Startup entry restarted the background service). No console window appeared at
   login either.
6. **Folder picker is native.** In the dashboard, "Add vault" → the folder picker should be the
   normal Windows folder-browser dialog (not a typed path, not a web `<input type=file>` picker).
   Pick a real folder with a few `.md` files in it.
7. **Multiple vaults.** Add a second vault (a different folder). Confirm both show up, you can
   switch which one is active, and each one's note count matches what's actually in that folder.
8. **Disconnect / remove a vault.** Disconnect one of the two vaults from the dashboard; confirm
   it's gone from the list and its files on disk are untouched.
9. **3D graph, click to edit.** Open the 3D notes graph, click a node, edit its content in the
   side panel, save. Reopen the note (from the graph or the file itself) and confirm the edit
   stuck, and that a backup of the previous version exists under
   `%APPDATA%\BrainLink\note-edit-backups\`.
10. **No trial, nothing expires.** Confirm there is no trial banner, countdown, licence-key field,
    or "upgrade" prompt anywhere in the UI — every feature (multiple vaults, 3D graph, agents) is
    available immediately.
11. **Re-opening is idempotent.** Double-click `BrainLink.vbs` again — it should detect BrainLink
    is already running and just open the dashboard, not install a second copy or spawn a second
    background process (check Task Manager: only one `node.exe` for BrainLink).
12. **Uninstall.** Double-click `Uninstall BrainLink.cmd` (in either the original unzipped folder
    or `%LOCALAPPDATA%\BrainLink`). Confirm:
    - `%LOCALAPPDATA%\BrainLink` is gone.
    - `shell:startup`'s `BrainLink.vbs` is gone.
    - The vault folders themselves (your actual notes) are untouched.
    - No administrator prompt (UAC) ever appeared, for install or uninstall.

Not covered above, and also worth a once-per-release check if time allows: connecting a real AI
app (Claude Desktop, Codex) from the dashboard's Connect buttons, and confirming disconnect-all
(run automatically by step 12) actually removed BrainLink's entry from that app's own config file.
