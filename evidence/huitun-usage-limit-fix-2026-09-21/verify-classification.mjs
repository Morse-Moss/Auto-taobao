// 端到端复核：拿配额墙的**真实文案**走一遍两条轴，不手工构造 error 对象。
// 为什么要这样复核：修之前我用的是一个手写的 `new Error(...)`（无 code），
// 手写的形状恰好等于「修之前的样子」，所以它只能证明旧行为、证明不了这次修好了。
// 用法：在仓库根跑 `node evidence/huitun-usage-limit-fix-2026-09-21/verify-classification.mjs`
import { classifyTopicSnapshot, USAGE_LIMIT_CODE } from '../../skills/huitun-to-feishu-keyword-heat/scripts/flow.mjs';
import {
  FAILURE_CLASS_BY_CODE,
  translateFlowError,
} from '../../skills/huitun-to-feishu-keyword-heat/scripts/adapter.huitun-keyword-heat.mjs';
import { cliExitCodeFor, preserveBrowserFor } from '../../skills/huitun-to-feishu-keyword-heat/scripts/run-huitun-topic-heat.mjs';
import { actionForFailure } from '../../runtime/sop-runtime/policy.mjs';
import { FAILURE_CLASS } from '../../runtime/sop-runtime/context-schema.mjs';

// 2026-09-21 页面原文（含换行后的「升级版本」引导按钮文案）。
const WALL = '该版本每天最多可以访问10次，请升级到高版本使用\n\n升级版本';
const lines = [];

let thrown = null;
try {
  classifyTopicSnapshot({ keyword: '泡澡浴缸', rows: [], emptyText: WALL });
} catch (error) {
  thrown = error;
}

lines.push('=== 第一段：flow.mjs 抛出来的东西 ===');
lines.push(`抛了吗            ${thrown ? '是（没有把配额墙当成 NO_EXACT_TOPIC / views: 0）' : '没有 —— 修坏了，它又被当成空结果了'}`);
lines.push(`error.code        ${JSON.stringify(thrown?.code)}   期望 ${JSON.stringify(USAGE_LIMIT_CODE)}`);
lines.push(`error.details     ${JSON.stringify(thrown?.details ?? null)}`);
lines.push(`message           ${JSON.stringify(thrown?.message ?? null)}`);

lines.push('');
lines.push('=== 第二段：运行时那条轴（适配器 → 收据上的 failureClass → 动作）===');
const translated = translateFlowError(thrown);
lines.push(`translateFlowError 包装   ${translated?.name === 'HuitunEvidenceError' ? '是' : '否'}`);
lines.push(`code                      ${JSON.stringify(translated?.code)}`);
lines.push(`failureClass              ${JSON.stringify(translated?.failureClass)}`);
lines.push(`FAILURE_CLASS_BY_CODE 里   ${JSON.stringify(FAILURE_CLASS_BY_CODE[USAGE_LIMIT_CODE])}`);
const action = actionForFailure(translated?.failureClass);
lines.push(`actionForFailure          action=${action.action}  reason="${action.reason}"`);
lines.push(`运行时词表里有吗           ${FAILURE_CLASS.includes(translated?.failureClass) ? '有' : '没有 —— 收据的上下文校验会拒掉它'}`);
lines.push('  期望：USAGE_LIMIT_REACHED / FAIL（当天收工、不自动重试）。修之前这一格是 BUG / STOP_AND_ALERT。');

lines.push('');
lines.push('=== 第三段：CLI 那条轴（退出码 / 是否保留浏览器页签）===');
lines.push(`cliExitCodeFor       ${cliExitCodeFor(thrown)}   期望 2（要人处理）`);
lines.push(`preserveBrowserFor   ${preserveBrowserFor(thrown)}   期望 true（把那堵墙留在页面上给人看）`);
lines.push('  修之前这两格分别是 1 与 false（因为 803/883 行读的是 .code，而当时它没有 code）。');

lines.push('');
lines.push('=== 对照：真·空结果不受影响（不能被这道闸连坐）===');
const empty = classifyTopicSnapshot({ keyword: '泡澡浴缸', rows: [], emptyText: '没有找到话题~~点击这里' });
lines.push(`status=${empty.status} views=${empty.views} viewsRaw=${JSON.stringify(empty.viewsRaw)}`);

process.stdout.write(lines.join('\n') + '\n');
