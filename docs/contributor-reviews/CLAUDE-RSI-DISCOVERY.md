# Contributor review: opt-in RSI research discovery

Date: 2026-10-25 (Asia/Taipei)

## Submitted contribution

- Repository: `iantsai886/brainlink`
- Contributor branch: `feat/rsi-research-discovery`
- Contributor commit: `fa7ae5d`
- Contributor report: `C:\Users\iants\Downloads\brainlink-rsi-discovery-report.md`
- Integrated by: `6c2bc59` on `integration/brainlink-rsi-discovery`
- Integration follow-up: `44745e1` records the profile-scoped GitHub review; later RSI/backup/lifecycle fixes are also in the integration branch.

The contribution adds opt-in arXiv research discovery at RSI observe/recommend stages. It filters public feed items against user-entered topics, local problem statements, and BrainLink workflow terms; records matches as low-confidence, sourced `discovered` proposals; and does not test, approve, promote, or implement them.

## Review and integration decisions

The change was integrated because it provides a bounded way to discover improvement candidates while retaining human review and the existing hash-chained RSI ledger. Discovery remains off by default, has one fixed source, sends only configured topic terms, supports pause/resume, and rejects untrusted feed content before it enters the proposal lifecycle.

The submitted report identified two follow-ups, both addressed during integration:

- **Backup:** scheduled private backups now include `rsi/discovery.json` (settings and receipts) as well as the RSI proposal ledger. Restore places these in the reviewable `BrainLink/rsi/` recovery folder and does not overwrite live app data.
- **App lifecycle:** enabled, unpaused discovery now prevents the normal desktop idle timeout from stopping scheduled runs. Pausing or disabling discovery restores the ordinary idle timeout. Explicit app exit still stops the schedule.

## Evidence

The contributor report states that commit `fa7ae5d` passed nine GitHub Actions jobs (six Node 22/24 platform jobs and three unsigned package builds) and, with an isolated temporary `HOME`, passed 303 core tests and 28 UI tests on Linux. It also states that live arXiv access and native desktop use were not validated. The report's CI receipt was not independently queried during this review; the feature branch tip was fetched and confirmed as `fa7ae5d`.

The combined integration was independently tested on Windows with Node.js 24.18.0 after the backup and lifecycle follow-ups: `npm run test:all` passed 316 core tests (310 passed, six skipped) and 28 UI tests (28 passed), 344 total (338 passed, six skipped). The focused discovery/backup run passed 21 tests; one Windows symlink-privilege test was skipped. Tests used synthetic Atom feed data and fictional local fixtures; no live arXiv request was made.

## Current limits

- Relevance is lexical, the first sentence of each abstract is not independently verified, and only arXiv is supported.
- Research discovery is scheduled while the local app is running; it is not a separate service or uninterrupted background research system.
- The pattern-based prompt-injection filter reduces risk but cannot guarantee that every hostile entry is detected. Discovered proposals are never executed automatically.
- Live feed behavior, native desktop experience, measured product improvement, and production readiness remain unverified.

