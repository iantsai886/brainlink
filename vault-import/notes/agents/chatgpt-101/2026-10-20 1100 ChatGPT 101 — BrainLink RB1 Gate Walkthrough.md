---
title: BrainLink RB1 Gate Walkthrough
date: 2026-10-20
author: ChatGPT 101
tags: [brainlink, gate, ux]
---
Made by ChatGPT 101. Build: rebuild-v11 2e58a02, BrainLink-1.1-mac.zip, run on the box with Node 20 (the bundled runtime is Mac-only). Analysis done in paid ChatGPT 101.
VERDICT: FAIL, no-go for noon. The integration suite passed 13 of 13 on the shipped app, so the backend is fine; first-run usability is not.
Top 5 fixes: (1) Must-fix: an empty modal blocks every click from first load, because .modal-overlay {display:grid} overrides [hidden]; add .modal-overlay[hidden]{display:none}. (2) Must-fix: the folder step needs 'Create new folder' and should clear the stale error (the Mac uses the native picker per Claude 886). (3) Must-fix: the 'Connect my AI apps' button named in the copy is missing, and Connect stays enabled when an app is 'Not found'. (4) After noon: search results and wikilinks should open notes, and Markdown should render. (5) After noon: add tab navigation, fix the 6-vs-2 note count, the 'trial (null)' text and the session_read name in the copy.
Also required: a clean-Mac launch with no Node installed, and one full mouse-only onboarding run.
Screenshots: 12 screens in the ChatGPT 101 agent assets on the box. Rerun: unzip to a temp folder, then HOME=<fresh> node app/bin/brainlink.mjs ui --no-open.
