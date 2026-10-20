#!/usr/bin/env node
// BrainLink search-quality check on this Brain vault, read-only (writes off, no Home map).
// Gold sets: Technical Reviewer "BrainLink independent gold set" (TR) and "held-out set v2" (H),
// matched by note title. Questions are typed as written; H questions also carry the English
// translation a connected AI would add. Evaluation notes are excluded (they hold the questions).
// Run from anywhere with Node 22+:  node "<this file>"  [--set TR|H|all] [--show]
// Baseline 2026-10-19 (BrainLink 1.1): TR 27/28 top-5, MRR 0.818, 0 false not_in_brain;
// H 6/7 with translation, MRR 0.607. Traps: Chinese traps get "weak" (translate first), not
// not_in_brain. A change should not lower top-5 or MRR, nor add any false not_in_brain.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../source/src');
const BRAIN = path.resolve(HERE, '../../../..'); // Brain/20 Iango/Projects/BrainLink/eval → Brain
const imp = (f) => import(pathToFileURL(path.join(SRC, f)).href);
const { normalize } = await imp('config.mjs');
const core = await imp('core.mjs');
const home = await mkdtemp(path.join(tmpdir(), 'brainlink-eval-'));
const cfg = normalize({ vaults: [{ name: 'Brain', path: BRAIN, writes: 'off', map_note: null }] });
await writeFile(path.join(home, 'config.json'), JSON.stringify(cfg));
const ctx = core.createContext(cfg, { env: { BRAINLINK_HOME: home, BRAINLINK_SEMANTIC: process.env.BRAINLINK_SEMANTIC || '0' }, license: { valid: true, plan: 'trial' } });
// Leave out the evaluation notes and BrainLink's own project folder (its docs describe this evaluation).
const EVAL_NOTES = /BrainLink (independent gold|held-out|RSI|v0\.\d rerun)|RSI Lab - BrainLink|^20 Iango\/Projects\/BrainLink\//;
const args = process.argv.slice(2), show = args.includes('--show');
const which = args.includes('--set') ? args[args.indexOf('--set') + 1] : 'all';
// [id, question, gold title patterns | null for traps]
const TR = [['Q01','Where is the single canonical synced copy of all the Obsidian vaults kept?',[/AI Platform Vault Access Rule/]],
 ['Q02','Which paid AI seats did Ian install on the shared box?',[/^Paid AI Seat Allocation$/]],
 ['Q03','What is the Kdenlive MCP project?',[/Kdenlive MCP/,/sidecar/i]],
 ['Q04','Where is the append-only log of Chairman decisions?',[/Chairman Decisions Log/]],
 ['Q05','What did the RSI Lab patrol find about line-bot-starter?',[/2026-10-17 GitHub Patrol/,/2026-10-17.*RSI/]],
 ['Q06','How does hashguard work and how is it used?',[/Hashguard design/i,/Memento pilot/i]],
 ['Q07','Which note tells agents to improve themselves daily without waiting for Ian?',[/Self-Improve Daily/]],
 ['Q08','How does a Grok agent query the Brain index from the box?',[/^Brain search — how any Grok agent/]],
 ['Q09','Which note sets the format standard for Brain notes?',[/AI-Agnostic Second Brain Principle/]],
 ['Q10','Why use MCP when we already have APIs?',[/Why MCP when we have APIs/i]],
 ['Q11','Which plan recommends selling one productized service to Taiwan SMEs first?',[/Iango AI Money Plan/]],
 ['Q12','Which scan said agent summaries quietly turn guesses into facts?',[/2026-10-17 Daily AI Scan/,/2026-10-17.*Paulo/]],
 ['Q13','What is the new shared MCP that lets any AI read and write the vaults (announcement and details)?',[/2026-10-17-1030/,/second-brain.*v0\.2|v0\.2.*second.brain/i]],
 ['Q14','What did the Anna Bridge fix packs of 10-09 change?',[/2026-10-09 Fix pack/i]],
 ['Q15',"What is the current version of ChatGPT 886's offer page?",[/offer page v1\.2/]],
 ['Q16','What display name must be used for the mountain house land?',[/Place-name lock/]],
 ['Q17','Which LINE AI 店長 offer sheet is the latest (Anna PASS)?',[/offer sheet v3 \(ON HOLD/,/offer sheet v3 \(Anna PASS/]],
 ['Q18','Which is the newest 店長 10-minute walkthrough?',[/walkthrough v1\.3/]],
 ['Q19','What are the five Hermes Agent features from 漢克蔡 (current note, not the superseded one)?',[/Hermes Agent Five Features/]],
 ['Q20','山上的地名是月眉還是越美？',[/Place-name lock/]],
 ['Q21','威瑪舒培從驗收到付款怎麼銜接？',[/Acceptance-to-Payment Bridge/]],
 ['Q22','業務外勤日報要自動化的需求是什麼？',[/業務外勤日報自動化需求/]],
 ['Q23','VoIP 閘道器有哪些合規風險？',[/VoIP 閘道器供應商與合規風險/]],
 ['Q24','明怡基金會的會議要準備什麼？',[/明怡基金會/]],
 ['Q25',"What is in John's personal finance office budget?",null],
 ['Q26','What is in the Livva family health records?',null],
 ['Q27','Vault Brain 的檢索限制，可以當成 Obsidian 無法寫入的理由嗎？',[/Obsidian 寫入與驗證檢查清單/]],
 ['Q28','威瑪舒培客戶問離線時進店、離店打卡還能定位嗎？該怎麼回覆？',[/客戶離線 GPS 問答與收尾/]],
 ['Q29','LINE AI 店長前 3 家店的建置費和月費是多少？',[/Revenue plan and 店長 intro pricing/,/offer sheet v3 \(ON HOLD/]],
 ['Q30','威瑪舒培客戶回報拜訪畫面卡住，新版做了哪些調整？',[/Client Visit Screen Stuck|客戶回報拜訪畫面卡住/]],
 ['T1','Ian 最近一次健康檢查的血壓和膽固醇數值是多少？',null],
 ['T2','Ian 家每月房貸要繳多少？還剩幾年？',null]];
// [id, english translation, question, gold] or [id, question, gold] when already English
const H = [['H1',"What did we conclude after evaluating appointment management systems used by Japanese animal hospitals?",'日本動物醫院用的看診管理系統，我們評估後的結論是什麼？',[/Japanese Veterinary Workflow Software/i]],
 ['H2',"AI designed viruses that kill E. coli bacteria; how many worked in the experiment?",'我記得有一則筆記在講 AI 自己設計出能殺死大腸桿菌的病毒，最後實驗真的成功的有幾個？',[/Evo 2/i]],
 ['H3',"open-source command-line tool for LoRA fine-tuning small models on my own computer without renting cloud GPUs",'想在自己的電腦上用 LoRA 微調小模型、不想租雲端 GPU，Brain 裡記錄過哪個開源指令列工具？',[/Soup/i]],
 ['H4',"Google open standard that lets AI agents place orders and check out for customers; is it compatible with MCP?",'Google 那個讓 AI 代理直接幫顧客下單結帳的開放標準，跟 MCP 相容嗎？',[/Universal Commerce Protocol/i]],
 ['H5',"convert a thick scanned PDF to Markdown while keeping the layout; which skill and what hardware is needed",'我手上有一份很厚的掃描版 PDF，想轉成 Markdown 又要保留版面，我們有哪個技能可以用？需要什麼硬體？',[/unlimited-ocr/i]],
 ['H6','Before I sign an NDA or a lease, which skill should go through the fees, liabilities and deadlines for me?',[/contract-risk-review/i]],
 ['H7',"skill card for an on-site client interview where the AI acts like a senior consultant, keeps probing pain points and does not jump to solutions",'下週要跟新客戶做現場訪談，我希望 AI 像資深顧問一樣一直追問痛點、先別急著給方案，有對應的技能卡嗎？',[/consultative-client-live-interview/i]],
 ['T1',"What medicine does Ian take every day and what dose did the doctor prescribe?",'Ian 現在每天固定在吃什麼藥？醫生開的劑量是多少？',null],
 ['T2',"How much money does Ian give his parents each month?",'Ian 每個月給爸媽多少孝親費？',null]];
const est = (s) => { let n = 0; for (const ch of s) n += /[\u3400-\u9fff]/.test(ch) ? 1 : 0.25; return Math.round(n); };
async function score(name, G) {
  let hits = 0, rr = 0, ans = 0, abst = 0, traps = 0, falseAbst = 0, tok = 0; const miss = [];
  for (const row of G) {
    const tr = row.length === 4, q = row[0], text = tr ? row[2] : row[1], gold = tr ? row[3] : row[2], queries = tr ? [row[1]] : [];
    const out = await core.searchWithVerdict(ctx, 'Brain', text, { limit: 5, exclude: EVAL_NOTES, queries });
    tok += est(JSON.stringify(out));
    if (!gold) { traps++; if (out.status === 'not_in_brain') abst++; continue; }
    ans++; if (out.status === 'not_in_brain') falseAbst++;
    const rank = out.results.findIndex((r) => !r.historical && gold.some((g) => g.test(r.title)));
    if (rank >= 0) { hits++; rr += 1 / (rank + 1); } else miss.push(`${q}: ${out.results.slice(0, 3).map((r) => r.title.slice(0, 50)).join(' | ')}`);
  }
  console.log(`${name}: top5 ${hits}/${ans} · MRR@5 ${(rr / ans).toFixed(3)} · false not_in_brain ${falseAbst} · traps refused ${abst}/${traps} · ~${Math.round(tok / G.length)} tokens/question`);
  if (show && miss.length) console.log('  missed:\n  ' + miss.join('\n  '));
}
await core.loadVault(ctx, 'Brain');
if (which !== 'H') await score('TR gold set', TR);
if (which !== 'TR') await score('Held-out v2', H);
