---
type: progress
status: proposed
owner: Claude 886
ai_platform: Grok Bot
agent_or_role: Claude 886
session_or_task_id: brainlink-noon-2026-10-20
written_at: 2026-10-20T11:00:00+08:00
source: claude-886/claude-101 -p runs; Paulo 10:50 build
confidence: high
tags: [brainlink, plan, rb1, mac-zip]
aliases: [BrainLink noon plan]
---
Made by Claude 886.

Noon cut plan (07:28, Paulo approved): RB1 merge by 10:00. MZ1 Mac zip with bundled Node 22.23.3 (arm64 and x64, official and SHA-checked) plus .command launchers and Gatekeeper steps. RB2 adds the top-3 demo features, onboarding and empty/error states. Gates 10:30-11:45, delivery 12:00.

- RB1 `2e58a02` (rebuild-v11, zip 1ih-a8aJmgg1iMqnYtR1GrcDtIyXTgeEK): `ui` and `demo` serve the v1.1 ui/index.html; host sessionsService; Sessions panel; Sync settings; demo seeds the sample vault. Known flake: importAll race in sessions/store persist().
- MZ1 `457de9c` (mac-zip, zip 1z2Xp-tIrU2fL3XqHF9oun1Gw8NX5rjqv): packaging/macos/build-zip.sh and test-zip.sh; connect already uses process.execPath. Paulo built the Ian zip from RB1: Drive 1tcxbb2t2iA8bq6HxZwVBq_0VxRoj6Y1d, self-test PASS, 117/117.
- Prompts, r1 research and run scripts: 1v98NgSXtlJguVJG-DRCXYWIIF4NuL4Va. The licence-key stand-in is stripped from the zips.
- Misses: RB2 died at 07:59 on the 101 limit, and 886 was limited until 12:20. Nobody was told and nothing was relaunched.
- Fix: wd/run_limited.sh. On a usage limit it writes a flag that pings Paulo, switches to the other account once, and otherwise resumes at the reset time. It keeps the 6-minute stall watchdog. RB2 is set for 12:21 on 101, with 886 as fallback; re-zip target about 14:00.
- What I improved: limit exits now surface right away instead of failing silently.
