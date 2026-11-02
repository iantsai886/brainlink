# Typed knowledge graph: BrainLink design review

The development preview editor added structured entity fields in commit `9f2ba0c`. The installed Setup graph panel is a separate interface; its corresponding fields and save endpoint are being verified in the current working tree. Do not treat the preview commit or its installer smoke as proof of installed graph-field editing. See the latest dated receipt in `docs/IMPLEMENTATION-STATUS.md`.

Status: typed relationship candidates can now be included in an attributed `propose_note` call. BrainLink stores typed records as `status: proposed` and all candidate edges as `review: proposed`, regardless of caller-supplied status, so they remain outside graph retrieval until a person reviews them. A local Setup review queue lists bounded proposals from enabled non-private vaults, shows source evidence and target, and rechecks the source revision before approval or rejection. Rejection records `review: rejected` while preserving source, target, and evidence; users can restore rejected suggestions or undo approvals. An on-demand graph-wide scan checks up to 20 source notes per request and only returns deterministic, same-scope text candidates from caller-visible non-private vaults. The selected-note panel also lets a user manually propose a typed relation to a compatible current entity in the same vault and Twin scope, supported by an exact quote from that note. Saving and approving remain separate user actions. Deterministic rules recognize a small set of explicit relation phrases in English, Portuguese, and Traditional/Simplified Chinese, including named team/person communications and handoffs. Membership phrases such as “belongs to” / “pertence a” map to `part_of`; explicit “owned by” phrases map to `owned_by`, avoiding a duplicate conflicting suggestion. A bounded negation check blocks common explicit denials before proposing an edge; complex sentence meaning still requires review. `brainlink eval-graph --fixture FILE` measures proposal precision/recall, privacy canaries and latency without outputting note content. This evaluator needs diverse, independently authored cases before its results can support a quality claim; live-client workflow and token savings remain unproven.

The 3D graph now derives its nodes, typed-entity uniqueness, Markdown links, typed edges, and degree ranking only from visible, non-generated notes. Multiple approved predicates between the same notes remain separate directional edges and retain their own evidence and confidence; the UI curves parallel edges apart and shows the cited evidence on hover. This is covered by an automated private-canary regression test. Real desktop visual acceptance is still pending.

## Executive conclusion

Adopt the reel's central design idea for structured company and workflow knowledge: model entities and processes as distinct records, then represent their relationships with explicit, directional, typed edges. Keep Markdown notes as the readable source of truth and derive the graph from their metadata and links.

Do not replace every note link with a formal ontology. Plain links remain useful for personal notes, references, and exploratory thinking. A typed relationship is valuable when the relationship changes meaning or retrieval—for example, a team **owns** a workflow, a workflow **consumes** a dataset, or a workflow **produces** an output.

The reel's "nouns are nodes, verbs are edges" is a useful teaching model, not a complete graph specification. Graph theory does not itself determine what a relationship means; BrainLink must define a small vocabulary, direction, provenance, scope, and validation rules.

## What the reel proposes

At 00:28–01:49, the speaker argues that company knowledge can be represented as separate entities (people, teams, data, concepts) and relationships (the actions or connections between them). Their example says the Product team runs a question-collection workflow; the workflow consumes ticket information and produces answers. Each item should have its own description, with the relationships recorded between items instead of flattening the whole sentence into an undifferentiated set of files.

The supplied keyframes at 00:12 and 02:00 show governance/data-sensitivity examples. They reinforce that access labels and sensitive-data policy need to be part of the model. The images are illustrative only; BrainLink should not copy any visible company-specific content from the creator's screen.

## Current BrainLink implementation

| Capability | Verified in this repository | Gap relative to the reel |
|---|---|---|
| Note graph | `src/graph.mjs` extracts Obsidian wikilinks and Markdown links; `src/typed-graph.mjs` also derives directional typed edges from verified frontmatter relations. Deterministic suggestions match a small multilingual phrase set to unique, same-scope entity titles, including team/person communication and handoff phrases. Local Raw-to-Wiki drafts may suggest up to eight entities with exact quotes and relations among existing same-vault entities explicitly named in the selected source. Selected entity and relation candidates are saved as proposed. | No unsourced/general relation inference, session entity extraction, or quality proof; deterministic scanner suggestions cover fixed phrase patterns and require review. |
| 3D graph | `src/graph3d.mjs` builds nodes and edge metadata from visible, non-generated notes only; nodes can show validated entity type/ID, each typed edge retains its own predicate/evidence/confidence, and parallel relations are curved apart. Note details show incoming/outgoing relations and allow manual proposal of a typed relation with an exact source-note excerpt. Notes provides structured fields for type, stable ID, scope, and status while preserving the Markdown record. | Full relationship CRUD, workflow simulation, and automatic arbitrary-language entity/relation extraction remain future work. |
| Related suggestions | `src/core.mjs` and `src/graph.mjs` suggest links using shared terms and graph neighbors. | A suggested association is not a verified semantic relationship. |
| Structured workflows | A Markdown note can use `type: workflow`, a stable `id`, an explicit scope, and verified relations to teams, datasets, and artifacts. Typed edges join the existing graph-aware ranking. | Workflow steps, triggers, input/output schemas, and process execution are still prose; no automatic workflow extraction exists. |
| Authorization | Vault and note privacy are filtered before indexing, search, reads, graph construction, and graph-wide discovery. Typed candidates stay within one visible vault and matching declared scope. | Future graph traversal across vaults must apply access policy to both endpoints before an edge, expansion, excerpt, or log is exposed. |

This is based on code inspection and local tests on the current branch, not on the reel's marketing claims.

## Recommended record and edge model

Keep a note as the durable, human-readable record. Add optional, schema-validated frontmatter for typed records; do not require users to classify ordinary notes.

Example entity note:

```yaml
---
type: team
id: team.product
scope: organisation
status: current
---
# Product team
Purpose, responsibilities, decision rights, and source references.
```

Example workflow note:

```yaml
---
type: workflow
id: workflow.collect-product-questions
scope: organisation
status: current
relations:
  - predicate: owned_by
    target: team.product
    source: "Operating handbook, section 2"
    confidence: 0.98
    review: verified
  - predicate: consumes
    target: dataset.support-tickets
    source: "Workflow description, paragraph 1"
    confidence: 0.95
    review: verified
  - predicate: produces
    target: artifact.draft-answers
    source: "Workflow description, paragraph 1"
    confidence: 0.95
    review: verified
---
# Collect product questions
Trigger, inputs, steps, exception handling, outputs, and owner responsibilities.
```

Recommended initial predicates: `owned_by`, `runs`, `consumes`, `produces`, `depends_on`, `part_of`, `assigned_to`, `informed_by`, and `communicates_with`. Keep them directional and version the vocabulary. Unknown predicates should remain unresolved proposals rather than silently becoming graph edges.

Each edge should retain its source note, target ID, predicate, evidence/source span, confidence, review status, timestamps or validity interval when relevant, and the access scope of its source. Resolve IDs within the authorized vault/profile first. Do not automatically join Personal, Organisation, and Client graphs.

### Relationship type checks

BrainLink validates both the subject type and target type for each predicate before it suggests, accepts, reviews, or materializes a relationship. The current subject/target rules are:

| Predicate | Allowed subject types | Allowed target types |
| --- | --- | --- |
| `owned_by` | team, workflow, dataset, artifact, project, policy, concept | team, person |
| `runs` | team, person, project, workflow | workflow |
| `consumes` | workflow | dataset, artifact |
| `produces` | workflow | dataset, artifact |
| `depends_on` | team, workflow, dataset, artifact, project, policy, concept | workflow, dataset, project |
| `part_of` | person, team, workflow, dataset, artifact, project, policy, concept | team, project |
| `assigned_to` | workflow, artifact, project | person, team |
| `informed_by` | team, workflow, project, policy, concept | artifact, dataset, concept |
| `communicates_with` | person, team, workflow | person, team |

This prevents a sentence about a team running a workflow from incorrectly making the team itself the consumer or producer of the workflow's data. Existing YAML edges that do not match this type matrix are ignored by graph retrieval and excluded from the review queue; their source text remains unchanged so the owner can correct them. This is a validation rule, not automatic migration or deletion.

## User and AI workflow

1. Capture a session or source document with provenance and its privacy scope.
2. BrainLink suggests an entity/workflow type, a destination, and candidate typed relationships. It shows the supporting source text and confidence.
3. The user reviews proposed entities, edits, relations, and destinations. Existing notes are not silently overwritten; ambiguous links abstain.
4. BrainLink stores approved notes and derives the typed graph from validated frontmatter. The notes remain inspectable and portable Markdown.
5. For a question, retrieve the best authorized note first, then expand only across useful predicate types and a bounded number of hops. Include compact source citations and return only the context needed for the task.
6. RSI may evaluate wrong placement, unresolved IDs, stale edges, retrieval quality, latency, and token use. It may propose repairs; promotion or policy changes require review and rollback support.

Permissions must be checked before graph traversal or any observable derived output. An edge is visible only when the caller can access both source and target records. Private or excluded endpoints must not leak through counts, edge labels, candidate lists, summaries, logs, or "related" suggestions.

## How to measure value

The reel claims a structured graph helps an AI navigate company knowledge, but it provides no controlled evidence in the supplied transcript that this method improves answer quality or saves tokens. Treat those as hypotheses.

Compare the existing link/lexical retrieval with typed-relationship retrieval on a frozen, independently authored set of realistic workflow questions. Measure task success and citation correctness alongside input-token count, latency, abstention, and privacy canaries. Count provider-reported tokens when available; label local estimates as estimates. A lower token count is not a win if answers become less accurate or omit required context.

Minimum acceptance gates:

- Every returned edge resolves to authorized source and target records; unknown targets and predicates abstain visibly.
- Synthetic Personal, Organisation, and Client canaries never cross scopes in search, graph expansion, excerpts, handoffs, or logs.
- Users can inspect, correct, approve, and reject generated relationships. They can undo an approval from the source note panel; BrainLink returns the link to review, removes it from graph retrieval, and keeps its source evidence.
- Broken and stale relations are detected without auto-deleting original notes or source evidence.
- Typed graph retrieval improves answer success or reduces tokens at equal success on a frozen evaluation set; publish sample size, baseline, failures, and limits.

## Recommendation and next step

Add typed entities, workflows, and relationships to BrainLink's architecture as an optional semantic layer above the existing Markdown link graph. Preserve simple note links. Start with fictional company data and a narrow set of workflows; do not build an open-ended ontology editor or autonomous graph rewriting yet.

Implemented first slice: parse a bounded allowlist of entity types and predicates from explicit Markdown frontmatter; materialize only verified edges with evidence, confidence, current records, unique IDs, and matching scope inside the same authorized vault; include the edges in graph-aware ranking; and render typed labels in the existing graph and note details. Fictional tests cover valid relations and fail-closed cases. AI clients can create proposed typed metadata through `propose_note`; users can review proposals in the graph panel or through the central queue. The graph panel also supports manual same-vault/same-scope relation proposals with quote validation. Local Raw-to-Wiki suggests exact-quote-backed entity notes and relationships between current same-vault entities mentioned by the source. These remain proposed until separate user review. Unbounded relation extraction, automated session extraction, broad extraction-quality evaluation, and token-savings proof remain open.

Next: build a larger independently authored relation set with ambiguous, negated, stale, multilingual and cross-scope cases, and compare typed-graph retrieval with the existing note-link/lexical baseline on the same tasks. Until that work is complete, general extraction quality and token savings remain unproven.

Source: user-provided Reel transcript with keyframes at 00:00, 00:12, 00:30, 00:45, 01:00, 01:30, 02:00, and 02:30. Speaker credentials and promotional claims were not independently checked or used as evidence.
