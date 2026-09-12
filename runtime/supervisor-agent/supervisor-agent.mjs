// 监督 Agent 主模块：三级诊断 → 白名单处置 → 验证 → 经验沉淀 的控制循环。
// 设计约束：本模块不执行任何业务动作，动作执行器全部依赖注入；
//           默认 dry-run，只有显式传 executors + --apply 才会真正执行。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleTriage, incidentSignature, FAILURE_CLASSES } from './diagnose.mjs';
import { executeActions, Budget, ACTION_WHITELIST } from './actions.mjs';
import { loadExperience, saveExperience, matchExperience, recordOutcome, addExperience } from './experience.mjs';
import { llmTriage } from './llm.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EXPERIENCE_FILE = join(MODULE_DIR, 'experience.json');
export const DEFAULT_POSTMORTEM_DIR = join(MODULE_DIR, 'postmortems');

/**
 * 处理一起故障。deps 可注入（测试用）：
 *   llmTriageImpl, verify(incident, executed) -> {improved:boolean, evidence},
 *   postmortemDir, experienceFile, now
 * 返回：{ decision, source, executed, rejected, experienceWritten, postmortemPath }
 */
export async function handleIncident(incident, {
  llmTriageImpl = llmTriage,
  verify = null,
  experienceFile = DEFAULT_EXPERIENCE_FILE,
  postmortemDir = DEFAULT_POSTMORTEM_DIR,
  budget = new Budget(),
  executors = {},
  apply = false,
} = {}) {
  const entries = loadExperience(experienceFile);

  // ---- L3-① 经验库匹配（防复发的主路径：同类故障毫秒级出处置）----
  let source = 'experience';
  let decision = null;
  let matchedEntry = null;
  for (const failureClass of [null, ...Object.values(FAILURE_CLASSES)]) {
    // 先按"任何类别"试匹配（错误文本优先），再按类别兜底
    const entry = matchExperience(entries, incident, failureClass ?? undefined)
      ?? (failureClass ? matchExperience(entries, incident, failureClass) : null);
    if (entry) {
      matchedEntry = entry;
      decision = {
        failureClass: entry.signature.failureClass,
        rootCause: entry.rootCause,
        remedy: entry.remedy,
        actions: entry.actions,
        confidence: entry.confidence,
      };
      break;
    }
  }

  // ---- L3-② 确定性规则诊断 ----
  if (!decision) {
    source = 'rules';
    decision = ruleTriage(incident);
  }

  // ---- L3-③ LLM 诊断（最后手段；UNKNOWN 或低置信度才请）----
  if (decision.failureClass === FAILURE_CLASSES.UNKNOWN && source === 'rules') {
    const related = entries
      .filter((e) => !e.retired)
      .slice(-5)
      .map((e) => ({ signature: e.signature, rootCause: e.rootCause }));
    const llmDecision = await llmTriageImpl(incident, { relatedExperience: related });
    if (llmDecision) {
      source = 'llm';
      decision = llmDecision;
    }
  }

  // ---- L4 处置（白名单 + 预算；escalate_human 之后不再执行）----
  let executed = [];
  let rejected = [];
  if (apply && Object.keys(executors).length) {
    const result = await executeActions(decision.actions, executors, budget);
    executed = result.executed;
    rejected = result.rejected;
  } else {
    rejected = decision.actions.map((a) => `${a.type} (dry-run)`);
  }

  // ---- verify + record（公理 6：没有验证的修复不算修复）----
  let verification = { skipped: true };
  let experienceWritten = null;
  let postmortemPath = null;

  if (apply && typeof verify === 'function' && Object.keys(executors).length) {
    verification = await verify(incident, executed);
    const improved = Boolean(verification?.improved);

    if (matchedEntry) {
      // 已有经验：回写应用结果
      recordOutcome(entries, matchedEntry.id, { verified: improved, note: verification?.note ?? '' });
    } else if (improved) {
      // 新经验只有验证通过才准入
      const added = addExperience(entries, {
        signature: incidentSignature(incident, decision.failureClass),
        symptom: String(incident?.error ?? '').slice(0, 200),
        rootCause: decision.rootCause,
        remedy: decision.remedy,
        actions: decision.actions,
        evidence: verification?.evidence ?? null,
        envFingerprint: incident?.envFingerprint ?? null,
        confidence: Math.min(0.9, (decision.confidence ?? 0.5)),
      });
      experienceWritten = added.id;
    }
    saveExperience(experienceFile, entries);

    // 复盘报告（无论成败都写，失败案例同样有沉淀价值）
    postmortemPath = writePostmortem(postmortemDir, incident, decision, source, executed, verification);
  }

  return {
    decision,
    source,
    executed,
    rejected,
    matchedExperienceId: matchedEntry?.id ?? null,
    experienceWritten,
    postmortemPath,
    verification,
    dryRun: !apply,
  };
}

function writePostmortem(postmortemDir, incident, decision, source, executed, verification) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const path = join(postmortemDir, `postmortem-${stamp}.md`);
  const lines = [
    `# Postmortem ${stamp}`,
    '',
    `## 故障`,
    `- flow: ${incident?.flow ?? 'unknown'}`,
    `- stage: ${incident?.stage ?? 'unknown'}`,
    `- status: ${incident?.status ?? 'unknown'}`,
    `- error: ${String(incident?.error ?? '').slice(0, 300)}`,
    '',
    `## 诊断（来源：${source}）`,
    `- failureClass: ${decision.failureClass}`,
    `- rootCause: ${decision.rootCause}`,
    `- remedy: ${decision.remedy}`,
    '',
    `## 处置`,
    ...(executed.length
      ? executed.map((a) => `- ${a.type}: ${JSON.stringify(a.params)}`)
      : ['- （未执行 / dry-run / 预算或白名单拒绝）']),
    '',
    `## 验证`,
    `- improved: ${Boolean(verification?.improved)}`,
    `- note: ${verification?.note ?? ''}`,
    `- evidence: ${JSON.stringify(verification?.evidence ?? null)?.slice(0, 300)}`,
    '',
    `## 防复发`,
    verification?.improved
      ? '- 经验已入库，同类故障下次经签名直接命中，不再进入诊断'
      : '- 未通过验证：不写入经验；建议人工复核根因后补录',
    '',
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const fileArg = argv.find((a) => a.startsWith('--incident='));
  if (!fileArg) {
    console.error('Usage: node supervisor-agent.mjs --incident=<file.json> [--apply]');
    process.exitCode = 2;
    return;
  }
  const incident = JSON.parse(readFileSync(fileArg.slice('--incident='.length), 'utf8'));
  const report = await handleIncident(incident, { apply });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, '/')}`).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
