---
type: spec
status: proposed
owner: Claude 886
ai_platform: Grok Bot
agent_or_role: Claude 886
session_or_task_id: brainlink-step1-2026-10-19
written_at: 2026-10-19T13:44:42+08:00
source: "Ian via Paulo 2026-10-19 (Step 1 + MCP addendum); PRODUCT-SPEC v1; joint plan 2026-10-19; box contract commit d8e792b"
confidence: medium
tags: [brainlink, storage, contract, spec]
aliases: [BrainLink Storage Interface v0.1, BrainLink store contract]
---
Made by Claude 886.

# BrainLink — Storage Interface v0.1

**Purpose:** BrainLink keeps its own store (notes, links, frontmatter, attachments, index feed, history, sessions) so it works without Obsidian installed. Obsidian folders are import/export. Sync (Claude 101) and UI (ChatGPT 886) build against this contract only.

**Canonical contract (box):** `/workspace/brainlink-store` commit `d8e792b`: `interface.d.ts` (JSDoc), `errors.mjs`, `memory-store.mjs` (`createMemoryStore`, reference impl), `contract-tests.mjs` (`runStoreContract(makeStore)`, 16/16 pass). Changes = `STORE_CONTRACT_VERSION` bump only, no forks.

## 1. Model
- **Note**: `id` (`n_…`, stable across rename/move/supersede/import), `vault`, `path` (vault-relative), `title`, `frontmatter` (schema-free map; Brain standard keys type-checked as string | string[]), `body`, `version` (1,2,3…), `etag` (sha256 of canonical content), `superseded_by/at`, `deleted`, `attachments[]`.
- **Vaults** come from v1.1 `config.vaults[]` `{name, private}`. No vault names in code. Brain / Personal / Livva are just config entries; private ⇒ local-only.
- **Access** on every call: `{vaults?, remote?}`. `remote` (HTTP, tunnel, cloud sync) never sees private vaults → `E_PRIVACY`. `vaults` = per-connection scope.
- **Session**: `id = s_ + sha256(client:source_id)[:16]` (idempotent re-import), `client`, `vault`, `title`, `summary` (≤60 tok), times, `message_count`, `note_refs[]`; messages paged.

## 2. Operations (all async)
| Group | Calls |
|---|---|
| Read | `read(ref, {version?})` (ref = id or `vault:path`), `list({vault, folder, include_superseded, include_deleted, limit, after})`, `history(id)` |
| Write (CAS) | `write({vault,path,body,frontmatter,id?}, {expected_etag})` ('' = create), `rename`, `supersede(old,new,{at})`, `delete` (soft), `revert({to_version | to_snapshot})` |
| Links | `links(id)` (outgoing), `backlinks(id)` |
| Blobs | `putBlob(bytes,{name,mime})` → `{sha256,…}` (idempotent), `getBlob(sha256)` |
| Events | `changes(cursor,{limit})` → `{events,cursor,has_more}`; `subscribe(fn)` → unsubscribe |
| Snapshots | `snapshot(label)`, `snapshots()` |
| Sessions | `putSession`, `appendSession`, `listSessions({client,vault,q,since,limit})`, `readSession(id,{offset,limit})` |

**Rules.** Every note write is compare-and-swap on `etag`; a stale etag → `E_CONFLICT {current_etag}`. Sync then re-reads, merges or keeps both copies (Claude 101's policy), and retries once. History is append-only: delete = tombstone version; undo = `revert` writes a NEW version equal to the target, so nothing is rewritten. **Dated supersede** sets `superseded_by` + `superseded_at` (ISO); the old id stays readable, is hidden from `list` by default, and refuses edits (`E_SUPERSEDED`). Snapshots are cheap (seq + per-note version map) and are taken before sync and import. Store-level update/rename/delete are for UI, sync and import. **MCP AI writes stay new/append-only**, the v1.1 policy, enforced in the MCP layer.

## 3. Errors
`E_NOT_FOUND · E_CONFLICT{current_etag} · E_INVALID · E_PRIVACY · E_SUPERSEDED{superseded_by} · E_READ_ONLY · E_SNAPSHOT · E_CURSOR{oldest_seq}` (cursor pruned → full resync). `err.toJSON()` = `{error, message, …detail}`.

## 4. Examples
```json
{"call":"write","input":{"vault":"Work","path":"Garden/Trellis.md","body":"Use twine.","frontmatter":{"type":"idea"}},"opts":{"expected_etag":""}}
→ {"id":"n_…","version":1,"etag":"9f2…","path":"Garden/Trellis.md","seq":12}
{"call":"write","input":{"id":"n_…","vault":"Work","path":"Garden/Trellis.md","body":"Use jute."},"opts":{"expected_etag":"stale…"}}
→ {"error":"E_CONFLICT","current_etag":"9f2…"}
{"call":"supersede","old":"n_a","new":"n_b","opts":{"expected_etag":"…","at":"2031-03-01T09:00:00+08:00"}}
{"call":"revert","id":"n_a","opts":{"expected_etag":"…","to_snapshot":"snap_…"}}
{"call":"changes","cursor":"12","opts":{"limit":200}} → {"events":[{"seq":13,"kind":"rename","vault":"Work","id":"n_…","old_path":"a.md","path":"b.md"}],"cursor":"13","has_more":false}
{"call":"readSession","id":"s_…","opts":{"limit":0}} → {"session":{"title":"…","summary":"…"},"messages":[],"next_offset":null}
```

## 5. On-disk layout (SQLite store, next step)
`<appHome>/store/brainlink.db` (tables: notes, versions, links, events, snapshots, snapshot_items, sessions, session_msgs, blobs_meta) + `store/blobs/ab/<sha256>` + a plain `.md` mirror per vault.
**Why:** `node:sqlite` is built into the Node 22 runtime we bundle, so the core stays zero-dependency. Pin Node ≥22.13 so no flag is needed. SQLite gives one ACID file with WAL that any language or AI tool can open. The .md mirror keeps notes human- and AI-readable with no BrainLink at all. Box note: the box has Node 20; the SQLite impl will be tested on Node 22.

## 6. Obsidian import/export
- Import walks the folder and skips `.obsidian/` and other dot-folders.
- `.md` → note: YAML frontmatter → map, path kept. The id comes from the frontmatter `brainlink_id` if present; otherwise a new id is minted and recorded in the store only. Vault files are never edited on import.
- `[[x]]`, `[[x|a]]` and `[[x#h]]` become links resolved by path, then title, then alias; unresolved links are kept and resolve later. `![[file.png]]` becomes a blob plus an embed link. Folders become path prefixes.
- Export writes `.md` with the frontmatter and wikilinks as stored, and attachments under their original names. Ids are written only if the user opts in.
- Re-import is hash-based. External edits become a CAS write with author `external`, after a snapshot is taken first.

## 7. Index hook
- The store emits change events. The v1.1 core (`loadVault`/`buildIndex`/`searchIndex`) reads notes from the store and updates incrementally from `changes(cursor)`.
- **Search is tuned in ONE place: the Mac v1.1 core.** The box brain_mcp track is frozen, per the joint plan. The store does no ranking.
- Embeddings: bge-m3 via Ollama behind `semantic: "bge-m3"`, off by default, with vectors cached per chunk hash. Embeddings only re-rank; the answer format is unchanged, so tokens per answer stay ≤ ~1,050.

## 8. Conflicts with source docs (for Ian/Paulo)
1. The addendum names brain_search/brain_read/brain_write, but PRODUCT-SPEC §4 says tool names stay the same. Proposal: keep the v1.1 names and add only `session_*`.
2. PRODUCT-SPEC §9 lists "Out of v1: embeddings, Team sync", while the plan adds sync and bge-m3. The plan supersedes it; both stay opt-in, default off and local-only.
3. Task brief: search is tuned in box brain_mcp v0.5. Joint plan: search is tuned only in the Mac core. Followed the joint plan.
4. Store-level edit/delete vs. "Old notes are never edited" (§4b): allowed for the user/UI/sync only. The AI MCP surface stays append/new.

## Changelog
- 2026-10-19 v0.1: created. Node contract d8e792b, 16/16 contract tests.

## Related
- BrainLink build plan 10dqy8BVJPvRhYBqL-JI9t6YiI4Jh0nHT · competitor study 1vnxtuRSoBRYOUuk_6DDCs2MmavPCd4z2 · joint plan 1MWnISJ2aBGK5h8xPVIXruaMT7PxEEYiG · PRODUCT-SPEC 1xhj5UJIjPUyUyMgwTyiutdX3niOf_Hzn
