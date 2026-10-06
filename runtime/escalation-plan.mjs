#!/usr/bin/env node

/**
 * 「这一轮要不要唤醒修复 agent」—— **只读**判据 + 一份给人/给 agent 的派单（2026-09-29 加）。
 *
 * 为什么需要这个脚本（第一性原理）：
 *   脚本（`run-daily-job.mjs`）是 shell 子进程，它**没有** `Agent` / `SendMessage` 这类
 *   模型侧工具 —— 所以**让脚本自己唤醒 WorkBuddy 对话是不可能的**。能把 agent 叫起来的
 *   只有一个 **WorkBuddy 会话**（定时任务本身就是）。
 *   于是把这件事拆成两半：
 *     · **脚本侧**：失败时把现场落成事实（`98-failure-state.*`）、写修复请求单
 *       （`97-repair-request.json`）、必要时驻留 —— 这些 1.7.6/1.7.7 都已经做到了；
 *     · **会话侧**（定时任务）：跑完读这份「派单」，有需要就派一个后台修复 agent。
 *   本脚本就产生那份**派单**。它**只读**：不碰浏览器、不碰飞书、不写飞书、
 *   不改任何状态，只把「哪几家需要救、去哪读现场、按什么顺序试」汇总出来。
 *
 * 三层降级（用户 2026-09-29 定）：
 *   ① 脚本自己修（`--auto-repair`）；
 *   ② 修不动 ⇒ 唤醒修复 agent（**不先用飞书叫人**）；
 *   ③ agent 也修不动 ⇒ 才发飞书。
 *   所以本脚本产出的派单是「第 ② 层」的输入，**不是告警**。
 *
 * 触发判据（任一条成立即需要 agent）：
 *   · 某店 `record.autoRepair.gaveUp` 非空（脚本自己修过但没救回来）；
 *   · 某店 `record.repairRequest.candidates` 为空（成因没登记修法 —— 用户口径：这一档
 *     不该出现，遇到就交给 agent／人，而不是直接放弃）；
 *   · 某店 `repairRequest.cause` 落在「交给 agent 更好」的成因里（读不到类 / 落位类）。
 *
 * 用法：
 *   node runtime/escalation-plan.mjs --date yesterday                  # 打印（默认；定时任务用的就是这条）
 *   node runtime/escalation-plan.mjs --date 2026-09-28                 # 补跑历史日
 *   node runtime/escalation-plan.mjs --date 2026-09-28 --json          # 机器可读
 *   node runtime/escalation-plan.mjs --summary <path/to/summary.json>  # 指定结论文件
 *
 * `--date` 的字面量口径**复用链那一份**（`date-picker.mjs` 的 `resolveTargetDate`）：
 * 2026-10-06 之前这里只收 `YYYY-MM-DD`，而定时任务 prompt 里写的是 `--date yesterday`
 * ⇒ 那条命令每次都落进「`--date` 要 YYYY-MM-DD」⇒ 读不到结论 ⇒ **第 ② 层降级
 *（唤醒修复 agent）静默空转**（同一处已复现 4 次）。在这里另写一份「昨天」就是把
 * 「Asia/Shanghai 的昨日」抄到第二个地方，迟早与落位脚本漂开。
 *
 * 退出码：0＝不需要 agent（或已列出需要 agent 的清单）｜1＝读不到结论（不猜）。
 *   ⚠️ 它**不是**「有没有失败」的判据 —— 有没有失败看 summary 与底单行数。
 *   它只回答「要不要把失败交给 agent」。
 */
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { unfixableShopsOf } from './hold-and-resume-plan.mjs';
import { isWaitingOperatorAccountStatus } from './daily-report-shop-gates.mjs';
// `--date` 的字面量口径：**只此一处**。`date-picker.mjs` 是叶子（它只依赖 runtime 的
// browser-ports / target-url-match），所以这条 runtime → skills 是「复用」，不是倒灌。
// **不能**改成 import 驱动 `run-multi-shop-day.mjs` —— 那个文件 import 了本文件
//（`classifyShopEscalation`），反向再 import 就成环，而成环之后两边都加不进新东西。
import { resolveTargetDate } from '../skills/sycm-alimama-daily-report/scripts/date-picker.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 「交给 agent 比交给人更合适」的成因（用户口径：脚本解决不了就该 agent 上）。
 *
 * ⚠️ 这是**派单优先级**，不是「要不要人」的闸门 —— 需要人的最终判据仍是分诊表。
 * 放在这里是因为：这几类成因的共同点是「现场还能救，缺的是一次对症的动作」，
 * 而 agent 恰好能读现场 + 从菜单里挑动作 + 重试。
 */
export const AGENT_PREFERRED_CAUSES = Object.freeze(['STAGE_FAILED', 'PAGE_OBSTRUCTED', 'SHOP_BLOCKED']);

/** 成因 → 「为什么该交给 agent」的一句话（派单里给会话读）。 */
export const AGENT_REASON = Object.freeze({
  STAGE_FAILED: '阶段失败的成因多是「页面现场不对」（日期没落上/元素不理会点击），agent 读现场后挑一个动作再重试通常能救。',
  PAGE_OBSTRUCTED: '全屏遮挡层关不掉时，脚本已按设计停手；agent 可以换一个现场（重载）再试。',
  SHOP_BLOCKED: '页面不齐可能是渲染没起来，agent 可以先归位/重载再试再判断是否真缺页。',
});

export function parseArgs(argv, now = new Date()) {
  const args = { date: null, dateInput: null, summary: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--date') args.dateInput = argv[++i];
    else if (key === '--summary') args.summary = argv[++i];
    else if (key === '--json') args.json = true;
    else return { error: `未知参数 ${key}（可用：--date --summary --json）` };
  }
  if (!args.dateInput && !args.summary) return { error: '必须给 --date 或 --summary' };
  // 解析成 ISO 之后才去拼路径（`evidence/multi-shop-<日>/` 用的是 ISO）。判据托给
  // `resolveTargetDate`（闭集 + 纯函数 + 冻结 now），在这里**不重写**一份日期规则。
  // 原始取值留在 `dateInput`：日志里要能看出它被解析成了哪天，也只有它能证明
  // 「调度器给的 literally 是 yesterday」。
  if (args.dateInput) {
    try {
      args.date = resolveTargetDate(args.dateInput, now);
    } catch (error) {
      return { error: error.message };
    }
  }
  // ⚠️ 不给 `--summary` 时**不能只认 `multi-shop-<日>/summary.json`**：
  //   生产用的 `--batches 5` 把结论落成 `evidence/batches-<日>/b<n>/summary.json`，
  //   那条路径**根本不存在** ⇒ 只认它会每次都判「读不到结论」，
  //   于是「脚本解决不了就转 agent」在真跑里永远不触发（能力像没建）。
  //   两种形态都要认：交给 `resolveSummarySources` 在 main 里做（要读盘，不在纯函数里做）。
  return args;
}

/**
 * 把一个目标日的**结论文件**找出来（可读摘要）。
 *
 * 两种形态（都在 `evidence/` 下，按同一目标日）：
 *   · 不分批：`multi-shop-<日>/summary.json`（唯一一份）；
 *   · 分批（生产形态）：`batches-<日>/b1/summary.json`、`b2/...`（**每一批一份**）。
 *
 * 返回 `{ files: [...] }`（相对仓库根的路径，按批号排）或 `{ error }`。
 * **只读**：不写任何东西。
 */
export function resolveSummarySources(date, { root = REPO_ROOT } = {}) {
  const files = [];
  const single = path.join(root, 'evidence', `multi-shop-${date}`, 'summary.json');
  if (existsSync(single)) files.push(single);
  const batchesRoot = path.join(root, 'evidence', `batches-${date}`);
  if (existsSync(batchesRoot)) {
    let entries = [];
    try { entries = readdirSync(batchesRoot, { withFileTypes: true }); } catch { entries = []; }
    const dirs = entries
      .filter((e) => e.isDirectory() && /^b(\d+)$/u.test(e.name))
      .map((e) => ({ name: e.name, n: Number(e.name.slice(1)) }))
      .sort((a, b) => a.n - b.n);
    for (const d of dirs) {
      const p = path.join(batchesRoot, d.name, 'summary.json');
      if (existsSync(p)) files.push(p);
    }
  }
  if (!files.length) {
    return { error: `目标日 ${date} 没有可读的结论文件（找过 evidence/multi-shop-${date}/summary.json 与 evidence/batches-${date}/b*/summary.json）` };
  }
  return { files };
}

/**
 * 多份批次结论 ⇒ 合并成一份「同形状」的 summary（`shops` 取并集）。
 *
 * ⚠️ 同一家店若在多批里都出现（补跑等），**后者覆盖前者**，并在合并时记下出现次数
 * —— 派单只需要「这家现在什么状态」，不需要历史。
 */
export function mergeSummaries(summaries) {
  const list = (Array.isArray(summaries) ? summaries : []).filter((s) => s && typeof s === 'object');
  const shops = {};
  let date = null;
  for (const s of list) {
    if (!date && s.date) date = s.date;
    for (const [shop, record] of Object.entries(s.shops ?? {})) shops[shop] = record;
  }
  return { date, shops };
}

/**
 * 一批失败 → 派单。**纯函数**（离线可断言）。
 *
 * ⚠️ 分批形态的结论文件在 `evidence/batches-<日>/b<n>/summary.json`，不在
 * `multi-shop-<日>/summary.json` —— 所以调用方（会话）必须把**实际的** summary 路径给进来。
 * 本函数只看 `summary.shops` 的形状（两种形态一致），不关心它从哪来。
 */
/**
 * 单家店：**该不该交给 agent** —— 判据的唯一实现在这里（`buildEscalationPlan` 与
 * `run-multi-shop-day.mjs` 的告警闸门都调它，不各写一份）。
 *
 * 为什么抽出来（2026-09-29，⑨b）：链级告警原先由 `run-multi-shop-day.mjs` 直接发飞书，
 * **完全不问**「这一家其实该先交给 agent」。于是「三层降级」的第 ② 层在真跑里被跳过、
 * 第 ③ 层（叫人）被提前执行 —— 脚本建了派单能力，接线没接上。
 * 抽成纯函数后，告警侧能就着**同一份判据**决定「这家人该不该现在被打扰」。
 *
 * 返回 `null`＝不需要 agent（不打扰）；否则返回派单条目（形状与 `plan.targets[]` 一致）。
 *
 * @param {{shop:string, record:object, unfixable?:Set<string>, summaryPath?:string|null}} o
 */
export function classifyShopEscalation({ shop, record, unfixable = new Set(), summaryPath = null } = {}) {
  const cause = record?.repairRequest?.cause ?? null;
  const candidates = record?.repairRequest?.candidates ?? null;
  const gaveUp = record?.autoRepair?.gaveUp ?? null;
  const reasons = [];
  const hasCandidates = Array.isArray(candidates) && candidates.length > 0;
  const emptyMenu = Array.isArray(candidates) && candidates.length === 0;
  const agentPreferred = Boolean(cause && AGENT_PREFERRED_CAUSES.includes(cause));

  if (typeof gaveUp === 'string' && gaveUp.trim()) reasons.push(`脚本自修没救回来（${gaveUp}）`);
  if (emptyMenu) reasons.push('成因没有登记修法（候选菜单为空）');
  else if (unfixable.has(shop)) reasons.push('脚本自己修不动这一家');
  // 「现场还能救、只是还没人去救」这一档：有非空候选，但这一轮没有自动修复记录
  // （`--auto-repair` 未开）⇒ 交给 agent 去试。仅限 AGENT_PREFERRED_CAUSES ——
  // `NEEDS_LOGIN` 这类有候选也不是 agent 的事（它要的是登录，不是页面动作）。
  if (hasCandidates && !gaveUp && !record?.autoRepair && agentPreferred) {
    reasons.push('这一轮没有自动修复记录（--auto-repair 未开或未跑到），现场还没被救过');
  }
  // 空菜单在 AGENT_PREFERRED_CAUSES 之外（如 NEEDS_LOGIN / SHOP_FUNC_NO_PERMISSION）
  // ⇒ 有理由但**不是 agent 的活**：把它标出来让会话别派 agent（交给人）。
  const agentActionable = hasCandidates || (emptyMenu && agentPreferred);
  if (reasons.length && agentPreferred && AGENT_REASON[cause]) reasons.push(AGENT_REASON[cause]);
  if (!reasons.length || !agentActionable) return null;
  const dir = cardPathFor(record, candidateDirFor(record, summaryPath));
  return {
    shop,
    cause,
    stage: record?.failedStage ?? null,
    repairRequestPath: record?.repairRequest?.path ?? null,
    statePath: record?.repairRequest?.statePath ?? null,
    screenshotPath: record?.repairRequest?.screenshotPath ?? null,
    execHint: record?.repairRequest?.execHint ?? null,
    candidates: (record?.repairRequest?.candidates ?? []).map((c) => c.action),
    reasons,
    logDir: dir,
  };
}

export function buildEscalationPlan({ summary = {}, summaryPath = null, cardPath = null } = {}) {
  const shops = summary?.shops ?? {};
  const failed = Object.entries(shops)
    .filter(([, record]) => record?.status !== 'ok' && !isWaitingOperatorAccountStatus(record))
    .map(([shop, record]) => ({ shop, record }));

  const unfixable = new Set(unfixableShopsOf(summary));
  const targets = [];
  for (const { shop, record } of failed) {
    const verdict = /** @type {any} */ (classifyShopEscalation({ shop, record, unfixable, summaryPath }));
    if (!verdict) continue;
    targets.push(verdict);
  }

  return {
    date: summary?.date ?? null,
    summaryPath: summaryPath ? rel(summaryPath) : null,
    failedCount: failed.length,
    needsAgent: targets.length > 0,
    targets,
    // 会话侧照着这一条干（自包含，不要求会话去读别的文件才知道怎么做）。
    handoff: targets.length
      ? '按 docs/ops/REPAIR-AGENT-HANDOFF.md 派一个**后台修复 agent**：读 repairRequestPath 与 statePath → 从 candidates 里挑一个动作 → 先 --dry-run 再真跑 repair-shop-stage.mjs → 回读并重试失败那一步 → 全过程写进 logDir 的 97-repair-agent-report.md。修不动才发飞书叫人。'
      : '这一轮不需要修复 agent。',
  };
}

const rel = (p) => (p ? path.relative(REPO_ROOT, String(p)) : null);

/** 逐店证据目录：`repairRequest.statePath` 的所在目录（拿不到 ⇒ null，不猜）。 */
function candidateDirFor(record, summaryPath) {
  const statePath = record?.repairRequest?.statePath;
  if (statePath) {
    const abs = path.isAbsolute(statePath) ? statePath : path.join(REPO_ROOT, statePath);
    return path.dirname(abs);
  }
  return summaryPath ? path.dirname(summaryPath) : null;
}

function cardPathFor(_record, dir) {
  return dir ? rel(dir) : null;
}

function readSummary(p) {
  const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
  if (!existsSync(abs)) return { error: `结论文件不存在：${path.relative(REPO_ROOT, abs)}` };
  try { return { summary: JSON.parse(readFileSync(abs, 'utf8')), abs }; }
  catch (error) { return { error: `结论文件读不出来：${error.message}` }; }
}

/** 显式 `--summary` ⇒ 只读那一份；只给 `--date` ⇒ 两种形态都找、合并。 */
function resolvePlanInput(args) {
  if (args.summary) {
    const one = readSummary(args.summary);
    if (one.error) return one;
    return { summary: one.summary, summaryPath: one.abs, sourceCount: 1 };
  }
  const found = resolveSummarySources(args.date);
  if (found.error) return found;
  const parts = [];
  for (const f of found.files) {
    const one = readSummary(f);
    if (one.error) continue; // 单份坏掉不拖垮整轮（其余批次仍可判）；全坏 ⇒ 下面自然为空
    parts.push(one);
  }
  if (!parts.length) return { error: `目标日 ${args.date} 的结论文件都读不出来（找到 ${found.files.length} 份）` };
  const merged = mergeSummaries(parts.map((p) => p.summary));
  merged.date = merged.date ?? args.date;
  return {
    summary: merged,
    // 合并过 ⇒ 没有单一 summaryPath；把「读了哪几份」交给下游显示（不是猜的）。
    summaryPath: parts.length === 1 ? parts[0].abs : null,
    sources: parts.map((p) => p.abs),
    sourceCount: parts.length,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(`[派单] ${args.error}`); process.exitCode = 1; return; }
  const read = resolvePlanInput(args);
  if (read.error) { console.error(`[派单] ${read.error} ⇒ 读不到结论就不猜（不派 agent、不告警）`); process.exitCode = 1; return; }

  const plan = buildEscalationPlan({ summary: read.summary, summaryPath: read.summaryPath });
  plan.sourceCount = read.sourceCount;
  if (read.sources) plan.sources = read.sources.map((s) => rel(s));
  if (args.json) { console.log(JSON.stringify(plan, null, 2)); process.exitCode = 0; return; }

  const srcNote = read.sourceCount > 1 ? `（合并了 ${read.sourceCount} 批结论）` : '';
  // 字面量解析成了哪天要写出来：日报定时在**次日**跑，事后复盘「这轮看的是哪一天」靠这句自证，
  // 而不是靠人记得当时命令里写的是 `yesterday` 还是某个具体日期。
  const inputNote = args.dateInput && args.dateInput !== args.date ? `（--date ${args.dateInput}）` : '';
  console.log(`[派单] 目标日 ${plan.date ?? '?'}${inputNote}${srcNote}｜失败 ${plan.failedCount} 家｜需要修复 agent：${plan.needsAgent ? '是' : '否'}`);
  if (!plan.needsAgent) { console.log('[派单] 没有需要 agent 的失败 ⇒ 不唤醒。'); return; }
  for (const t of plan.targets) {
    console.log(`[派单]   ${t.shop}：${t.cause ?? '(成因未知)'}（停在第 ${t.stage ?? '?'} 步）`);
    for (const r of t.reasons) console.log(`[派单]       · ${r}`);
    console.log(`[派单]       候选：${t.candidates.length ? t.candidates.join(' / ') : '(空菜单)'}｜证据目录 ${t.logDir ?? '?'}`);
  }
  console.log(`[派单] ${plan.handoff}`);
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
