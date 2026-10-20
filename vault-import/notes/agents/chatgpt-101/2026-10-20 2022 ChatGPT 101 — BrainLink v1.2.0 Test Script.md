---
title: BrainLink v1.2.0 First-Time User Test Script
date: 2026-10-20
author: ChatGPT 101
tags: [brainlink, gate, test-script]
---
# BrainLink v1.2.0 — First-Time User Acceptance Test

**Test:** Wednesday, October 21, 2026, 12:00–14:00 Taipei  
**Release deadline:** 15:00  
**Environment:** Fresh HOME, no BrainLink configuration. Real mouse clicks only; keyboard permitted solely for folder naming and question text.

**Timing:** Steps 1–6 must finish in **under 5:00**, continuously. Claude 886 repeats the complete path on Ian's Mac with timestamped screenshots. Linux box checks alone cannot certify Mac installation.

## A. Test script

| # | Action / Environment | Expected result | Budget | Screenshot |
|---|---|---|---|---|
| 1 | **Mac-only:** Download ZIP through browser | Correct release ZIP downloads | 0:35 | 01-download.png |
| 2 | **Mac-only:** Install, launch BrainLink.app | Opens without Terminal; LaunchAgent works | 0:45 | 02-launch.png |
| 3 | **Mac-only:** Pick or create and name brain folder | Native picker; named folder validated | 0:50 | 03-folder.png |
| 4 | **Mac-only:** Connect one AI app | Actual connection verified; no false success | 0:55 | 04-connect.png |
| 5 | **box:** Ask a project question | Readable answer with clickable citations | 0:55 | 05-answer.png |
| 6 | **box:** Click citation in 3D view | Correct note opens; readable Markdown | 0:40 | 06-note.png |
| 7 | **box:** Add agent | Agent created and appears in UI | Extra | 07-agent.png |
| 8 | **Mac-only:** Two-AI handoff | Verifiable receipt identifies both AIs | Extra | 08-handoff.png |
| 9 | **box:** Toggle Drive snapshot | State saves; clear enabled/disabled feedback | Extra | 09-drive.png |
| 10 | **box:** Switch EN → zh-TW → PT | Labels translate; state persists | Extra | 10-languages.png |
| 11 | **box:** RB2 regression checks | User-only note count accurate; setup title/close gone; phrases not fake buttons; Markdown and wikilinks work | Extra | 11-regression.png |
| 12 | **Mac-only:** Import seeded Claude/Codex sessions | Both appear automatically; indexed count nonzero | Extra | 12-sessions.png |

**Core budget: 4:40 + 0:20 buffer.**

## B. Confusion log

`Time | Step | Hesitation >5s / Wrong click / Unclear label / Dead end | What happened | Seconds lost | Screenshot`

Flag every visible: `MCP`, `token`, `session_read`, `session_log`, `config path`, `trial`, `brainlink_guide`, `JSON`, or `localhost URL`.

## C. PASS / FAIL rules

**PASS:** Complete core flow under 5:00, zero dead ends, no hard failures; all additional checks work.

**HARD FAIL:**
- Installation requires Terminal or manual configuration.
- Folder picker/create/name fails.
- Connection falsely reports success.
- Answer lacks a citation or cited note cannot open in 3D.
- Automatic session import fails with seeded fixtures.
- Two-AI handoff claims success without a real receipt.
- Blocking modal, broken navigation or missing required controls.

Record all confusion moments and jargon separately. Missing Mac-only evidence means **NOT VERIFIED**, never PASS.

## D. Ranked fix-list format

`Rank | P0/P1/P2 | Failed step | Exact symptom | Smallest fix | Owner | ETA | Retest screenshot`

**P0:** Blocks installation/core journey.  
**P1:** Required feature broken or misleading.  
**P2:** Cosmetic, wording or discoverability.

**Decision deadline:** 14:00. Unresolved P0 = NO SHIP.

I can turn the completed test log into a ranked release decision for Claude 886.

Written in paid ChatGPT 101 from prompt /workspace/brainlink-it/prompt-v120-plan.md. Box copy: /workspace/brainlink-it/v120-test-script.md.
Made by ChatGPT 101.
