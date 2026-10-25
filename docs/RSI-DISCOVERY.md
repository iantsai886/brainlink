# RSI research discovery (opt-in)

Status: implemented and locally tested on 2026-10-25 (Asia/Taipei). arXiv and Crossref adapters are covered with recorded, synthetic responses; live source access was not exercised in this development run.

## What it does

Discovery is the first runtime stage of the [RSI operating model](RSI-OPERATING-MODEL.md) (A0 observe → A1 recommend). It is **off by default**. When the user turns it on in Setup → Improve BrainLink → Research discovery, BrainLink:

1. Sends each configured search topic (at most five, letters/numbers/spaces/`-+.` only) only to the public sources the user selected: arXiv's Atom API (`https://export.arxiv.org/api/query`) and/or Crossref's JSON works API (`https://api.crossref.org/works`).
2. Parses the returned Atom or JSON metadata as untrusted data. Crossref abstracts are retained only as a short first-sentence excerpt with a DOI citation; Crossref notes that some abstracts may be copyrighted.
3. Keeps an entry only when it matches **both** one of the user's own problem statements (at least two shared terms and 25% of the statement's terms) **and** a BrainLink memory/agent workflow term (for example handoff, retrieval, knowledge graph, tool use, episodic memory).
4. Appends kept entries to the existing local RSI ledger as `discovered` proposals, at most `max_new_per_run` (1–10, default 5) per run.

Runs start manually ("Run now") or from a schedule (every 1, 7, 14 or 30 days). When discovery is enabled and not paused, the local Setup process stays available past its ordinary idle timeout so scheduled runs can occur. Pausing or disabling discovery restores the normal idle exit; explicitly closing the app still stops it. There is no separate background service, and discovery is not continuous research.

## What it never does

- Fetch a URL supplied by a user, an agent, a feed entry or an API caller. The only origins and endpoint paths are fixed in `src/rsi-discovery.mjs`; adding another source is a reviewed code change.
- Send problem statements, vault content, session content, ledger content or credentials off the machine. Only the topic string and fixed headers (`Accept`, `User-Agent`) are sent to each selected source; cookies and credentials are omitted.
- Triage, test, accept, release or roll back a proposal; change code, Skills, notes, permissions or configuration; or invent a hypothesis. Every discovery stays a `discovered` proposal until a person moves it through the existing reviewed lifecycle.
- Collect customer data or usage telemetry.

## Safety controls

| Threat | Control | Test |
|---|---|---|
| SSRF / arbitrary fetch | HTTPS only, exact source host and endpoint-path allowlist, no credentials or custom port, every DNS answer checked against private, loopback, link-local, CGNAT, multicast, documentation and IPv4-mapped ranges before connecting, `redirect: 'manual'` with 3xx refused | `feed fetching refuses hosts outside the allowlist…` |
| Unbounded download | 15 s deadline for connect and body, 1 MB cap on declared and streamed size, content-type must be Atom/XML or JSON as expected, at most 25 entries per feed | same |
| XML / JSON attacks | Any XML DTD or entity declaration refuses the feed; JSON must parse and contain a bounded `message.items` list | Atom and Crossref parser tests |
| Markup / UI spoofing | Tags stripped before and after entity decoding, CDATA unwrapped, control and bidirectional-override characters removed, lengths capped; the UI escapes everything | same |
| Prompt injection | Entries addressing an AI or asking to reveal/send secrets or run commands are dropped and counted as unsafe, so no agent later reads them as part of a proposal | `a run files relevant entries…` |
| Secret / private-data leakage | Topics and problem statements reject secrets, URLs and email addresses; feed entries containing secret-like strings are dropped; the ledger's own secret scan still applies; errors stored in run receipts have URLs removed | settings and failure tests |
| Forged provenance | `origin` and `discovery` are written only by the discovery path; the public create/update APIs reject them, and they are covered by the ledger hash chain | provenance and API tests |
| Duplicates / flooding | Inside the ledger lock: same canonical source URL (arXiv versions collapse to one) or ≥80% title similarity counts as a duplicate; duplicates within one run are merged; per-run cap with an over-limit count | dedupe test |

## Pause, resume and visibility

- Pause and resume are stored with the settings, survive restart, block manual and scheduled runs, and are listed with enable/disable/settings events in Setup. Enabled, unpaused discovery keeps the desktop process alive past its ordinary idle timeout; pausing or disabling it restores that timeout.
- Pausing or turning discovery off while a run is reading feeds discards that run: nothing is written to the ledger and the receipt says so.
- Setup lets the user select the built-in sources and shows the selected source hosts, plus the last ten run receipts: trigger, status (completed, partly failed, failed, discarded), feeds fetched, entries read, new, duplicates, not relevant, unsafe, invalid, over limit, and sanitized errors.
- Settings and receipts live in `rsi/discovery.json` in BrainLink app data (mode 0600, atomic replace). An unreadable file fails closed.

## Provenance on each discovered proposal

`origin: "discovery"` plus `discovery.{run_id, source, topic, signal, matched_terms, workflow_terms, score}`, and one source with canonical URL, title, publication date (or `unknown`), access date, claim (`Abstract states (not verified): …`), confidence (always `low`), and limitations (automatic, unreviewed, preprints may not be peer reviewed, no evidence of improvement for BrainLink). The card in Setup shows why the item is relevant: the user's problem, shared terms, BrainLink workflow terms and the match score.

## Limits

- Two sources (arXiv preprints and Crossref scholarly metadata). Standards bodies, open-source releases, user feedback and support issues are not yet sources. Crossref metadata quality and coverage depend on member deposits; its API returns metadata and does not provide article full text.
- Relevance is lexical term overlap, not semantic understanding. It will miss relevant work that uses different wording and can admit loosely related papers; the reviewer decides.
- The extracted claim is the abstract's first sentence. It is not verified and says nothing about whether the idea helps BrainLink.
- DNS is checked before the request but the HTTP client resolves the name again; the fixed host allowlist is the primary SSRF control.
- The ledger is append-only, so a discovered proposal is removed from consideration by rejecting it, not by deleting it. Scheduled private backups include both the ledger and `rsi/discovery.json`; restore places them in an inspectable `BrainLink/rsi/` folder and does not overwrite live app data.
- The prompt-injection filter is a pattern list. It reduces risk; it is not a guarantee, which is why discovery output is never executed and is always labelled unverified.

## Source references

- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) — public works endpoint and JSON metadata.
- [Crossref access and authentication](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/) — public access requires no account; polite-pool identification is optional.
- [Crossref REST API tips](https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/) — selective fields and efficient metadata requests. The [REST API overview](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) notes some abstracts may be copyrighted.

## Rollback

Turn discovery off or pause it in Setup; no further requests are made. To remove the feature, revert the commit that added `src/rsi-discovery.mjs`. Existing ledger records with `origin: "discovery"` remain valid, hash-verified ledger entries and display as ordinary `discovered` proposals in older builds; reject them if they are unwanted. Deleting `rsi/discovery.json` resets discovery to its default off state.
