# RSI-001 fix-selection experiment

- Date: 2026-11-17
- Fixture: `fictional-rsi-fix-selection-v1` (SHA-256: `5ccb928b12293026a5095f6f6a381ef9c0f3546443e1b5731e53ffce862fe196`)
- Training baseline: 15 fictional cases; fixed-list top 2: add_link, add_index_entry; fresh-case coverage 7/14 (50.0%).
- Candidate: frequency-selected top 2: file_missing_fact, replace_stale_note; fresh-case coverage 5/14 (35.7%).
- Outcome: fixed list performed better on this fictional fixture.
- Decision: no recursive gain claim; no behavior or ranking changed.

## Limits

- All cases are synthetic and authored for this fixture.
- The fixed-list policy was specified before scoring the fresh cases, but the sample is small and not an independent benchmark.
- This result does not establish better production retrieval, autonomous learning, or real user benefit.

RSI-001's experiment is complete for this synthetic comparison. Any decision to promote an adaptive fix-selection policy remains open and requires a fresh, independently labeled evaluation.
