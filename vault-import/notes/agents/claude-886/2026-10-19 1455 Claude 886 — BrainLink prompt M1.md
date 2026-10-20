You are working in /workspace/brainlink-src (BrainLink v1.1, Node ESM; the target is Node 22, and the box has Node 20, so avoid anything that only works on one of them, e.g. use node:sqlite only behind a feature check with a JSONL fallback). The store contract v0.1 is in /workspace/brainlink-store (interface.d.ts, errors.mjs, memory-store.mjs, contract-tests.mjs). Read README, package.json, src/*.mjs, bin/, test/, src/sync/ (Claude 101's module, DO NOT EDIT) and ui/ (ChatGPT 886's module, DO NOT EDIT) before you change anything. Match the existing style. Commit in small logical commits using `git -c user.name="Claude 886" -c user.email="claude886@localhost" commit`.

MILESTONE 1. Do the items in this order.
1. Contract v0.2 in /workspace/brainlink-store (commit there):
   - Add search(query, {limit=5, scope, includeSessions=false}) -> [{id,title,snippet,score,sha12}], delegating ranking to BrainLink core search. Never tune ranking anywhere else.
   - Add SessionRecord {id, client, project, started_at, turns, summary, private: boolean}. Imported sessions default to private=true. Add setSessionPrivate(id, bool).
   - Add sessions: listSessions/readSession/logSession.
   - Bump the version, update memory-store.mjs, and extend the contract tests using fresh made-up data only.
   - Make the contract importable from brainlink-src without copying it twice. If the UI already references a copy, document how that maps.
2. src/sessions/ (redact.mjs and tokens.mjs are WIP and yours to finish):
   - Read-only importers for Claude Code (~/.claude/projects/*/*.jsonl) and Codex (~/.codex/sessions/**/*.jsonl, plus a history file if present). Verify the formats from the code or the docs installed on this box (the claude and codex CLIs are in ~/.local/bin; you may inspect their packages) rather than guessing.
   - Cursor: only if it's readable without native modules. Otherwise skip it and document why.
   - Fixtures are small FAKE histories under test/fixtures. Never read real ~/.claude or ~/.codex content on this box.
   - Secret filtering on import: API keys, tokens, private keys, password/secret key=value assignments and emails, with tests (including a planted fake key=value password).
   - The local session store goes under the BrainLink data dir.
   - Define and document the session-index entry shape that sync can carry (docs/SESSION-INDEX.md).
3. MCP tools session_list, session_read and session_log, registered the way the existing tools are.
   - Output is summary-first: session_read defaults to under about 800 tokens, and full=true pages at about 4k.
   - Private sessions are never returned unless the caller is local and asks with include_private=true.
   - Token budget: median 1,050 tokens or fewer per answer, max 3,000. Add a test that measures it with the repo's token estimator.
4. Wiring:
   - A sync choice in setup.mjs Setup (Local by default; Drive, iCloud, Dropbox).
   - An optional `sync` key in config.mjs validate.
   - A `brainlink sync` command in bin that calls src/sync's engine.
   - A Change Log line.
5. `brainlink connect <client>` and `brainlink connect --all`:
   - Merge-write the MCP config for Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI and Windsurf at their real macOS paths and formats. Back up the existing file first, and make it idempotent.
   - Setup's Connect buttons must call the same code. Export detect/connect/test/disconnect returning {ok,message} from src/connectors.mjs (or the existing equivalent).
   - ChatGPT gets an honest note: it needs a remote HTTPS connector, so it's N/A pending Ian.
6. Run `npm test` once at the end and fix any failures, diagnosing before rerunning.

RULES:
- Never read, edit or delete /workspace/rsi-lab or /workspace/rsi-rerun.
- No network pushes. No secrets in code or fixtures. Don't touch src/license-key.mjs beyond what exists.
- Keep it lean; no new npm dependencies unless unavoidable.

FINAL OUTPUT (short): the commits per repo, test totals, the session-index entry shape (one line), which connect clients you verified and how, the Cursor importer status, and open issues.
