// 监督 Agent 验收测试：全部以 2026-09-12 夜间真实故障为夹具。
// 覆盖：三级诊断、经验命中、白名单拒绝、预算熔断、验证回写、防复发。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ruleTriage, incidentSignature, FAILURE_CLASSES } from './diagnose.mjs';
import { Budget, executeActions, isActionSafe, ACTION_WHITELIST } from './actions.mjs';
import { loadExperience, saveExperience, matchExperience, recordOutcome, addExperience, degradeStaleEnvironment } from './experience.mjs';
import { handleIncident } from './supervisor-agent.mjs';
import { llmTriage } from './llm.mjs';

// ---- 2026-09-12 夜间真实故障夹具 ----
const INCIDENT_EXPORT_TIMEOUT = {
  flow: 'xws',
  stage: 'partial_export_on_stall',
  status: 'HUMAN_REQUIRED',
  error: 'Timed out waiting for .csv download',
  runId: 'fc9bc1be-a413-4c7c-b1e7-e31018b023bd',
  params: { stallSeconds: 300, frequencyMin: 30, frequencyMax: 45 },
  events: [
    { event: 'PROGRESS', status: 'COLLECTING', completedPage: 15, rows: 607 },
    { event: 'DIAGNOSTIC', kind: 'REQUEST_PENDING', requestCount: 18 },
    { event: 'EXPORT_STARTED', format: 'csv', reason: 'partial_on_stall' },
    { event: 'WAITING_FOR_DOWNLOAD', extension: '.csv' },
    { event: 'PARTIAL_EXPORT_FAILED', error: 'Timed out waiting for .csv download' },
  ],
};

const INCIDENT_LOGIN = {
  flow: 'xws',
  stage: 'create',
  status: 'HUMAN_REQUIRED',
  error: 'market analysis requires Xiaowangshen login',
  events: [],
};

const INCIDENT_UNKNOWN = {
  flow: 'xws',
  stage: 'collecting',
  status: 'FAILED',
  error: 'widget resequencer reports negative affinity matrix',
  events: [],
};

function tempExperienceFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'sup-agent-'));
  const file = join(dir, 'experience.json');
  if (entries) saveExperience(file, entries);
  return { dir, file };
}

test('规则诊断：部分导出超时 → EXPORT_DOWNLOAD_TIMEOUT + 参数修正处方', () => {
  const triage = ruleTriage(INCIDENT_EXPORT_TIMEOUT);
  assert.equal(triage.failureClass, FAILURE_CLASSES.EXPORT_DOWNLOAD_TIMEOUT);
  assert.match(triage.rootCause, /30 秒/);
  assert.ok(triage.actions.some((a) => a.type === 'restart_flow_with_params'
    && a.params.overrides.exportDownloadTimeoutSeconds >= 120));
});

test('规则诊断：登录失效 → LOGIN_REQUIRED + 升级人工（不代做凭据）', () => {
  const triage = ruleTriage(INCIDENT_LOGIN);
  assert.equal(triage.failureClass, FAILURE_CLASSES.LOGIN_REQUIRED);
  assert.ok(triage.actions.some((a) => a.type === 'reopen_login_window'));
  assert.ok(triage.actions.some((a) => a.type === 'escalate_human'));
});

test('规则诊断：风控页 → PLATFORM_CONTROL，绝不自动绕过', () => {
  const triage = ruleTriage({ ...INCIDENT_LOGIN, error: 'Taobao home encountered a platform control' });
  assert.equal(triage.failureClass, FAILURE_CLASSES.PLATFORM_CONTROL);
  assert.deepEqual(triage.actions.map((a) => a.type), ['escalate_human']);
});

test('白名单：白名单外动作被拒绝（含 LLM 输出的 delete_database）', () => {
  assert.equal(isActionSafe({ type: 'delete_database', params: {} }), false);
  assert.equal(isActionSafe({ type: 'restart_flow_with_params', params: { overrides: { stallSeconds: 900 } } }), true);
  // overrides 里塞非标量（注入尝试）必须拒绝
  assert.equal(isActionSafe({ type: 'restart_flow_with_params', params: { overrides: { evil: { nested: true } } } }), false);
});

test('LLM 诊断：输出含白名单外动作 → 整体拒绝返回 null（fail-closed）', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            failureClass: 'UNKNOWN',
            rootCause: 'r',
            remedy: 'r',
            actions: [{ type: 'restart_flow_with_params', params: { overrides: { stallSeconds: 900 } } }, { type: 'rm -rf', params: {} }],
          }),
        },
      }],
    }),
  });
  const decision = await llmTriage(INCIDENT_UNKNOWN, {}, {
    fetchImpl: fakeFetch,
    endpoint: 'http://llm.example/v1/chat/completions',
    apiKey: 'k',
    model: 'm',
  });
  assert.equal(decision, null);
});

test('LLM 诊断：未配置端点 → null（升级人工路径）', async () => {
  const decision = await llmTriage(INCIDENT_UNKNOWN, {}, { endpoint: '', apiKey: '' });
  assert.equal(decision, null);
});

test('handleIncident dry-run：UNKNOWN 事件经 LLM 出合法处方但只记录不执行', async () => {
  const { file } = tempExperienceFile([]);
  const report = await handleIncident(INCIDENT_UNKNOWN, {
    experienceFile: file,
    apply: false,
    llmTriageImpl: async () => ({
      failureClass: 'STALL_PAGE_REQUEST',
      rootCause: 'limiting',
      remedy: 'slow down',
      actions: [{ type: 'restart_flow_with_params', params: { overrides: { stallSeconds: 900 } } }],
    }),
  });
  assert.equal(report.source, 'llm');
  assert.equal(report.dryRun, true);
  assert.equal(report.executed.length, 0);
  assert.ok(report.rejected.length > 0);
});

test('handleIncident：经验命中优先于规则与 LLM（防复发主路径）', async () => {
  const { file } = tempExperienceFile([]);
  let llmCalled = false;
  const report = await handleIncident(INCIDENT_EXPORT_TIMEOUT, {
    experienceFile: file,
    apply: true,
    executors: {
      restart_flow_with_params: async (params) => ({ restarted: true, overrides: params.overrides }),
    },
    verify: async () => ({ improved: true, note: 'ok', evidence: { status: 'RUNNING' } }),
    llmTriageImpl: async () => {
      llmCalled = true;
      return null;
    },
  });
  // 种子经验（文本模式不完全一致时走规则），此处验证规则路径 + 验证后写入经验
  assert.ok(['experience', 'rules'].includes(report.source));
  assert.equal(llmCalled, false, '有确定性诊断就不该调 LLM');
  assert.equal(report.verification.improved, true);
  assert.ok(report.experienceWritten, '验证通过应写入新经验');
  assert.ok(report.postmortemPath.endsWith('.md'));

  // ---- 同类故障第二次：必须直接命中经验，跳过规则与 LLM ----
  let ruleFallback = false;
  const report2 = await handleIncident({
    ...INCIDENT_EXPORT_TIMEOUT,
    error: 'Timed out waiting for .csv download',
  }, {
    experienceFile: file,
    apply: true,
    executors: {
      restart_flow_with_params: async (params) => ({ restarted: true, overrides: params.overrides }),
    },
    verify: async () => ({ improved: true, note: 'ok', evidence: { status: 'RUNNING' } }),
  });
  assert.equal(report2.source, 'experience', '第二次同类故障必须命中经验');
  assert.equal(report2.matchedExperienceId, report.experienceWritten);
  const entries = loadExperience(file);
  const entry = entries.find((e) => e.id === report.experienceWritten);
  assert.ok(entry.confidence > 0.5, '验证通过后置信度应上调');
  void ruleFallback;
});

test('经验动力学：应用失败降权，置信度归零自动退役', () => {
  const { file } = tempExperienceFile([]);
  let entries = [];
  let id;
  ({ entries, id } = addExperience(entries, {
    signature: incidentSignature(INCIDENT_EXPORT_TIMEOUT, 'EXPORT_DOWNLOAD_TIMEOUT'),
    symptom: 's', rootCause: 'r', remedy: 'r', actions: [], envFingerprint: 'env-a',
  }));
  // 第一次失败
  entries = recordOutcome(entries, id, { verified: false });
  // 第二次失败 → confidence 0.5-0.4-0.4 <0 → retired
  entries = recordOutcome(entries, id, { verified: false });
  const entry = entries.find((e) => e.id === id);
  assert.equal(entry.retired, true);
  assert.equal(matchExperience(entries, INCIDENT_EXPORT_TIMEOUT, 'EXPORT_DOWNLOAD_TIMEOUT'), null, '退役经验不可再命中');
  void file;
});

test('预算熔断：超出单事件动作上限后拒绝执行，仅剩 escalate_human', async () => {
  const budget = new Budget({ maxActionsPerIncident: 2, maxRestartsPerHour: 1 });
  const executors = {
    restart_flow_with_params: async () => ({ ok: true }),
    retry_export_with_params: async () => ({ ok: true }),
    escalate_human: async () => ({ ok: true }),
  };
  const actions = [
    { type: 'restart_flow_with_params', params: { overrides: { stallSeconds: 900 } } },
    { type: 'retry_export_with_params', params: { reason: 'x' } },
    { type: 'restart_flow_with_params', params: { overrides: { stallSeconds: 901 } } }, // 超预算 + 重启限流
    { type: 'escalate_human', params: { reason: 'budget' } }, // 人工出口永远可用
  ];
  const { executed, rejected } = await executeActions(actions, executors, budget);
  assert.deepEqual(executed.map((a) => a.type), ['restart_flow_with_params', 'retry_export_with_params', 'escalate_human']);
  assert.equal(rejected.length, 1);
});

test('环境过期：环境指纹变化后经验降级待复核', () => {
  let entries = [];
  entries = addExperience(entries, {
    signature: incidentSignature(INCIDENT_EXPORT_TIMEOUT, 'EXPORT_DOWNLOAD_TIMEOUT'),
    symptom: 's', rootCause: 'r', remedy: 'r', actions: [], envFingerprint: 'edge-150',
  }).entries;
  entries = degradeStaleEnvironment(entries, 'edge-151');
  assert.equal(entries[0].needsReview, true);
  assert.ok(entries[0].confidence <= 0.3);
});
