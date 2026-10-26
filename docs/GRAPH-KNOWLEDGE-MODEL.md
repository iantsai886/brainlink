# Typed knowledge graph: BrainLink design review

Status: typed relationship candidates can now be included in an attributed `propose_note` call. BrainLink stores typed records as `status: proposed` and all candidate edges as `review: proposed`, regardless of caller-supplied status, so they remain outside graph retrieval until a person reviews and verifies the Markdown. Local tests cover proposal validation and the explicit promotion boundary. AI-assisted extraction accuracy, an ontology editor, live-client workflow, and token savings are not yet proven.

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
| Note graph | `src/graph.mjs` extracts Obsidian wikilinks and Markdown links; `src/typed-graph.mjs` also derives directional typed edges from verified frontmatter relations. | Manual metadata only. BrainLink does not automatically identify entities or extract relations from sessions/documents. |
| 3D graph | `src/graph3d.mjs` builds a privacy-filtered note graph; nodes can show validated entity type/ID, typed edges have predicate labels, and note details show incoming/outgoing relations. | Still a note graph with optional entity metadata, not a full graph editor or workflow simulator. |
| Related suggestions | `src/core.mjs` and `src/graph.mjs` suggest links using shared terms and graph neighbors. | A suggested association is not a verified semantic relationship. |
| Structured workflows | A Markdown note can use `type: workflow`, a stable `id`, an explicit scope, and verified relations to teams, datasets, and artifacts. Typed edges join the existing graph-aware ranking. | Workflow steps, triggers, input/output schemas, and process execution are still prose; no automatic workflow extraction exists. |
| Authorization | Vault and note privacy are filtered before indexing, search, reads, and graph construction. | A future typed graph must apply the same access policy to both endpoints before an edge, expansion, excerpt, or log is exposed. |

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

Recommended initial predicates: `owned_by`, `runs`, `consumes`, `produces`, `depends_on`, `part_of`, `assigned_to`, and `informed_by`. Keep them directional and version the vocabulary. Unknown predicates should remain unresolved proposals rather than silently becoming graph edges.

Each edge should retain its source note, target ID, predicate, evidence/source span, confidence, review status, timestamps or validity interval when relevant, and the access scope of its source. Resolve IDs within the authorized vault/profile first. Do not automatically join Personal, Organisation, and Client graphs.

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
- Users can inspect, correct, reject, and roll back generated relationships.
- Broken and stale relations are detected without auto-deleting original notes or source evidence.
- Typed graph retrieval improves answer success or reduces tokens at equal success on a frozen evaluation set; publish sample size, baseline, failures, and limits.

## Recommendation and next step

Add typed entities, workflows, and relationships to BrainLink's architecture as an optional semantic layer above the existing Markdown link graph. Preserve simple note links. Start with fictional company data and a narrow set of workflows; do not build an open-ended ontology editor or autonomous graph rewriting yet.

Implemented first slice: parse a bounded allowlist of entity types and predicates from explicit Markdown frontmatter; materialize only verified edges with evidence, confidence, current records, unique IDs, and matching scope inside the same authorized vault; include the edges in graph-aware ranking; and render typed labels in the existing graph and note details. Fictional tests cover valid relations and fail-closed cases. AI clients can now create proposed typed metadata through `propose_note`; there is still no dedicated review editor or automatic extraction quality evaluation.

Next: add a dedicated UI review/edit affordance and evaluate relation proposals on a frozen retrieval set with privacy canaries. Then measure token and task-quality changes; until that work is complete, token savings remain unproven.

Source: user-provided Reel transcript with keyframes at 00:00, 00:12, 00:30, 00:45, 01:00, 01:30, 02:00, and 02:30. Speaker credentials and promotional claims were not independently checked or used as evidence.
