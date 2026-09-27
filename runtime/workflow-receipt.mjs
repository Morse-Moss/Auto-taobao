import fs from 'node:fs';
import path from 'node:path';

export const WORKFLOW_STATUSES = Object.freeze(['RUNNING', 'COMPLETED', 'RECOVERED', 'PAUSED_FOR_HUMAN', 'FAILED']);
export const FAILURE_CLASSES = Object.freeze(['TRANSIENT_EXTERNAL', 'HUMAN_REQUIRED', 'POLICY_DENIED', 'UNKNOWN_WRITE', 'FAILED']);

export function classifyWorkflowError(error = {}) {
  const message = String(error.message ?? error);
  if (error.code === 'WORKFLOW_LOCK_BUSY') return { class: 'HUMAN_REQUIRED', reason: 'WORKFLOW_LOCK_BUSY', message };
  if (/captcha|验证码|风控|login|登录|permission|权限|forbidden|无权限|页面改版|AI.*(未|没).*(结算|完成)/iu.test(message)) return { class: 'HUMAN_REQUIRED', reason: 'PLATFORM_OR_HUMAN_GATE', message };
  if (/unknown|未知.*(写|结果)|write.*(unknown|timeout)|写入.*(超时|未知)/iu.test(message)) return { class: 'UNKNOWN_WRITE', reason: 'WRITE_OUTCOME_UNKNOWN', message };
  if (/unknown.*write|写入.*未知|timeout|超时|5\d\d|network|网络|下载/iu.test(message)) return { class: 'TRANSIENT_EXTERNAL', reason: 'EXTERNAL_RETRYABLE', message };
  return { class: 'FAILED', reason: 'UNCLASSIFIED', message };
}

export function createWorkflowReceipt({ workflow, runId, date, stages = [], status = 'RUNNING', startedAt = new Date().toISOString(), ...rest }) {
  if (!WORKFLOW_STATUSES.includes(status)) throw new Error(`unknown workflow status: ${status}`);
  return { version: 1, workflow, runId, date, status, startedAt, stages, ...rest };
}

export function writeWorkflowReceipt(file, receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return file;
}
