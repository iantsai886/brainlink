# BrainLink RSI Gate — State Machine & Record Format

**Scope:** Governs every skill under `Brain/60 Skills/<skill-name>/SKILL.md` and bridges promotion directly into BrainLink's hash-chained RSI ledger (`src/rsi-ledger.mjs`) and multi-client skill installer (`src/agent-skills.mjs`).

## 1. Four States Only

| State | Meaning | Active in AI clients? | Reversible? |
|---|---|---|---|
| `draft` | Newly distilled or proposed skill; unjudged or awaiting revision. | No | Yes (`active`, `held`, `killed`) |
| `active` | Passed independent evaluation (`judge != author`); deployed to AI clients. | Yes | Yes (`rollback` restores previous version; or `held` / `killed`) |
| `held` | Paused with an explicit `--reason` and unblock `--condition`. | No | Yes (`active` with passing evidence, `draft`, `killed`) |
| `killed` | Retired / rejected with `--reason`. File stays on disk; never deleted. | No | **Terminal** (create a new versioned skill to supersede) |

## 2. Legal Transitions

```
draft  ──(promote + PASS evidence + judge!=author)──▶ active
draft  ──(hold + reason + condition)────────────────▶ held
draft  ──(kill + reason)────────────────────────────▶ killed

held   ──(promote + PASS evidence + judge!=author)──▶ active
held   ──(reopen)───────────────────────────────────▶ draft
held   ──(kill + reason)────────────────────────────▶ killed

active ──(rollback)─────────────────────────────────▶ previous state (draft/held), keeping both snapshots
active ──(hold + reason + condition)────────────────▶ held
active ──(kill + reason)────────────────────────────▶ killed
```

## 3. YAML Frontmatter Contract

Uses the existing `status` field (never renamed, never duplicated). Adds alongside it:

- `status`: `draft | active | held | killed`
- `status_reason`: concise reason (for `held`, includes `[condition: ...]`)
- `status_changed_at`: ISO-8601 timestamp with `+08:00` offset
- `status_changed_by`: actor identity (e.g. `Antigravity (Anna)`)
- `judge`: exact judge identity (e.g. `deterministic-rubric-v1`, `claude-cli`, `codex-cli`)
- `evidence_path`: path to the immutable JSON evidence file

Skill body text is **never** rewritten by the gate.

## 4. Non-Negotiable Invariants (Enforced in Code)

1. **Judge ≠ Author:** `promote` refuses (exit `1`) without a `PASS` evidence file or if `judge` matches the skill's author/model family (`Hermes/DeepSeek`, `Claude`, `Codex/ChatGPT`, `Gemini/Antigravity`, `Grok/Paulo`).
2. **Append-Only Audit:** Every state change appends one JSONL line to `rsi-gate-audit.jsonl` and mirrors a content-free `skill_state_change` event into BrainLink's hash-chained `rsi-ledger.mjs`. Lines are never rewritten.
3. **Non-Destructive Rollback:** Pre-promotion and superseded `active` snapshots are retained in `<skill>/.rsi-history/`. Nothing is deleted.
4. **Caps + Backlog Circuit Breaker:** `caps --precheck` enforces `<= 5 cards` and `<= 2 skills` per run, and refuses new external `draft` skills when unjudged drafts exceed `20` unless `--demand-signal` is supplied.
5. **Exit Codes:** `0` ok, `1` refusal (exact rule printed), `2` usage error.
