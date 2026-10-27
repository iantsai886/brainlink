# RSI research discovery (opt-in)

Status: implemented and locally tested on 2026-10-26 (Asia/Taipei). arXiv, Crossref, and public GitHub repository search adapters are covered with synthetic responses; live source access was not exercised in this development run.

## What it does

Discovery is the first runtime stage of the [RSI operating model](RSI-OPERATING-MODEL.md) (A0 observe → A1 recommend). It is **off by default**. New installations default to a daily check after discovery is enabled; the user may select a less frequent interval. When the user turns it on in Setup → Improve BrainLink → Research discovery, BrainLink:

1. Sends each configured search topic (at most five, letters/numbers/spaces/`-+.` only) only to the public sources the user selected: arXiv's Atom API (`https://export.arxiv.org/api/query`), Crossref's JSON works API (`https://api.crossref.org/works`), and/or GitHub's public repository search API (`https://api.github.com/search/repositories`).
2. Parses the returned Atom or JSON metadata as untrusted data. Crossref abstracts are retained only as a short first-sentence excerpt with a DOI citation; Crossref notes that some abstracts may be copyrighted. GitHub results use only the public repository name, description and last-pushed date; BrainLink does not clone repositories, read code, rank by stars, or treat a description as verified evidence.
3. Keeps an entry only when it matches **both** one of the user's own problem statements (at least two shared terms and 25% of the statement's terms) **and** a BrainLink memory/agent workflow term (for example handoff, retrieval, knowledge graph, tool use, episodic memory).
4. Appends kept entries to the existing local RSI ledger as `discovered` proposals, at most `max_new_per_run` (1–10, default 5) per run.

Runs start manually ("Run now") or from a schedule (every 1, 7, 14 or 30 days). When discovery is enabled and not paused, the local Setup process stays available past its ordinary idle timeout so scheduled runs can occur. The discovery panel offers an explicit one-click setting to start BrainLink quietly at sign-in; this uses the same user-managed launcher as the general background setting. Pausing or disabling discovery restores the normal idle exit; explicitly closing the app still stops it. There is no separate service, so checks resume only after the user signs in and BrainLink starts. This is scheduled public-source research, not continuous monitoring or autonomous code improvement.

An additional **Recheck old saved sources** option is off by default. When enabled, after each manual or scheduled discovery run BrainLink rechecks up to three oldest citations from its own public-source discoveries, if their last check (or original discovery) is at least 30 days old. It contacts only the source types still selected in Settings and builds each request from the saved arXiv ID, DOI, or exact public GitHub repository identity. The local problem statement, topic, vault, session, proposal text and credentials are not sent by these checks. They append metadata fingerprints and statuses; they do not edit the proposal. Older items wait for later runs. Turning the option off stops batch rechecks; the per-item manual check remains available.

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
| XML / JSON attacks | Any XML DTD or entity declaration refuses the feed; JSON must parse and contain a bounded source-specific results list/object | Atom, Crossref and GitHub parser tests |
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

`origin: "discovery"` plus `discovery.{run_id, method_version, source, topic, topic_matched_terms, signal, matched_terms, workflow_terms, score}`, and one source with canonical URL, title, publication date (or `unknown`), access date, claim (`Abstract states (not verified): …`), confidence (always `low`), and limitations (automatic, unreviewed, preprints may not be peer reviewed, no evidence of improvement for BrainLink). New proposals record `method_version` (currently `lexical-topic-gate-v2`) so later research-method changes retain lineage. The matcher requires overlap with both a configured problem and its search topic, as well as a BrainLink workflow term. The proposal stores the exact topic terms that matched, and Setup displays them as review evidence. Older proposals remain readable without this optional field. This label supports comparison; it does not show the method improved. The card in Setup shows the selected topic, user's problem, shared terms, BrainLink workflow terms and match score.

## Fixed discovery-quality check

Run `npm run evaluate:rsi-discovery` to score the current built-in matcher against `samples/evaluation/rsi-discovery-v1.json`. The fixture has 28 benign fictional examples, including hard negatives with overlapping words, and two hostile examples; the receipt reports aggregate precision, recall, F1, false positives/negatives, fixture hash, method version and hostile-entry guardrail. The lexical-only baseline (`lexical-overlap-v1`, before topic labels were added) scored 12 true positives, 3 false positives, 0 false negatives and 13 true negatives (precision 0.800, recall 1.000); both hostile examples were blocked. The topic-gate v2 scores 12/12 positive and 16/16 negative fictional examples on the updated fixture, with both hostile examples blocked. The known false positives informed the new topic labels and change, so this result is a regression check on examples used during development, not held-out validation or proof of general accuracy. The command reads only this checked-in fixture, makes no network calls, reads no vault and does not alter the discovery method. Build a new independently labeled set before making a broad quality claim.

## Manual source freshness check

For a discovered proposal, Setup can recheck the already stored public arXiv identifier, DOI, or GitHub repository identity. BrainLink builds the request from that identifier and the adapter's fixed allowlisted endpoint; it does not accept a URL from the UI. arXiv checks use the exact paper ID, Crossref checks use an exact DOI filter, and GitHub checks fetch only the exact public repository metadata. The request does not send the user's problem statement, vault, or session data. By default this is an explicit per-item action. The optional batch setting above checks up to three citations that are at least 30 days old after a discovery run, using only still-selected sources.

The check compares a SHA-256 fingerprint of the stored and observed citation metadata (canonical source URL, title, publication date, and the same short unverified claim field). It records only the proposal ID, source type, check time, status, and fingerprints in `rsi/discovery.json`; it does not save another title/abstract snapshot or mutate the immutable proposal, its claim, review state, or provenance. Statuses are `unchanged`, `changed`, `not_found`, `unsafe`, `unavailable`, or `paused`. “Unchanged” means only that these selected metadata fields matched at check time; it does not validate the paper's claims or prove relevance. A changed result asks the reviewer to inspect the citation manually. Recent receipts are capped at 50 and included in the existing private app-data backup.

The check does not verify the truth of the source content, automatically update citations, or retain every version of the source. Automated tests use synthetic responses; live arXiv, Crossref and GitHub behavior has not been validated in this implementation run.

## Limits

- Three sources: arXiv preprints, Crossref scholarly metadata, and public GitHub repository search. GitHub contributes project names, descriptions and update dates only; it does not inspect code, releases, maintainer health or security. Standards bodies, user feedback and support issues are not yet sources. Crossref metadata quality and coverage depend on member deposits; its API returns metadata and does not provide article full text. GitHub's public Search API has rate limits; failures are recorded and not retried in a tight loop.
- Relevance is lexical term overlap, not semantic understanding. The result must share at least two topic terms when the topic has two or more terms, share problem-signal terms, and contain a recognized BrainLink workflow term. Chinese text is matched with overlapping two-character terms and exact workflow phrases, so unspaced Chinese can match without being treated as one long word. This does not translate between languages or map Traditional and Simplified Chinese variants; it can miss relevant work that uses different wording and can admit loosely related papers. The reviewer decides.
- The extracted claim is the abstract's or repository description's first sentence. It is not verified and says nothing about whether the idea helps BrainLink.
- DNS is checked before the request but the HTTP client resolves the name again; the fixed host allowlist is the primary SSRF control.
- The ledger is append-only, so a discovered proposal is removed from consideration by rejecting it, not by deleting it. Scheduled private backups include both the ledger and `rsi/discovery.json`; restore places them in an inspectable `BrainLink/rsi/` folder and does not overwrite live app data.
- The prompt-injection filter is a pattern list. It reduces risk; it is not a guarantee, which is why discovery output is never executed and is always labelled unverified.

## Source references

- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) — public works endpoint and JSON metadata.
- [Crossref access and authentication](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/) — public access requires no account; polite-pool identification is optional.
- [Crossref REST API tips](https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/) — selective fields and efficient metadata requests. The [REST API overview](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) notes some abstracts may be copyrighted.
- [GitHub Search repositories API](https://docs.github.com/en/rest/search/search#search-repositories) — public repository metadata search.
- [GitHub REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) — unauthenticated public access and stricter limits for search endpoints.

## Rollback

Turn discovery off or pause it in Setup; no further requests are made. To remove the feature, revert the commit that added `src/rsi-discovery.mjs`. Existing ledger records with `origin: "discovery"` remain valid, hash-verified ledger entries and display as ordinary `discovered` proposals in older builds; reject them if they are unwanted. Deleting `rsi/discovery.json` resets discovery to its default off state.
