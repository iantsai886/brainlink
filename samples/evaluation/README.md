# Frozen retrieval evaluation corpus

This is a dedicated, fictional copy of the Acme Studio sample vault for BrainLink retrieval evaluation. It includes one private canary note whose contents must not affect search ranking or appear in results. The corpus is a development benchmark, not an independent held-out customer dataset and not evidence of production token savings.

The independent held-out retrieval benchmark is separate: `retrieval-independent-v1.json` uses `independent-vault/` and includes fictional personal, organisation, and client tasks plus private, excluded, and foreign-profile canaries. See `docs/RETRIEVAL-EVAL.md` for the fixed candidate policy and reproducible command. Do not tune that policy on the held-out fixture.

The checked-in machine-readable result is `reports/retrieval-independent-v1.json`; it binds the exact fixture bytes to evaluator commit `ec6bbfd` and its recorded environment.
