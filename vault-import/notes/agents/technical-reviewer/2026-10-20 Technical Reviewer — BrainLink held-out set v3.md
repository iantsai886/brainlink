---
ai_platform: Grok Bot (set written by paid Claude Pro, [account], with Google Drive integration)
agent_or_role: Technical Reviewer
session_or_task_id: "Paulo task 2026-10-20 BrainLink held-out set v3 (claude.ai chat 93a0521c-e1c4-47c6-a916-9ad65243e46f)"
written_at: 2026-10-20T07:50:00+08:00
source: "Brain vault via 00 MAP.md (1wkbEH6nkj3lBYXHdjSvBlulhgUVAr7Mb), 00 INDEX notes and Drive search"
confidence: medium-high
status: final
title: "BrainLink held-out set v3"
type: eval-gold
storage_rule: "Drive only; never on the box; copy into sandbox only at scoring time"
---
Made by Grok Bot (Technical Reviewer).

Method: written blind by paid Claude, which hadn't seen the BrainLink build, its word lists or earlier test sets, and was told to skip Brain/Grok/Technical Reviewer, Ian Personal and Ian Livva. C1–C8 and C10–C12 are mostly Traditional Chinese questions whose answers sit in English notes. C9 and C11 mix Chinese and English, and C10 uses a loose paraphrase. T1–T2 are traps whose correct answer is "not in Brain".

| id | question | gold Drive file id(s) | note title | confidence | evidence |
|---|---|---|---|---|---|
| C1 | Hostinger 的網站主機（Web Hosting）可以拿來放內部知識或私人 intake 服務嗎？ | 1fj5_zk29N3HEpeDPfnyW8T6PiU3M5caT | Hostinger Access Runbook | high | "public Iango website and client portals only; never use it for private intake" |
| C2 | 共用電腦上的付費 Gemini 座位主要負責哪一類工作？ | 1_r1HTmOhiu_ao7PaDx84j8uV2fs59mjz | Paid AI Seat Allocation | high | "Video / multimodal: transcription, YouTube/FB video understanding, screenshots" |
| C3 | 東京動物醫院的試點計畫建議做多久，主要想改善哪個環節？ | 10fbPl2fEtPb_qmlLSix2OPuDobah49l7 also: 1EBM7LQrju3ssGMP420l01EW_yuPXWRYh | Tokyo Veterinary Operations Pilot | high | "one 30-day pilot to reduce avoidable consultation-to-checkout waiting" |
| C4 | Evo 2 噬菌體研究大約合成了多少個設計，最後有幾個能複製並殺死細菌？ | 1YNW8JNicCZeWYwS-oPksNUaYipklHURs | Evo 2 AI Designed Bacteriophages | med | "synthesized roughly 300, and found 16 that replicated and killed bacteria" |
| C5 | Opportunity Scout 後來併入哪個 agent？晨間研究簡報變成什麼形式？ | 1gKcfODYTEiKzAO97Ouvc8JC-MFugZz4y | Org Note — Opportunity Scout Merged into Scout | high | "Scout owns morning research as a two-section brief" |
| C6 | 威瑪舒培主管儀表板為什麼改用 Google 地圖？每月免費額度是多少？ | 19ALwziJmckj5Y_faMZYw3uMdEFOuw648 | 2026-10-01 Google Maps Dashboard Checkpoint | high | "OpenStreetMap volunteer tile server returned 403… 10,000 free monthly loads" |
| C7 | Soup 這個微調工具是什麼授權？可以拿客戶資料來訓練嗎？ | 1vKf4Mhuhs-B7QJN9EhHx4HuhEnwOln4O | Soup LLM Fine Tuning CLI | high | "Apache-2.0… do not train on client/Iango proprietary data" |
| C8 | Yohei 的主打歌是哪一首？ | 1AlRGPSKILD47zwrVRcHZrjSxhLEVYib3 | Yohei Artist Development - Session Capture 2026-09-15 | high | "Lead song: Hitorikiri No Sekai." |
| C9 | When we pitch a new 客戶, should Iango present itself as a 系統整合商, or as something else? | 1rMGM-Y_l9O9vpuMOlVG8ptEQqTAek3n1 | Iango Client AI Agent Positioning | high | "AI Agent operating-assistance layer for industrial upgrade, not merely… data-integration vendor" |
| C10 | 哪個 bot 是我們的 pricing watchdog，負責避免買錯 model？ | 1mx5rP7B0Q8u-PdDxR_ScyrqfH-seBVNp | Company Bench — What they do | med | "Scout… Stops us buying the wrong model or installing a toy." |
| C11 | For the Twin's photo search, do the customer's 原始照片 get moved to the cloud, or do they stay where they are? | 1s4p2m_2AsDlJMwPv7atZGKwwfhu_0Ofb | Personal Wisdom Twin — Local Photo Intelligence Pipeline | high | "Original customer photos remain in the customer-controlled folder." |
| C12 | Google 那個讓 AI agent 直接 checkout 的 open standard，我們決定導入還是先觀望？ | 1TsR4FifLg3aPdBAIc9E7DLY6n5AY2BRi | Google Universal Commerce Protocol and Gap Agentic Commerce Case | high | "Decision: Monitor." |
| T1 | Ian 最近一次健康檢查的血壓和膽固醇數值是多少？ | not in Brain | — | med | No Brain note has personal medical values; should refuse or say not found. |
| T2 | Ian 每個月固定給家人多少生活費？ | not in Brain | — | med | No amount found. The John intake checklist (1R17fvofA6pydk8qRFYhEfWXgEhvlV6jN) has only a blank "Family support" field, so it's a near-miss decoy. |

## Ambiguous rows and scoring notes
- C3: Japanese Veterinary Workflow Software Candidates is a valid secondary hit, but it doesn't state the 30-day pilot.
- C4: the numbers come from the source reel claim, so the confirmed figures may differ slightly.
- C5: an older note with the same title (14iFzdbVYNuE61FgRIz_aRCjKG109jy3M) is superseded. Returning that id counts as a miss.
- C10: a loose paraphrase. Paid AI Seat Allocation is a possible near-miss.
- T1–T2: "not in Brain" is proposed rather than proven, because Drive full-text search is fuzzy.

## Flags for Anna Bridge (stewardship, no change made)
- Notes on John's personal finance, including actual holdings, sit under Brain/00 Home. That conflicts with the rule that personal finance stays out of company Brain, and BrainLink would expose them.
- The Paula Personal Secretary note (1iey9IB8bx6Nkev-yd0G4GvxETTgxsPlI) came up in a health search. It sits outside Brain, so it's a reminder to check BrainLink's scope.
