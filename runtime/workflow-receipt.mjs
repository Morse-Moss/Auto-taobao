import fs from 'node:fs';
import path from 'node:path';

export const WORKFLOW_STATUSES = Object.freeze(['RUNNING', 'COMPLETED', 'RECOVERED', 'PAUSED_FOR_HUMAN', 'FAILED']);
export const FAILURE_CLASSES = Object.freeze(['TRANSIENT_EXTERNAL', 'HUMAN_REQUIRED', 'POLICY_DENIED', 'UNKNOWN_WRITE', 'FAILED']);

export function classifyWorkflowError(error = {}) {
  const message = String(error.message ?? error);
  if (error.code === 'WORKFLOW_LOCK_BUSY') return { class: 'HUMAN_REQUIRED', reason: 'WORKFLOW_LOCK_BUSY', message };
  // 飞书侧的「授权类」拒绝要单独点名（2026-10-17 加）：
  //   91403 = 无权限（应用不是这张 base 的协作者，或跨组织了却用了本组织凭据）
  //   1063004 = 协作者角色不够（链接分享级只读）
  // 这两个码原本文案里常伴 Forbidden，但中文报错（「无权限」）与纯数字回执（「403 91403」）
  // 都可能单独出现；只靠 Forbidden 一个字会漏，漏掉的后果是归成 FAILED/UNCLASSIFIED，
  // 收信人以为该重跑，而真实答案是「去换凭据或加协作者」。
  if (/captcha|验证码|风控|login|登录|permission|权限|forbidden|无权限|页面改版|凭据|credential|AI.*(未|没).*(结算|完成)/iu.test(message)
    // 数字码单独一段并加边界：裸 `403` 会误吃 `19031` 这类端口号，把网络错误也判成「要人」。
    || /(?:^|[^0-9])(?:403|91403|1063004)(?:[^0-9]|$)/u.test(message)) return { class: 'HUMAN_REQUIRED', reason: 'PLATFORM_OR_HUMAN_GATE', message };
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
