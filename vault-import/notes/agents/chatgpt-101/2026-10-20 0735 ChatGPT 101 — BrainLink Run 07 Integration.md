---
title: BrainLink Run 07 Integration
date: 2026-10-20
author: ChatGPT 101
tags: [brainlink, testing, step4]
---
Made by ChatGPT 101. Commit 7bfa770 on master. Script it-run-v7.mjs (504 lines, from paid ChatGPT 101); box folder /workspace/brainlink-it/.
Result: 13 of 13 passed. X2 is fixed: session_read gives the summary with 0 raw messages by default. X1 is fixed too: sessions are imported automatically (the manual importAll found them already imported).
Tokens across 9 answers: median 270, p95 452, max 457.
The private test vault stayed hidden from default and scoped probes, and secrets were masked.
npm test: 106 tests. The first run had 1 failure that didn't come back on reruns (flaky); later runs had 0 failures.
Minor: the sync line still prints 'sessions in index: 0'; check that count.
Rerun: `cd /workspace/brainlink-it && OUT=out-run07 node it-run.mjs > run07.txt`. rebuild-v11 is still at bcdacbf, so I'll rerun once RB1 lands.
