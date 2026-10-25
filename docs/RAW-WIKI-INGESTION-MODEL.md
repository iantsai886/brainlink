# Raw-to-Wiki knowledge flow: reference review

Status: the manually triggered and daily scheduled source scan are implemented and locally tested. Setup provides the scan settings, last-run status, and manual queue view; each result opens in the existing read-only note viewer. The scheduled scan runs at a user-selected local time while BrainLink is running; the existing launch-at-sign-in option can start it after login. Scans detect eligible new/changed Markdown and prepare a review queue. They do not summarize with an AI or file knowledge unattended. Reviewed on 2026-10-25 from Ian's supplied 167-second reel transcript and seven selected stills in `C:\Users\iants\OneDrive\Documents\deepseek-harness\default-workspace\media\`.

## Main idea

Keep original material intact, then let BrainLink build a separate, linked, easier-to-retrieve knowledge layer from it. The reel calls these `Raw` and `Wiki`, and adds a generated index, an append-only processing log, and automatic processing after new material arrives. Its goal is that agents use a compact map and follow relevant links instead of rereading the whole archive for each question.

This is a useful product direction for BrainLink. It complements the typed graph model in [GRAPH-KNOWLEDGE-MODEL.md](GRAPH-KNOWLEDGE-MODEL.md): the Raw/Wiki flow describes how knowledge is curated; typed graph edges describe specific relationships between approved records.

## What BrainLink already has

- User-owned Obsidian/Markdown vaults remain the source of truth; BrainLink does not require a fixed folder layout.
- Search, source links, related-note suggestions, a generated `BrainLink/Home.md` map, and ordinary Markdown links provide parts of the map-and-follow-links experience.
- Privacy and exclusions are applied before indexing and retrieval. Sessions are private by default; closeout uses review and confirmation.
- Activity records, backups, and RSI proposals provide pieces of traceability and recovery.
- Typed graph relations exist when explicitly recorded and verified; automatic entity and relation extraction is not implemented.
- `ingestion_queue` scans one explicitly selected folder in a non-private vault and returns metadata for new or changed Markdown. It checks exclusions, symlinks, file bounds, and note privacy from a bounded frontmatter read before reading a body. Private, malformed, excluded and BrainLink-generated notes are skipped.
- `ingestion_record` appends a local receipt for `filed` or `skipped`. A `filed` receipt requires a saved same-vault Markdown note outside the source folder that links to the source. The journal stores opaque IDs, hashes, outcome, time, scope hash and client label; it stores no title, path, note body or prompt.
- Profile-scoped agents need `search` for queue access and a separate `propose_note` grant to record a filing result.

These points are based on repository code and local tests. A daily background scan checks the selected folder at the chosen local time; a user can also run a scan from Setup or ask an AI client to scan a named folder. The scheduler detects changes and updates status, but does not read full bodies to summarize them. The AI client reads selected source notes, writes a proposal through BrainLink's existing preview-and-confirm flow, and records the result afterward.

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

The reel suggests a file-drop hook or overnight schedule. BrainLink currently has an opt-in **daily scan** for one selected folder and a manual **Scan now** action. It checks scope and privacy before reading a bounded frontmatter header, then reports changed-file metadata in the review queue. Processing and writing stay distinct. The schedule only runs while BrainLink is open; enable launch at sign-in if daily scans should resume after login. Automatic changes to trusted facts, permissions, or existing notes require an explicit policy and an audit trail. Preserve pause, retry, failure, and rollback states.

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

Adopt the Raw-to-Wiki pipeline as a product direction. The scanner uses BrainLink's existing vault and note-proposal tools; it does not create a parallel memory store. The current daily/manual scan and queue are implemented. A live OS-startup acceptance check, richer pause/retry controls, AI-assisted summarization, safe proposed linking, and token/quality measurement remain. Keep automatic note writing off until privacy, source links, rollback, and token/quality evaluation pass. No token savings or unattended filing are claimed.
