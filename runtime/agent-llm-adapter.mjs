// LLM → Agent 契约的那根线（此前不存在）。
//
// 背景事实：
//   - `runtime/local-provider-runner.mjs` 只是**一个硬编码任务的批处理器**
//     （内容热度/对应产品方向，提示词写死在 :90），不是通用模型调用面；
//   - `runtime/sop-runtime/agent-proposal.mjs` 的 `createAgentPort({ runAgent })`
//     要求调用方注入一个 `runAgent`，而全仓库**没有任何地方提供过它**。
// ⇒ 所以「Agent 层没有接 LLM」的准确原因是：两端都建好了，中间缺一个适配层。
//
// 本模块就是那层适配，只做三件事，全部是「读 + 生成文本」性质，不产生任何外部写：
//   1. 通用模型调用面 `callProviderJson`：把 prompt 交给 cc / codex / workbuddy，拿回 JSON；
//   2. `createLlmAgentRunner`：把模型输出整形成 `agent-proposal-v1` 提案；
//   3. `createTriageAgentManifest`：一个合规的 planner manifest（含强制兜底声明）。
//
// 硬约束（与 Agent 契约一致，不在这里放宽）：
//   - 只能声明只读工具；不得声明外部写副作用；
//   - 提案不得夹带状态轴或身份字段（交给 validateProposal 判，这里不做「顺手清除」——
//     清除会把违规藏起来，而契约要的是拦住）；
//   - 模型失败 / 输出非法 / 无证据，一律返回失败，由 createAgentPort 降级为确定性兜底。
import { spawn } from 'node:child_process';

export const AGENT_PROVIDER_KINDS = Object.freeze(['cc', 'codex', 'workbuddy']);

const PROVIDER_COMMANDS = Object.freeze({
  cc: Object.freeze({ command: 'claude', args: ['-p', '--output-format', 'json'] }),
  codex: Object.freeze({ command: 'codex', args: ['exec', '-'] }),
  workbuddy: Object.freeze({ command: 'workbuddy', args: ['run'] }),
});

export const DEFAULT_TIMEOUT_MS = 180_000;

function executable(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function quoteWindowsArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_.-]+$/u.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

// 默认 spawn：带超时与强制回收，避免模型进程挂住把调用方带走。
function defaultSpawnProcess({ command, args, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const resolved = executable(command);
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [resolved, ...args.map(quoteWindowsArg)].join(' ')], { windowsHide: true })
      : spawn(resolved, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 进程可能已退出 */ }
      reject(new Error(`provider timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`provider ${command} exited ${code}: ${String(stderr).trim().slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

// 模型返回里常见的三种包裹：裸 JSON、```json 围栏、以及 cc 的 { result: "..." }。
export function extractJson(text) {
  const raw = String(text ?? '').replace(/[\u200b\ufeff]/gu, '').trim();
  if (!raw) throw new Error('provider returned empty output');
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.result === 'string') {
      const nested = parsed.result.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
      try { return JSON.parse(nested); } catch { /* 继续尝试其它候选 */ }
    }
    return parsed;
  }
  throw new Error('provider output is not parseable JSON');
}

export async function callProviderJson({ provider, prompt, timeoutMs = DEFAULT_TIMEOUT_MS, spawnProcess = defaultSpawnProcess, dependencies = {} } = {}) {
  if (!AGENT_PROVIDER_KINDS.includes(provider)) throw new Error(`Unsupported provider: ${provider}`);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
  const definition = PROVIDER_COMMANDS[provider];
  const run = dependencies.spawnProcess ?? spawnProcess;
  const output = await run({ command: definition.command, args: [...definition.args], input: prompt, timeoutMs });
  return extractJson(output);
}

// ── 把模型输出整形成 agent-proposal-v1 ─────────────────────────────────────
// 证据引用由调用方给定，模型只能按序号 cite。这样「模型不能凭空发明证据」这条
// 就变成了结构约束，而不是靠提示词祈求。
export function buildProposalPrompt({ context, evidenceRefs, input, instruction }) {
  const numbered = evidenceRefs.map((ref, index) => ({
    index: index + 1,
    ref: typeof ref === 'string' ? ref : (ref.evidenceId ?? ref.artifactId ?? ref.digest ?? JSON.stringify(ref)),
  }));
  return [
    'You are a read-only triage planner inside a deterministic SOP runtime.',
    'You cannot execute anything. You can only output findings as a JSON proposal.',
    '',
    'Hard rules:',
    '- Cite evidence only by its list number. Never invent an evidence id.',
    '- Never output keys named: executionStatus, evidenceStatus, humanGateStatus, leaseStatus, publicationStatus, identity, sideEffectRefs, humanGate, riskClass, status, state, axis, phase, nextAction.',
    '- Every claim must cite at least one number from the evidence list.',
    '- If the evidence is not enough to conclude, still produce a claim with lower confidence and cite what you have.',
    '',
    'Return ONLY this JSON object shape (no markdown, no prose):',
    '{"claims":[{"key":"<short_snake_case>","value":"<short string or number>","confidence":<0..1>,"evidence":[<numbers>]}]}',
    '',
    instruction ? `Task:\n${instruction}\n` : '',
    '[CONTEXT]',
    JSON.stringify(context ?? {}, null, 2),
    '',
    '[EVIDENCE]',
    JSON.stringify(numbered, null, 2),
    '',
    '[INPUT]',
    JSON.stringify(input ?? {}, null, 2),
  ].filter(Boolean).join('\n');
}

function normalizeClaims(claims, evidenceRefs, knownKeys) {
  if (!Array.isArray(claims)) return [];
  const out = [];
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object' || !claim.key) continue;
    const indices = Array.isArray(claim.evidence) ? claim.evidence : [];
    // 只保留真实存在于本次 run 的证据；越界序号直接丢弃（不许落到「全量兜底」，
    // 那会让 CLAIM_WITHOUT_EVIDENCE 永远不被触发，等于把闸门拆了）。
    const refs = [];
    for (const index of indices) {
      const position = Number(index);
      if (!Number.isInteger(position) || position < 1 || position > evidenceRefs.length) continue;
      const ref = evidenceRefs[position - 1];
      const key = typeof ref === 'string' ? ref : (ref?.evidenceId ?? ref?.artifactId ?? ref?.digest ?? ref?.sha256);
      if (!key) continue;
      if (knownKeys.size && !knownKeys.has(String(key)) && !knownKeys.has(`sha256:${String(key).replace(/^sha256:/u, '')}`)) continue;
      refs.push(ref);
    }
    // 刻意**不清理**模型给的其它字段：把值原样交给 validateProposal 判。
    // 如果这里顺手剔掉，模型夹带的状态轴 / 身份字段就永远到不了闸门，
    // 而契约要的是「写到就拦住」，不是「写得下但被悄悄擦掉」。
    const { evidence: _evidence, ...rest } = claim;
    out.push({ ...rest, key: String(claim.key), evidenceRefs: refs });
  }
  return out;
}

export function createLlmAgentRunner({ provider, manifest, instruction, timeoutMs, dependencies, spawnProcess } = {}) {
  if (!manifest) throw new Error('manifest is required');
  return async function runAgent({ context, evidenceRefs = [], input = {} } = {}) {
    const prompt = buildProposalPrompt({ context, evidenceRefs, input, instruction });
    const parsed = await callProviderJson({ provider, prompt, timeoutMs, spawnProcess, dependencies });
    const knownKeys = new Set();
    for (const ref of evidenceRefs) {
      if (typeof ref === 'string') { knownKeys.add(ref); continue; }
      if (ref?.evidenceId) knownKeys.add(String(ref.evidenceId));
      if (ref?.artifactId) knownKeys.add(String(ref.artifactId));
      if (ref?.digest) knownKeys.add(String(ref.digest));
      if (ref?.sha256) knownKeys.add(`sha256:${String(ref.sha256).replace(/^sha256:/u, '')}`);
    }
    const claims = normalizeClaims(parsed?.claims, evidenceRefs, knownKeys);
    return {
      schemaVersion: 'agent-proposal-v1',
      runId: context?.runId ?? null,
      agent: { name: manifest.name, version: manifest.version },
      kind: manifest.proposalKinds?.[0] ?? 'CLASSIFY',
      output: { claims },
      note: typeof parsed?.note === 'string' ? parsed.note : null,
      at: new Date().toISOString(),
    };
  };
}

export const TRIAGE_AGENT_NAME = 'sop-triage-planner';
export const TRIAGE_AGENT_VERSION = '0.1.0';
export const TRIAGE_FALLBACK = 'deterministic-triage';

// 合规的 planner manifest。tools 必须来自只读白名单，且必须声明兜底路径。
export function createTriageAgentManifest(overrides = {}) {
  return {
    schemaVersion: 'agent-capability-v1',
    kind: 'agent',
    name: TRIAGE_AGENT_NAME,
    version: TRIAGE_AGENT_VERSION,
    role: 'planner',
    description: 'Read-only triage planner: classifies a failure signature and proposes the next read-only check.',
    tools: ['read_context_summary', 'read_evidence', 'read_policy'],
    sideEffects: ['local_artifact'],
    proposalKinds: ['CLASSIFY', 'RECOMMEND'],
    deterministicFallback: TRIAGE_FALLBACK,
    ...overrides,
  };
}
