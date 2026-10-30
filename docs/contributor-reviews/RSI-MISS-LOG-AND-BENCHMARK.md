# Review: draft RSI miss log and weekly benchmark

Review date: 2026-10-30  
Repository: `iantsai886/brainlink`  
Pull request: [#4](https://github.com/iantsai886/brainlink/pull/4)  
Reviewed head: `be8ffbce305ed1ceee358c679de258da308e07eb`  
Decision: keep the PR in draft; do not merge the miss-log path as written.

## Verified

- The weekly benchmark reuses `evaluateRetrieval` and a fixed fictional 20-case fixture. It records aggregate baseline retrieval results in the existing RSI ledger; it does not claim generated-answer quality or causal improvement.
- The PR's focused test file passes 4/4 on Windows / Node.js 24.22.1 when run in a disposable worktree with the repository's validated public-hash scanner fix (`1d28fbb`) applied.
- This focused pass does not verify the complete PR branch, the full test suite, hosted CI, or any real-vault benchmark.

## Privacy and scope blocker

The miss schema accepts a free-text `question` and persists it in plaintext in the shared RSI ledger. It also persists `fixed_by.note`. The record has an agent name but no Personal / Organisation / Client profile scope. The import path stores the same raw question. The CLI accepts it as a command-line argument, where it can also be retained in shell history or visible process arguments.

A disposable test with fictional data confirmed that a question containing a fictional email address is accepted, the full question is written to the ledger, and no profile ID is recorded. The current secret scanner detects some credential patterns; it is not a general personal-data detector. This fails BrainLink's default separation and data-minimization requirements for user and client work.

## Required changes before integration

1. Do not persist raw questions or fix notes. Store only bounded outcome, latency bucket, fix category, date/week and an opaque duplicate-group key. If duplicate grouping is needed, use a per-profile keyed digest; a plain hash of common questions is guessable.
2. Derive profile identity from a verified scoped BrainLink connection. Do not accept a caller-supplied profile ID. Keep each profile's evidence and reports separate.
3. Do not accept private text through a CLI argument. Prefer an authenticated local form or an explicit stdin flow that hashes and discards the text before it reaches the ledger.
4. Add tests proving email/phone-like canaries and raw question text never persist, one profile cannot list another profile's events, and weekly aggregates stay within their fixture and profile.
5. Run the full test suite on the integrated commit. The draft's four focused tests are not a substitute.

The fixed fictional weekly benchmark may be retained after a full integration review. Until then, keep the contributor PR open as a draft and use only the safe fictional test fixture.
