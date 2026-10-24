# Frozen session-filing evaluation corpus

This isolated fictional vault and its 20 labelled cases evaluate conservative session-folder suggestions. It includes ambiguous cases, deliberate abstentions, and a private canary that must not influence a suggestion. It is a development benchmark, not customer data or independent evidence of production accuracy, token savings, or cross-client handoff.

Run `node bin/brainlink.mjs eval-filing --fixture "$PWD/samples/evaluation/filing-rsi-v1.json"` after pointing a local BrainLink config at this sample vault as `Acme Filing Eval`. The report contains only opaque case IDs and aggregate metrics. No fixture vault files or routing configuration are changed.
