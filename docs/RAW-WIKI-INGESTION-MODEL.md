# Raw-to-Wiki knowledge flow: reference review

Status: daily/manual scans and local AI draft generation exist. The 2026-11-02 branch adds a second opt-in to save new, source-linked notes as `proposed` in a user-selected same-vault destination. The scanner supports Markdown, TXT, CSV/TSV, JSON, XML, YAML, LOG and selectable-text PDF up to 100 pages; PDF text extraction runs in a bounded local worker. Scanned-image PDFs, Office files, images, HTML and other formats need separate extraction support. Non-Markdown inputs do not support Markdown frontmatter privacy flags, so their privacy boundary is the explicitly selected non-private vault/folder plus exclusions. Agent reads use the exact queued source ID and revision. This is scheduled scanning, not a continuous file-system watcher. Reviewed from Ian's supplied reel transcript and seven selected stills.

## Main idea

Keep original material intact, then let BrainLink build a separate, linked, easier-to-retrieve knowledge layer from it. The reel calls these `Raw` and `Wiki`, and adds a generated index, an append-only processing log, and automatic processing after new material arrives. Its goal is that agents use a compact map and follow relevant links instead of rereading the whole archive for each question.

This is a useful product direction for BrainLink. It complements the typed graph model in [GRAPH-KNOWLEDGE-MODEL.md](GRAPH-KNOWLEDGE-MODEL.md): the Raw/Wiki flow describes how knowledge is curated; typed graph edges describe specific relationships between approved records.

## What BrainLink already has

- User-owned Obsidian/Markdown vaults remain the source of truth; BrainLink does not require a fixed folder layout.
- Search, source links, related-note suggestions, a generated `BrainLink/Home.md` map, and ordinary Markdown links provide parts of the map-and-follow-links experience.
- Privacy and exclusions are applied before indexing and retrieval. Sessions are private by default; closeout uses review and confirmation.
- Activity records, backups, and RSI proposals provide pieces of traceability and recovery.
- Typed graph relations exist when explicitly recorded and verified; automatic entity and relation extraction is not implemented.
- `ingestion_queue` scans one explicitly selected folder in a non-private vault and returns metadata for new or changed supported sources. Setup can schedule or manually scan up to 20 such vault/folder targets together. In Setup, users choose existing folders from a vault-scoped picker instead of typing paths; the picker omits the vault root, hidden/protected/excluded folders and private vaults. Every target is checked independently for vault privacy, exclusions, symlinks, and file bounds. Markdown privacy and generated markers are checked from bounded frontmatter before its body is read. Non-Markdown files are covered by the selected non-private vault/folder and path exclusions, because those formats do not have Markdown frontmatter privacy flags. Private, malformed, excluded and BrainLink-generated Markdown notes are skipped. PDFs are signature-checked during scanning and extracted only when the exact queued source is opened.
- `ingestion_record` appends a local receipt for `filed` or `skipped`. A `filed` receipt requires a saved same-vault Markdown note outside the source folder that links to the source. The journal stores opaque IDs, hashes, outcome, time, scope hash and client label; it stores no title, path, note body or prompt.
- Profile-scoped agents need `search` for queue access and a separate `propose_note` grant to record a filing result.
- The portable `brainlink-raw-to-wiki` Agent Skill gives compatible clients the same safe sequence: read only selected queue items, search for duplicates, preview a linked note, wait for approval, then record the filed/skipped receipt. Canonical and Claude/Codex discovery copies are tested for parity.
- Clients that support MCP prompts can use `organize-sources` with one exact vault/folder pair. It processes up to five candidates per run and is listed for a scoped agent only when every required read, search, proposal and receipt permission is granted. The prompt does not itself approve writes; each proposal needs separate user approval, and receipts follow confirmed saves. Local tests verify both availability with the full grant and denial when the proposal grant is removed (commit `800e4e4`).

These points are based on repository code and local tests. A daily background scan checks every configured folder at the chosen local time; a user can also run all configured targets from Setup. With local Ollama enabled, the scan can read and analyze up to five changed supported text sources. By default, results stay in a private local review queue. A separate auto-file option saves new linked notes to an existing destination chosen for each source folder. Those notes remain `proposed` with reported confidence; BrainLink never edits or replaces an existing note or promotes generated content to verified knowledge. The tested auto-file path applies to scheduled and manual scans; live Ollama quality and installed-user experience have not been verified.

## Proposed BrainLink flow

1. **Keep the source.** New files and session records stay in their original, user-controlled location. Never silently rewrite or delete them.
2. **Check scope first.** Before reading file contents, classify the selected vault/profile and apply privacy, exclusion, client, and authorization rules. Unclear ownership or scope means skip and ask for review.
3. **Process only changes.** Use a content hash and source ID to identify new or changed material; avoid rereading and re-summarizing unchanged files.
4. **Prepare proposals.** Suggest a destination, concise knowledge note, source citations, entities, and typed relationships. Mark confidence and uncertainty. Update an existing knowledge note only through a diff or reviewable proposal.
5. **Review and apply.** Let users inspect, edit, approve, reject, or roll back proposals. Any future unattended mode must be separately enabled, narrowly scoped, and reversible; it must not change access policy.
6. **Refresh derived views.** Rebuild the index/map and graph from approved notes. Keep them generated and reproducible rather than treating the index as a second source of truth.
7. **Write a minimal event receipt.** Record source ID/hash, action, result, destination, time, and agent identity where available. Do not copy private text, secrets, prompts, or raw transcript excerpts into logs.
8. **Serve compact context.** Retrieve from the approved knowledge layer first; follow only authorized links relevant to the question. Include citations and measure answer quality alongside actual token counts.

The `Raw` and `Wiki` labels should be optional logical areas or profile-selected folders, not a forced two-folder migration. Users may keep their existing Obsidian layout and choose which folders are original inputs and which are AI-maintained outputs.

## Automation boundary

The reel suggests a file-drop hook or overnight schedule. BrainLink has an opt-in **daily scan** for up to 20 selected folders and a manual **Scan now** action. It checks scope and exclusions before reading source content. Supported files are Markdown, TXT, CSV/TSV, JSON, XML, YAML, LOG and text-based PDF up to 100 pages. PDF text extraction is performed locally in a worker with memory, runtime, and output limits; scanned PDFs without selectable text are reported as requiring OCR. Non-Markdown files have no frontmatter privacy marker and are covered by the selected non-private vault/folder and exclusions. With local Ollama enabled, it can analyze up to five changed supported sources per scan. Auto-filing is a separate opt-in; each scan folder needs an existing destination in the same vault. Saved notes are new, linked, `proposed`, and unverified. The schedule runs only while BrainLink is open; enable launch at sign-in if scans should resume after login. A failed scheduled scan is retried twice, 15 minutes apart; after three total attempts it waits until the next scheduled day. Turning the schedule off pauses future runs, and a manual scan remains available. The app does not continuously watch file-system events or yet process Office files, images, HTML, or other unsupported formats.

## How to prove it helps

Use fictional Personal, Organisation, and Client data, including planted private notes. Compare a baseline search flow with Raw-to-Wiki processing on frozen questions. Report:

- correct answers and citation/source accuracy;
- input tokens, separating provider counts from local estimates;
- time to retrieve and amount of repeated source reading;
- duplicate, misplaced, stale, or unsupported claims;
- privacy leaks in search, summaries, graph expansion, handoffs, and logs;
- recovery after a rejected proposal or rollback.

Do not call it a token-saving improvement if token use falls while answer quality, source coverage, or privacy worsens. The supplied reel is a conceptual reference, not evidence that the creator's implementation achieves these outcomes.

## Decision and remaining work

The scanner reuses the existing vault, local AI draft, and note-writing tools; it creates no parallel memory store. Existing tested behavior includes multi-folder daily/manual scanning, bounded retries, a review queue, and read-only source viewing. Local Ollama analysis remains opt-in and capped at five changed supported sources per run; source content is checked for scope and revision, redacted, sent only to the loopback Ollama endpoint, and treated as untrusted input. PDF parsing happens locally in an isolated worker before optional local Ollama analysis. Drafts persist in private BrainLink app data without storing the original body. The new auto-file setting requires a selected destination for every target and saves only new linked notes as `proposed` with `confidence: reported`; tests confirm it does not overwrite existing files or mark generated knowledge verified. Live Ollama use, usability and quality evaluation, cross-client behavior, Office/image ingestion, continuous watching, OCR, and measured token/time savings remain open.
