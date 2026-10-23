/**
 * BrainLink store contract v0.2 (canonical; Node ESM, node>=22). Obsidian-independent data layer.
 * Made by Claude 886, 2026-10-19. Reference impl: memory-store.mjs (createMemoryStore). Planned: SQLite + .md mirror.
 * Rules: every note write is compare-and-swap on `etag`; history is append-only (nothing hard-deleted);
 * ids never change; private vaults are local-only (never synced, never served to a remote caller).
 * Changes to this file go through a version bump (STORE_CONTRACT_VERSION) only. No forks.
 */

export declare const STORE_CONTRACT_VERSION: '0.2';

/** Vault config as in BrainLink v1.1 config.json (`vaults[]`): generic, nothing user-specific in code. */
export interface VaultInfo { name: string; private: boolean; }
/**
 * Who is calling. remote=true (HTTP/tunnel/sync to cloud) never sees private vaults (E_PRIVACY).
 * `vaults` limits the call to these vault names (per-connection vault scope). Default: all vaults allowed for the caller.
 */
export interface Access { vaults?: string[]; remote?: boolean; }

export type ChangeKind = 'create' | 'update' | 'rename' | 'supersede' | 'delete' | 'revert'
  | 'session_upsert' | 'session_append';
export type LinkKind = 'link' | 'embed';

/** Brain standard keys are preserved and type-checked (string | string[]); any other key passes through untouched. */
export declare const BRAIN_STANDARD_KEYS: readonly ['type', 'status', 'owner', 'ai_platform', 'agent_or_role',
  'session_or_task_id', 'written_at', 'source', 'confidence', 'tags', 'aliases'];
export type Frontmatter = Record<string, unknown>;

export interface Note {
  /** Stable id `n_<base32>`. Never changes on rename/move/supersede/import. */
  id: string;
  vault: string;
  /** Current vault-relative path, e.g. "Projects/Plan.md". Changes on rename. */
  path: string;
  title: string;
  frontmatter: Frontmatter;
  body: string;
  /** 1-based, monotonic per note. */
  version: number;
  /** sha256 hex of canonical {path, frontmatter, body, deleted, superseded_by, superseded_at} (content hash: a revert to identical content gives the old etag again, which is benign). Pass as expected_etag on the next write. */
  etag: string;
  updated_at: string;
  author: string;
  superseded_by: string | null;
  superseded_at: string | null;
  deleted: boolean;
  /** sha256 of attachment blobs this note embeds. */
  attachments: string[];
}
export type NoteSummary = Pick<Note, 'id' | 'vault' | 'path' | 'title' | 'version' | 'etag' | 'updated_at'> & { superseded: boolean; deleted: boolean };
export interface NoteVersion { note_id: string; version: number; etag: string; kind: ChangeKind; at: string; author: string; path: string; }
/** Wikilink/embed resolved by id. target_id null = unresolved; it resolves automatically when a matching note appears. */
export interface Link { src_id: string; target_id: string | null; target_text: string; kind: LinkKind; heading: string; }
export interface Attachment { sha256: string; name: string; mime: string; size: number; }

export interface ChangeEvent {
  /** Global monotonic sequence. */
  seq: number; kind: ChangeKind; vault: string;
  /** note id, or session id for session_* kinds. */
  id: string; version: number; etag: string; path: string; old_path?: string; at: string;
}
export interface ChangePage { events: ChangeEvent[]; cursor: string; has_more: boolean; }
export interface Snapshot { id: string; label: string; at: string; seq: number; note_count: number; }
export interface WriteResult { id: string; version: number; etag: string; path: string; seq: number; }

/** A unified search hit over notes (and, with includeSessions, sessions). sha12 = first 12 hex of the item's etag: a short citeable reference. */
export interface SearchHit { id: string; title: string; snippet: string; score: number; sha12: string; }

/**
 * One AI session (imported from a client's local history, or logged via session_log).
 * `private` is independent of vault privacy (a session in a non-private vault can still be marked
 * private, e.g. an importer's default). Store default is `false`; importers set it explicitly.
 */
export interface Session {
  /** Stable id `s_<sha256(client + ':' + source_id) first 16 hex>`; importers re-running are idempotent. */
  id: string;
  /** e.g. 'claude-code' | 'codex' | 'cursor' | 'claude-desktop' | 'gemini-cli' | 'windsurf' | 'chatgpt' | 'other'. */
  client: string;
  source_id: string;
  /** Vault the session belongs to (private vault => local-only session). */
  vault: string;
  /** Project / working-directory label from the client's own history (e.g. a repo path or folder name); '' if unknown. */
  project: string;
  title: string;
  /** <= ~60 tokens; what session_list/search return. */
  summary: string;
  started_at: string; updated_at: string;
  message_count: number;
  /** Paths/ids of notes the session read or wrote (cross-links sessions <-> brain). */
  note_refs: string[];
  /** Per-session privacy, on top of vault privacy. Remote callers never see private=true sessions. Default false. */
  private: boolean;
  etag: string;
}
export interface SessionMessage { seq: number; role: 'user' | 'assistant' | 'tool' | 'note'; at: string; text: string; }
export interface SessionPage { session: Session; messages: SessionMessage[]; next_offset: number | null; }
/** Lean projection of Session: the shape sync and session_list carry around (docs/SESSION-INDEX.md in brainlink-src). `turns` = message_count. */
export type SessionRecord = { id: string; client: string; project: string; started_at: string; turns: number; summary: string; private: boolean };

export interface BrainStore {
  vaults(): VaultInfo[];

  /**
   * Reference search only (used by mocks/tests and as a fallback). Real deployments must route
   * ranking through BrainLink core (src/core.mjs searchIndex) and map results into this shape —
   * search is tuned in ONE place, never here. `scope` limits to one vault; `includeSessions` adds
   * session title/summary matches (subject to the same privacy rules as listSessions).
   */
  search(query: string, opts?: Access & { limit?: number; scope?: string; includeSessions?: boolean }): Promise<SearchHit[]>;

  // ---------- notes ----------
  /** By id, or `${vault}:${path}`. `version` reads history. Superseded/deleted stay readable by id. E_NOT_FOUND, E_PRIVACY. */
  read(ref: string, opts?: Access & { version?: number }): Promise<Note>;
  /** Paged by path (`after` = last path seen). Excludes superseded/deleted unless asked. */
  list(opts?: Access & { vault?: string; folder?: string; include_superseded?: boolean; include_deleted?: boolean; limit?: number; after?: string }): Promise<NoteSummary[]>;
  history(id: string, opts?: Access): Promise<NoteVersion[]>;
  /**
   * Create: expected_etag === '' and path free in that vault. Update: expected_etag === current etag (pass `id`).
   * E_CONFLICT {current_etag}, E_INVALID, E_SUPERSEDED {superseded_by}, E_PRIVACY, E_READ_ONLY.
   * NOTE: MCP AI writes stay new/append-only (v1.1 policy); update/rename/delete are for UI, sync and import.
   */
  write(input: { vault: string; path: string; body: string; frontmatter?: Frontmatter; author?: string; id?: string },
        opts: Access & { expected_etag: string; allow_superseded?: boolean }): Promise<WriteResult>;
  /** Id unchanged; links resolve by id so backlinks survive. E_CONFLICT, E_INVALID (path taken). */
  rename(id: string, new_path: string, opts: Access & { expected_etag: string }): Promise<WriteResult>;
  /** Dated supersede: old gets superseded_by=new_id, superseded_at=at|now. Old id stays readable. */
  supersede(old_id: string, new_id: string, opts: Access & { expected_etag: string; at?: string }): Promise<WriteResult>;
  /** Soft delete (tombstone version). Undo with revert(). */
  delete(id: string, opts: Access & { expected_etag: string }): Promise<WriteResult>;
  /** Undo = a NEW version equal to the target version or the note's state in a snapshot. History never rewritten. */
  revert(id: string, opts: Access & { expected_etag: string; to_version?: number; to_snapshot?: string }): Promise<WriteResult>;

  // ---------- links ----------
  /** Outgoing [[x]], [[x|alias]], [[x#heading]], ![[x]] (embed), resolved by path, then title/alias. */
  links(id: string, opts?: Access): Promise<Link[]>;
  backlinks(id: string, opts?: Access): Promise<Link[]>;

  // ---------- attachments ----------
  /** Content-addressed + idempotent: same bytes => same sha256, stored once. */
  putBlob(data: Uint8Array, meta: { name: string; mime?: string }): Promise<Attachment>;
  getBlob(sha256: string): Promise<Uint8Array>;

  // ---------- change events (index + sync + UI consume these) ----------
  /** Poll: cursor '' = from start. Events for vaults the caller can't see are filtered. E_CURSOR if pruned. */
  changes(cursor?: string, opts?: Access & { limit?: number }): Promise<ChangePage>;
  /** Push over the same log; returns unsubscribe. */
  subscribe(fn: (e: ChangeEvent) => void, opts?: Access): () => void;

  // ---------- snapshots ----------
  /** Cheap: records seq + each note's current version (no copy of bodies). */
  snapshot(label?: string): Promise<Snapshot>;
  snapshots(): Promise<Snapshot[]>;

  // ---------- sessions ----------
  /** Importer upsert (idempotent by client+source_id). Text MUST already pass the secret filter; E_INVALID if a secret is found. */
  putSession(input: Omit<Session, 'id' | 'etag' | 'message_count' | 'updated_at'> & { messages: Omit<SessionMessage, 'seq'>[] }, opts?: Access): Promise<Session>;
  /** session_log: append messages to a session (creates it if new). Secret-filtered. */
  appendSession(id_or_input: string | { client: string; source_id: string; vault: string; title?: string }, messages: Omit<SessionMessage, 'seq'>[], opts?: Access): Promise<Session>;
  /** Summary-first, newest first. `q` = keyword filter over title+summary. */
  listSessions(opts?: Access & { client?: string; vault?: string; q?: string; since?: string; limit?: number }): Promise<Session[]>;
  /** Paged messages; default returns summary + last 0 messages unless limit>0. */
  readSession(id: string, opts?: Access & { offset?: number; limit?: number }): Promise<SessionPage>;
  /** Toggle per-session privacy (see Session.private). E_NOT_FOUND, E_PRIVACY, E_READ_ONLY. */
  setSessionPrivate(id: string, isPrivate: boolean, opts?: Access): Promise<Session>;
}

export declare function createMemoryStore(opts: {
  vaults: VaultInfo[]; readOnly?: boolean; clock?: () => string; logRetention?: number;
}): BrainStore;
export declare function parseLinks(body: string): Array<Pick<Link, 'target_text' | 'kind' | 'heading'>>;
/** Same patterns as v1.1 core findSecrets(); returns matched kinds, never the secret text. */
export declare function findSecretKinds(text: string): string[];
export declare function etagOf(n: Pick<Note, 'path' | 'frontmatter' | 'body' | 'deleted'>): string;
/** Session -> SessionRecord projection (id, client, project, started_at, turns, summary, private). */
export declare function toSessionRecord(session: Session): SessionRecord;
