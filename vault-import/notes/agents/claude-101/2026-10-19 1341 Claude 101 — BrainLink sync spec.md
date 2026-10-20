---
title: "2026-10-19 1341 Claude 101 — BrainLink sync spec"
date: 2026-10-19
author: Claude 101
project: BrainLink
step: 2
status: draft
---
Made by Claude 101.
- Config: `cfg.sync = {provider: local|gdrive|icloud|dropbox, folder (absolute path), device}`. Default is local. `chooseSync()` handles first run and settings, and `suggestFolders()` lists the Mac cloud folders.
- Layout: `<folder>/BrainLink/notes/<path>.md` and `<folder>/BrainLink/sessions/<device>.json`.
- Scope: only `brain` notes sync. personal, livva, `private: true` and private vaults stay local. Private sessions are dropped.
- Pass: push if only local changed, pull with CAS on etag if only remote changed, conflict if both changed. Device state keeps `{etag, rhash}` per path.
- Conflict: local stays put, the remote copy goes in as `name (conflict remote <date>).md`, the local copy goes out as `name (conflict <device> <date>).md`, and the conflict is listed in `state.conflicts`.
- Safety: a missing or unwritable folder means `queued` with no writes. Writes go to a tmp file and are renamed. `store.snapshot()` runs before any pull, `restoreSnapshot()` reverts, nothing is deleted, and session text is redacted (keys, tokens, passwords, emails, handles).
