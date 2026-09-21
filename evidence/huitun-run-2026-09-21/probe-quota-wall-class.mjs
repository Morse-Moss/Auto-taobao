// 只读探针（副本归档）：配额墙这条失败在三个分类器里各落到哪一类，以及各自推出什么动作。
// 目的：把「小口子」从叙述变成可复核的实测数字。
// 用法：在仓库根跑 `node evidence/huitun-run-2026-09-21/probe-quota-wall-class.mjs`
// 原始位置是 tmp/（该目录不进版本库，见 .gitignore 第 115 行）；要留档的证据一律复制到 evidence/<轮次>/。
import { classifyExternalFailure, actionForFailure } from '../../runtime/sop-runtime/policy.mjs';
import { translateFlowError } from '../../skills/huitun-to-feishu-keyword-heat/scripts/adapter.huitun-keyword-heat.mjs';

// flow.mjs:190 真实抛出的那句话（原文照抄，只换掉被 slice 的内容）
const QUOTA_TEXT = '该版本每天最多可以访问10次，请升级到高版本使用';
const thrown = new Error(`Huitun refused to serve this query instead of returning an empty result: ${QUOTA_TEXT}`);

// worker-adapter.mjs 的 failureClassOf 未导出，这里逐字复刻它的判定顺序。
function failureClassOf(error) {
  if (error?.failureClass) return error.failureClass;
  if (error?.code === 'VALIDATION_NOT_IMPLEMENTED' || error?.code === 'ADAPTER_CONTRACT_VIOLATION') return 'CAPABILITY_DEGRADED';
  const message = String(error?.message ?? error);
  if (/login|captcha|风控|risk/i.test(message)) return 'HUMAN_REQUIRED';
  if (/timeout|network|ECONN|ETIMEDOUT|5\d\d/i.test(message)) return 'TRANSIENT_EXTERNAL';
  if (/busy|lease|lock/i.test(message)) return 'RESOURCE_BUSY';
  if (/selector|dom|page structure|capability/i.test(message)) return 'CAPABILITY_DEGRADED';
  return 'BUG';
}

const translated = translateFlowError(thrown);
const lines = [];
lines.push(`原始 error.code        = ${JSON.stringify(thrown.code)}`);
lines.push(`原始 error.failureClass= ${JSON.stringify(thrown.failureClass)}`);
lines.push(`translateFlowError 是否包装 = ${translated instanceof Error && translated.name === 'HuitunEvidenceError' ? '是' : '否（原样抛出）'}`);
lines.push(`translateFlowError 后 .code = ${JSON.stringify(translated.code)}`);
lines.push('');
for (const [label, cls] of [
  ['failureClassOf (worker-adapter)', failureClassOf(thrown)],
  ['classifyExternalFailure (policy)', classifyExternalFailure(thrown)],
]) {
  const act = actionForFailure(cls);
  lines.push(`${label}  => ${cls}  => action=${act.action}  reason="${act.reason}"`);
}
lines.push('');
lines.push('对照 A：只挂 code=HUMAN_REQUIRED（CLI 那条轴的做法）');
const codeOnly = Object.assign(new Error(thrown.message), { code: 'HUMAN_REQUIRED' });
lines.push(`  failureClassOf => ${failureClassOf(codeOnly)}  => action=${actionForFailure(failureClassOf(codeOnly)).action}（运行时那条轴不受影响：failureClassOf 读的是 .failureClass，不是 .code）`);
lines.push('');
lines.push('对照 B：只挂 failureClass=HUMAN_REQUIRED（走 HuitunEvidenceError + FAILURE_CLASS_BY_CODE 的做法）');
const classOnly = Object.assign(new Error(thrown.message), { failureClass: 'HUMAN_REQUIRED', code: 'USAGE_LIMIT_REACHED' });
lines.push(`  failureClassOf => ${failureClassOf(classOnly)}  => action=${actionForFailure(failureClassOf(classOnly)).action}（CLI 那条轴不受影响：803/883 行读的是 .code）`);
lines.push('');
lines.push('CLI 侧可见差异（run-huitun-topic-heat.mjs）');
lines.push(`  退出码: HUMAN_REQUIRED=2 / 其他=1  => 现在=${translated.code === 'HUMAN_REQUIRED' ? 2 : 1}，挂上 code=HUMAN_REQUIRED 后=2`);
lines.push(`  preserveBrowser: 现在=${['HUMAN_REQUIRED', 'STALLED'].includes(translated.code)}，挂上 code=HUMAN_REQUIRED 后=true`);

process.stdout.write(lines.join('\n') + '\n');
