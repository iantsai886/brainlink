# Session-to-memory filing: first governed path

Status: implemented and locally tested; **not** automatic end-of-session capture.

The local BrainLink Sessions screen now offers **File summary** when a stored session has a summary. The user chooses a destination vault, previews an episodic note, and explicitly saves it. The note inherits `private: true` regardless of the session's sharing toggle, carries the session ID and client as provenance, and remains `status: proposed` / `confidence: reported`. It never copies raw turns or promotes a summary to verified semantic knowledge. The note writer rejects credential-like content, respects writable-vault policy, uses an existing intake folder, and never overwrites an existing note. No source-backed links are invented.

This path reuses the existing `proposeNote` write and attribution controls. The local API requires its Setup token. The preview and save actions require a chosen vault; neither an AI client nor filename matching silently chooses a personal, company, or client destination. The UI is available in English, Traditional Chinese, and Portuguese.

Validation: `test/session-filing.test.mjs` uses fictional company and personal vaults, verifies preview-only behavior, private frontmatter and read blocking, chosen-vault-only writing, no overwrite, rejection of empty summary and secrets, API authentication, and exclusion of raw private turns. Run with `node --import ./test/_preload.mjs --test test/session-filing.test.mjs`.

Remaining for the complete product: trustworthy summary extraction from supported session endings, automatic destination recommendation with explainable evidence, source-linked and reversible classification, user correction, cross-client handoff verification, token/time measurement, and privacy evaluation across personal/company/client fixtures. A summary alone is not a validated experience or long-term rule.
