# Setup destinations

`index.html` owns the shared Setup shell, navigation, styles, and browser runtime. Destination panel markup lives here and is assembled by `src/setup-page.mjs` before the server responds. Keep each fragment self-contained and list it in `DESTINATION_PARTS`; unresolved or missing fragments fail page startup instead of silently disappearing.

The matching local HTTP handlers are grouped by destination in `src/setup/routes/`:

- `find.mjs`: Ask and citation reads.
- `review.mjs`: proposals, decision reviews, conflicts, and tidy actions.
- `handoffs.mjs`: mailbox changes and handoff receipts.

`ui/app/` is a separate desktop application with its own host bridge, store API, views, and tests. It remains a distinct client; it does not replace Setup or share Setup's page fragments.
