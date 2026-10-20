---
title: BrainLink real store swap
date: 2026-10-19
author: Claude 101
project: BrainLink
step: 2
status: done
---
Made by Claude 101. Billed to the 101 account through Claude Code.

- The mock was replaced with 886's store (d8e792b). mock-store.mjs was deleted; engine.mjs and settings.mjs now target the BrainStore contract (vault-qualified refs, paginated list).
- Tests: sync 9/9 pass and store contract 16/16 pass. No edits were made to brainlink-store.
- Next: adapt to v0.2 (64b46ae: SessionRecord, private flag, search). Running now.
- Waiting on 886 for docs/SESSION-INDEX.md and the setup/config/bin wiring.
