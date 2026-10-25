# ChatGPT Codex contributor prompt

Copy the prompt below into a separate ChatGPT Codex coding session after opening the `iantsai886/brainlink` GitHub repository.

---

You are an independent software engineering contributor to BrainLink in the `iantsai886/brainlink` GitHub repository. Work from the real repository and leave all code, decisions, test evidence, and handoff notes in GitHub.

## Your non-overlapping workstream

Build an **independent, frozen retrieval and token-efficiency evaluation** for BrainLink's AI-agent second-brain workflow. The current repo already has `src/retrieval-eval.mjs`, `samples/evaluation/retrieval-rsi-v1.json`, and `docs/RETRIEVAL-EVAL.md`; inspect them first. Your contribution must provide a genuinely separate held-out fictional evaluation set and reproducible report, not tune the existing fixture or duplicate its labels.

Do not modify GitHub sharing/profile configuration, conflict handling, Setup UI, or product runtime retrieval behavior. Another contributor owns profile-scoped repository configuration, and the primary implementation branch may be changing the GitHub shared-note flow. If you discover overlap, keep your work isolated and report it.

## Required inspection and experiment

1. Record repository URL, `git status`, branch, commit, remotes, Node version, and existing evaluation commands. Read `AGENTS.md`, `docs/IMPLEMENTATION-STATUS.md`, `docs/RETRIEVAL-EVAL.md`, `docs/RSI-OPERATING-MODEL.md`, the evaluator implementation, and its tests.
2. Treat all current query labels and reported scores as potentially stale until you reproduce them from the exact fixture hash and current commit.
3. Create a separate, frozen, fictional held-out corpus with realistic personal, organisation, and client-scope tasks. Keep the fixture free of real personal/customer data. Include ambiguous questions, missing-answer cases, stale/contradictory notes, provenance requirements, cross-scope canaries, and cases where concise retrieval must not omit necessary context.
4. Make the evaluator compare the current baseline with a candidate retrieval policy using identical questions and permissions. Report task success, top-k/source correctness, abstention, privacy violations, latency, context size/token estimates, and failures. A token reduction only counts as an improvement if answer/source quality is not worse and privacy remains intact.
5. Keep evaluation read-only: it must not edit vault notes, ranking configuration, skill files, or persistent RSI policy. Label estimated tokens separately from provider-billed token counts. Do not claim real-world savings from a local estimate.
6. Add reproducible commands and machine-readable receipts that bind each result to commit, fixture hash, environment, sample count, and evaluator version. The independent set must not be used to tune the candidate during this contribution; document that boundary.

## Engineering and data boundaries

- Use the repository's existing evaluator interfaces and test conventions. Avoid a parallel benchmarking framework.
- Use only fictional notes and questions. Prove that private, excluded, and foreign-profile canaries never appear in results, excerpts, citations, or aggregate output.
- Do not add any network lookup, model/API call, telemetry, or external data upload to the evaluator.
- Do not change production search behavior or assert that BrainLink is commercially ready.
- Do not reset, clean, or overwrite existing work. Never commit secrets, local data, generated user records, or unreviewed benchmark content.

## Git workflow

1. Fetch and inspect the latest `fix/private-session-excerpts` branch. Confirm its current HEAD; do not trust a hash in this prompt.
2. Create a separate branch named `eval/independent-retrieval-efficiency` from the verified latest branch. Do not work directly on the shared branch, merge, or create a release.
3. Keep the contribution focused on the held-out evaluation, evaluator/reporting code, tests, and its documentation. If another contributor has changed a needed file, inspect the diff and coordinate through a GitHub branch/PR instead of overwriting it.
4. Run the focused evaluator tests and the full documented test suite. Record exact commands and pass/fail/skip counts. Push only your feature branch if authorized by the connected GitHub account; otherwise provide the exact commit and patch.

## Completion report

Return the branch and commit/PR, files changed, fixture hash and size, baseline/candidate results, privacy-canary result, commands and test counts, limitations, and next smallest action. Clearly separate reproducible local evidence from independent review, provider-measured token savings, cross-client validation, and production readiness.

Begin by reporting the verified baseline and confirming this workstream does not overlap active changes. Then complete the contribution autonomously.

---
