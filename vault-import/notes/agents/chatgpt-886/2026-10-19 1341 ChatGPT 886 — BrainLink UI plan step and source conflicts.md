---
type: plan
ai_platform: Grok Bot
agent_or_role: ChatGPT 886
session_or_task_id: brainlink-step3-ui-2026-10-19
written_at: 2026-10-19T13:41:09+08:00
source: "Drive 1wkbEH6nkj3lBYXHdjSvBlulhgUVAr7Mb (00 MAP), 1MWnISJ2aBGK5h8xPVIXruaMT7PxEEYiG (joint plan), 1Mk0DOGnCb5ZN8CMm503BEIShbVBsVQ__ and 1NyuWcYP4CEpxBzOnOgHYW8Jrok5s9sgh (Paulo plan + addendum), 1xhj5UJIjPUyUyMgwTyiutdX3niOf_Hzn (PRODUCT-SPEC), BrainLink folder 1anp9J-nBZZlZTQXOsueMlZ-fE_489RZC, 1BKa-wMwhsBoekCozwCKro8BXv7_RqGd- (Anna 3D); box /workspace/brainlink-store/interface.d.ts v0.1"
confidence: high
status: active
version: "1.0"
tags: [brainlink, ui, plan, step-3]
---
Made by ChatGPT 886.

1. Read: the sources above. Plan: 4 commits in order (1 Connect+Sessions+Search, 2 editor, 3 settings/sync, 4 light 2D graph), store API only, tests green per commit.
2. Code location: brainlink-src has no ui/ folder yet (Drive source/ has none either), so code is staged in /workspace/brainlink-ui/ui with its own git; drop-in copy later.
3. Conflict: contract v0.1 has no search, sessions or connector calls, though the joint plan says it covers sessions. UI uses a services stub; mapping goes to Claude 886.
4. Conflict: contract Scope names 'personal' and 'livva', but the spec bans Iango vault names in product code. Suggest generic scopes (shared / private).
5. Conflict: memory-store.mjs is not in brainlink-store yet; UI runs on a mock with the same method names until it lands.
6. Conflict: sync choices. Paulo plan = Local only (default), Google Drive, iCloud, Dropbox; spec says Team sync is out of v1; Git is in neither, so the UI shows Git as later.
7. Conflict: addendum drops dates, joint plan targets a Mac .pkg Wed 10-21. Following the joint plan (later order).
8. Conflict: earlier brief said upload wireframes.html to Drive; the newer rule keeps code off Drive, so only notes and PNG screenshots go to Drive.
9. Box runs Node 20; repo engines say Node 22. UI tests use only node:test so they run on both.
10. Blockers: none for milestone 1.

## Changelog
- 2026-10-19 13:41 v1.0 created.
