# P0-1: verdicts for the original 29 failing tests

Source: `BrainLink handover to ChatGPT finish the failing tests.md`, section “The 29 failures”. These verdicts classify the original failures, not the current passing tests. “Outdated” means the test expected a retired interface or implementation detail; it does not mean a privacy boundary was relaxed. “Code regressed” means the observed behavior violated the current contract and was fixed in the integration branch.

| Original test | Verdict | Resolution and preserved protection |
| --- | --- | --- |
| `twin-profiles.test.mjs:741` semantic-only manual access | Code regressed | Fixed note memory-type classification/filtering; procedural canaries remain denied without procedural grant. |
| `twin-profiles.test.mjs:790` stale index body | Test outdated | Set policy on the active grant, the runtime source of truth; stale indexed content is filtered before ranking and direct reads. |
| `twin-profiles.test.mjs:826` profile-scoped session reads | Test outdated | Updated fixture to activate the intended profile and session scope; cross-profile session canaries remain denied. |
| `twin-profiles.test.mjs:499` private session capture | Test outdated | Updated expected session record shape/policy fixture; private session content still requires explicit session permissions. |
| `twin-profiles.test.mjs:589` memory policy at tools/resources | Test outdated | Test now configures grant policy; tool, prompt and resource boundaries use the same grant decision. |
| `twin-profiles.test.mjs:676` disabled memory types | Test outdated | Fixture now activates a configured role and grants; disabled types remain filtered from search and reads. |
| `twin-profiles.test.mjs:123` session capture policy | Test outdated | Updated grant-based policy fixture; content capture and full text remain opt-in. |
| `twin-profiles.test.mjs:84` proposed-note privacy | Test outdated | Updated assertion to the current proposal-only wording and grant model; proposals are not promoted to trusted notes. |
| `twin-profiles.test.mjs:360` granted vaults and tools | Test outdated | Updated copy assertion to current permission terminology; vault and tool allowlists remain grant-filtered. |
| `typed-graph.test.mjs:311` cross-profile relationship proposal | Test outdated | Updated expected rejection wording/context; mismatched profile scopes are still rejected. |
| `brainlink.test.mjs:964` activation memory switches | Test outdated | Rebuilt test context around named role activation; each grant's memory switches remain applied. |
| `brainlink.test.mjs:1225` named activation gates | Test outdated | Updated fixture for the current activation response; named activation still uses Twin permission gates. |
| `twin-profiles.test.mjs:1193` unowned Setup session assignment | Test outdated | Updated fixture to current session record shape; assignment remains limited to session-authorized Twins. |
| `handoff-git-verification.test.mjs:48` assigned local clone | Test outdated | Added current confirmed repository assignment to fixture; unassigned clones remain unavailable. |
| `handoff-git-verification.test.mjs:91` scoped handoff checkpoint | Test outdated | Updated scoped handoff fixture; checkpoint comparison remains restricted to the same Twin. |
| `proposal-inbox.test.mjs:31` proposal-only preview | Test outdated | Updated expected API response shape; preview remains non-writing until owner confirmation. |
| `proposal-inbox.test.mjs:50` owner approval save | Code regressed | Fixed missing parent-folder creation on the confirmed write path; still creates only the approved new note. |
| `rsi-weekly.test.mjs:89` authenticated weekly benchmark | Test outdated | Updated authentication/setup fixture; unauthenticated Setup APIs remain denied. |
| `twin-profiles.test.mjs:29` multiple Twin declarations | Test outdated | Replaced obsolete single-profile validation expectation with multi-Twin validation; invalid references still fail. |
| `twin-profiles.test.mjs:1017` preset AI app grants | Test outdated | Updated preset validation wording and fixture; only explicitly selected grants are assigned. |
| `twin-profiles.test.mjs:1229` Setup Twin choices | Test outdated | Updated supported-action validation expectation; unsupported actions remain rejected. |
| `twin-profiles.test.mjs:1376` independent vault grants | Test outdated | Updated access-proposal response expectation; each grant is still individually scoped and confirmed. |
| `twin-profiles.test.mjs:164` Twin status scope | Test outdated | Updated expected status representation; status continues to expose only the runtime scope. |
| `twin-profiles.test.mjs:988` authenticated local status | Test outdated | Updated status response shape; authentication remains required and grants remain filtered. |
| `twin-profiles.test.mjs:1087` Harness named profile | Test outdated | Updated activation fixture to current profile-scoped flow; Harness receives only its selected profile grants. |
| `locales.test.mjs:49` connection dialog | Test outdated | Replaced raw-source expectation with rendered behavior/localization checks; read/propose controls still follow grants. |
| `twin-profiles.test.mjs:193` local UI profile choices | Test outdated | Updated test to rendered Setup behavior; only valid selected choices create a profile. |
| `twin-profiles.test.mjs:226` checked memory types summary | Test outdated | Replaced source-string expectation with behavior coverage; summary reflects checked grant types. |
| `twin-profiles.test.mjs:267` permission controls | Test outdated | Fixed the test harness to provide browser CSS globals and exercise controls; disabled actions still clear/restrict state as specified. |

## Evidence and limits

The integration branch's current core and UI suites are the regression evidence for the resolutions above. The original handover did not retain an individual TAP result for every case, so classifications that depend on a changed fixture/assertion are based on the recorded failure and corresponding test/code change, not a replay of the old 685-test checkout. No privacy assertion was weakened to obtain a pass. The permission-related tests now use grant-based state, and the regression suite plants private and cross-profile canaries.
