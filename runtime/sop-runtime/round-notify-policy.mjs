// 「出故障才提醒」的判据表：一轮结束后到底要不要打扰人。
// 设计依据见 docs/ops/UNATTENDED-AGENT-RUNTIME-PLAN.md §4。
//
// 为什么单独一层：这条判据决定「运营会不会被通知淹没」，而它本身是**纯逻辑**——不含任何网络、
// 文件或数据库访问，因此两个方向（该响要响 / 该静默要静默）都能被离线用例覆盖。判据一旦与投递、
// 编排混在一起，「静默」就再也测不了，只能靠线上观察有没有漏报。
//
// 三条硬规则：
// 1. **静默是显式声明，不是默认值。** 每个理由都必须在这张表里写下结论；表里找不到的理由一律
//    按「通知」处理（fail-closed）。反过来做（没列出来就静默）会让「新增一个失败分类」悄悄变成
//    「这个故障不再通知」——那是所有通知系统里最致命的默认值。
// 2. **去重与恢复必须成对。** 同一个原因不重复轰炸；但恢复时要补一条「已恢复」，否则运营会一直
//    以为还是坏的。
// 3. **「能不能证明恢复」要逐条声明**（provesRecovery），不能从「这条理由响不响亮」推断。
//    例：队列确认为空并不证明登录态修好了（探测只读队列、不碰浏览器），所以 EMPTY_QUEUE 不能
//    用来收掉一条 LOGIN_REQUIRED 的告警。
import { FAILURE_CLASS } from './context-schema.mjs';

export const ROUND_NOTIFY_CONTRACT_VERSION = 'round-notify-policy-v1';

// 「这一条要谁去办」——与 plan（要不要打扰）**正交**的第二个轴。
//
// 为什么必须逐条表态、而不是在统计脚本里另挑一份理由清单：
//   「需要人多久来一次」这个数字要拿来决定一件真事——「要不要给浏览器做自动登录（A2）」
//   （见 docs/ops/LOGIN-RECOVERY-OPTIONS.md §3/§5）。口径若靠人事后挑理由，数字就会随挑选者变化，
//   而两方拿不同口径去论证同一个决策，是最贵的返工形态。所以按本表的既有规矩办：
//   **每个理由的意见都写在这张表里**，统计层只做派生。
//
// 取值：
//   ONSITE    人要**到那台机器上动手**：登录、过验证码、启动出网代理、重开页面、人工门确认。
//             A2（自动登录）影响的正是这一类 —— 频率统计要盯的分母就是它。
//   UPSTREAM  人（或上游系统）去把**业务数据**结掉，这不是故障（队列里有等结算的行）。
//   CONFIG    人改配置或补授权。
//   RECONCILE 人去看外部数据现状并做判断（写入结果未知那一类）。
//   VENDOR    交给服务方（能力过期、疑似缺陷、类别未能识别）。
//   null      该条**本身不指定经手人**：要么是静默结论，要么是「升级」这个动作本身
//             （BUDGET_EXHAUSTED / ESCALATED_HUMAN —— 人具体做什么取决于被升级的那个原因）。
//             null 只允许出现在 plan==='SILENT' 或上面这两个「动作型」理由上，由用例守住。
export const NEEDS_KINDS = Object.freeze(['ONSITE', 'UPSTREAM', 'CONFIG', 'RECONCILE', 'VENDOR']);

// null 是有含义的取值（未细分），不是缺省——所以不计入 NEEDS_KINDS。
export const NEEDS_UNSPECIFIED = null;

// 一张表说清「什么情况打扰人」。kind 只用于说明这条理由从哪来（便于核对完整性），不参与判定。
//   round         —— 编排层自己的结论（是否到期、队列状态、自愈结果…）
//   failure_class —— sop-runtime 的失败分类（context-schema.FAILURE_CLASS）
//   diagnose      —— supervisor-agent 诊断层的分类（自愈不可用时会成为升级理由）
//   escalation    —— 升级人工的理由（预算耗尽等）
export const ROUND_NOTIFY_RULES = Object.freeze([
  // ── 编排层结论：默认安静 ────────────────────────────────────────────────
  {
    key: 'NOT_DUE',
    kind: 'round',
    plan: 'SILENT',
    provesRecovery: false,
    note: '还没到该跑的时间（定时指纹每 15 分钟醒一次，这不是故障）。',
  },
  {
    key: 'ALREADY_DONE',
    kind: 'round',
    plan: 'SILENT',
    provesRecovery: false,
    note: '同一业务幂等键已完成，或今天已按失败收尾（不再重复消耗一次采集）。',
  },
  {
    key: 'EMPTY_QUEUE',
    kind: 'round',
    plan: 'SILENT',
    provesRecovery: false,
    note: '队列确认为空＝正常运营状态，不是失败；也**不**证明任何故障已恢复。',
  },
  {
    key: 'SUCCESS',
    kind: 'round',
    plan: 'SILENT',
    provesRecovery: true,
    note: '全部成功默认不打扰（需要「每周一条汇总」时另开开关）。成功是真正能证明恢复的结论。',
  },
  {
    key: 'AUTO_HEALED',
    kind: 'round',
    plan: 'SILENT',
    provesRecovery: true,
    note: '自愈在预算内成功：记入「今日自动修复」，不打扰人。',
  },

  // ── 需要人动手的编排层结论 ──────────────────────────────────────────────
  {
    key: 'WAITING_HUMAN',
    kind: 'round',
    plan: 'NOTIFY',
    needs: 'UPSTREAM',
    severity: 'HIGH',
    title: '队列里有等人工处理的行',
    nextAction: '去上游把这批行结掉（结算/确认）后，系统会在下一个 15 分钟节点自动继续。',
  },
  {
    key: 'HEALTH_BLOCKED',
    kind: 'round',
    plan: 'NOTIFY',
    needs: 'ONSITE',
    severity: 'HIGH',
    title: '本轮体检未通过，已跳过执行',
    nextAction: '按下面的具体原因处理后，系统会在下一个 15 分钟节点自动重试；本轮不会浪费一次采集。',
  },
  // 以下两条来自体检层（runtime/xws-platform-health-preflight.mjs）。为什么不让 HEALTH_BLOCKED
  // 兜着：这两件事的**下一步动作完全不同**（去启动代理软件 vs 去重开页面），而「通知必须带
  // 下一步做什么」，标题写错等于让运营做错事。理由的完整性由体检层自己的用例反向守住。
  {
    key: 'EGRESS_PROXY_UNREACHABLE',
    kind: 'round',
    plan: 'NOTIFY',
    needs: 'ONSITE',
    severity: 'HIGH',
    title: '出网代理连不上，浏览器打不开任何页面',
    nextAction: '在那台机器上启动出网代理软件（或改用直连并重启自动化浏览器）。'
      + '注意这类故障的报错指向站点（ERR_PROXY_CONNECTION_FAILED）而不指向代理，容易被误判成平台挂了。',
    retryAutomatically: true,
  },
  {
    key: 'TARGET_PAGE_MISSING',
    kind: 'round',
    plan: 'NOTIFY',
    needs: 'ONSITE',
    severity: 'HIGH',
    title: '目标页面不在，或多于一个',
    nextAction: '按 SOP 重开目标页面（每个站点必须**恰好一个**标签页），系统会自动继续。',
    retryAutomatically: true,
  },
  {
    key: 'BUDGET_EXHAUSTED',
    kind: 'escalation',
    plan: 'NOTIFY',
    // 未细分：要人，但「人具体做什么」取决于被升级的那个原因（本条只说明次数用尽）。
    // 显式写 null 而不是省略——省略会让这条静默落进「静默理由」那一桶，口径就错了。
    needs: null,
    severity: 'HIGH',
    title: '已尝试多次仍失败',
    nextAction: '看下面最后一次的原因；需要人工介入后再让它继续。',
  },
  {
    key: 'ESCALATED_HUMAN',
    kind: 'escalation',
    plan: 'NOTIFY',
    // 同上：这是「升级」这个动作本身，不含具体施为对象。
    needs: null,
    severity: 'HIGH',
    title: '需要人工处理',
    nextAction: '按下面的原因处理；处理完系统会在下一个 15 分钟节点自动继续。',
  },
  {
    key: 'ROUND_ERROR',
    kind: 'escalation',
    plan: 'NOTIFY',
    needs: 'VENDOR',
    severity: 'HIGH',
    title: '运行编排自身出错',
    nextAction: '把这条连同诊断包交给服务方；确认前不要重启自动化。',
  },

  // ── sop-runtime 失败分类 ────────────────────────────────────────────────
  {
    key: 'TRANSIENT_EXTERNAL',
    kind: 'failure_class',
    plan: 'SILENT',
    provesRecovery: true,
    retryAutomatically: true,
    note: '临时外部抖动。**只有自愈已经处理掉时**才会以它收尾；没处理掉时编排会升级成 '
      + 'ESCALATED_HUMAN / BUDGET_EXHAUSTED，因此这条静默不会被用来吞掉一次未处理的失败。',
  },
  {
    key: 'RESOURCE_BUSY',
    kind: 'failure_class',
    plan: 'SILENT',
    provesRecovery: true,
    retryAutomatically: true,
    note: '资源忙＝排队后成功，属正常；同上，未处理掉会升级。',
  },
  {
    key: 'HUMAN_REQUIRED',
    kind: 'failure_class',
    plan: 'NOTIFY',
    needs: 'ONSITE',
    severity: 'HIGH',
    title: '平台登录已失效',
    nextAction: '在那台机器上打开浏览器完成登录（系统不会也不应代做凭据），登录后会自动继续。',
    // 「要通知人」与「该不该重试」是两件事：登录失效正是「人修完就该自动继续」的典型，
    // 所以这里 retryAutomatically=true，别因为「已经通知过了」就把重试也一起关掉。
    retryAutomatically: true,
  },
  {
    key: 'CAPABILITY_DEGRADED',
    kind: 'failure_class',
    plan: 'NOTIFY',
    needs: 'VENDOR',
    severity: 'HIGH',
    title: '该能力需要更新',
    nextAction: '联系服务方更新该能力；诊断包已就绪。',
    retryAutomatically: false,
  },
  {
    key: 'EVIDENCE_INVALID',
    kind: 'failure_class',
    plan: 'NOTIFY',
    needs: 'CONFIG',
    severity: 'HIGH',
    title: '采集结果不合合同，已拒绝',
    nextAction: '检查目标与周期参数后重跑。系统不会重试同一份不合合同的证据。',
    retryAutomatically: false,
  },
  {
    key: 'POLICY_DENIED',
    kind: 'failure_class',
    plan: 'NOTIFY',
    needs: 'CONFIG',
    severity: 'HIGH',
    title: '配置或授权不对，已拒绝执行',
    nextAction: '按下面的原因补齐配置/授权（缺什么会写在原因里）。',
    retryAutomatically: false,
  },
  {
    key: 'COMMIT_UNKNOWN',
    kind: 'failure_class',
    plan: 'NOTIFY',
    needs: 'RECONCILE',
    severity: 'HIGH',
    title: '外部写入结果未知，需要人工对账',
    nextAction: '先对账确认外部数据现状，再决定要不要重跑。**系统不会静默重试。**',
    // 这一类**必须**是 false：15 分钟后再写一遍，等于把「结果未知」变成「写两次」。
    retryAutomatically: false,
  },
  {
    key: 'BUG',
    kind: 'failure_class',
    plan: 'NOTIFY',
    needs: 'VENDOR',
    severity: 'HIGH',
    title: '疑似系统自身缺陷，自动化已停止',
    nextAction: '把这条连同诊断包交给服务方；确认前不要重启自动化。',
    retryAutomatically: false,
  },

  // ── 诊断层分类（自愈不可用或自愈失败时，它会直接成为升级理由）──────────
  {
    key: 'LOGIN_REQUIRED',
    kind: 'diagnose',
    plan: 'NOTIFY',
    needs: 'ONSITE',
    severity: 'HIGH',
    title: '插件或平台登录已失效',
    nextAction: '在同一个浏览器配置里重新登录（系统不会代做凭据），登录后自动继续。',
    retryAutomatically: true,
  },
  {
    key: 'PLATFORM_CONTROL',
    kind: 'diagnose',
    plan: 'NOTIFY',
    needs: 'ONSITE',
    severity: 'HIGH',
    title: '遇到验证码或风控页，需要人工在浏览器完成',
    nextAction: '人工在可见的浏览器窗口里完成验证。**系统不会尝试绕过风控。**',
    retryAutomatically: true,
  },
  {
    key: 'STALL_PAGE_REQUEST',
    kind: 'diagnose',
    plan: 'NOTIFY',
    needs: 'ONSITE',
    severity: 'HIGH',
    title: '页面长时间无响应',
    nextAction: '若自愈不可用或已用尽预算，需要人工确认网络/限流情况后重跑。',
    retryAutomatically: true,
  },
  {
    key: 'EXPORT_DOWNLOAD_TIMEOUT',
    kind: 'diagnose',
    plan: 'NOTIFY',
    needs: 'ONSITE',
    severity: 'HIGH',
    title: '导出文件等待超时',
    nextAction: '若自愈不可用或已用尽预算，需要人工确认插件导出通道后重跑。',
    retryAutomatically: true,
  },
  {
    key: 'BROWSER_DEBUG_PORT',
    kind: 'diagnose',
    plan: 'NOTIFY',
    needs: 'ONSITE',
    severity: 'HIGH',
    title: '浏览器调试端口不可用',
    nextAction: '确认浏览器已按调试模式启动（被关掉或被占端口都算）；修好后系统会自动继续。',
    retryAutomatically: true,
  },
  {
    key: 'FLOW_HUMAN_GATE',
    kind: 'diagnose',
    plan: 'NOTIFY',
    needs: 'ONSITE',
    severity: 'HIGH',
    title: '流程按设计停在人工门',
    nextAction: '这是设计内行为（发布授权/内容审核），人工确认后继续。',
    retryAutomatically: true,
  },
  {
    key: 'UNKNOWN',
    kind: 'diagnose',
    plan: 'NOTIFY',
    needs: 'VENDOR',
    severity: 'HIGH',
    title: '故障类别未能识别',
    nextAction: '把这条连同诊断包交给服务方。',
    retryAutomatically: false,
  },
]);

const RULE_BY_KEY = new Map(ROUND_NOTIFY_RULES.map((rule) => [rule.key, rule]));
// 同一张清单的两个方向：不重复列举，避免「加了一条却只改了半边」。
export const NOTIFY_REASON_KEYS = Object.freeze(
  ROUND_NOTIFY_RULES.filter((rule) => rule.plan === 'NOTIFY').map((rule) => rule.key),
);
export const SILENT_REASON_KEYS = Object.freeze(
  ROUND_NOTIFY_RULES.filter((rule) => rule.plan === 'SILENT').map((rule) => rule.key),
);
export const RECOVERY_PROVING_REASONS = Object.freeze(
  ROUND_NOTIFY_RULES.filter((rule) => rule.provesRecovery === true).map((rule) => rule.key),
);
// 「15 分钟后再跑一遍有没有新结果」：与「要不要通知」是两个轴，同一张表里逐条表态。
export const RETRY_AUTOMATICALLY_REASONS = Object.freeze(
  ROUND_NOTIFY_RULES.filter((rule) => rule.retryAutomatically === true).map((rule) => rule.key),
);
export const NO_AUTO_RETRY_REASONS = Object.freeze(
  ROUND_NOTIFY_RULES.filter((rule) => rule.retryAutomatically === false).map((rule) => rule.key),
);

// needs 轴的派生与自查。
//
// 只对 plan==='NOTIFY' 逐条要求：静默的理由从不打扰人，「不需要人经手」是**逻辑蕴含**，
// 不是省略；给它们也补一个 `needs: null` 只会让表变长而不增加信息。
export function needsOf(reason) {
  const rule = resolveNotifyRule(reason);
  if (!rule) return { needs: null, known: false, key: text(reason) || null };
  return { needs: rule.needs ?? null, known: true, key: rule.key, title: rule.title ?? null };
}

// 表自身的完整性：返回问题描述清单（空 = 合格）。由用例调用，
// 让「加了新理由却忘了表态」在离线就炸，而不是等统计出来一个偏低的数字。
export function needsAxisErrors() {
  const errors = [];
  for (const rule of ROUND_NOTIFY_RULES) {
    const declared = Object.hasOwn(rule, 'needs');
    if (rule.plan === 'NOTIFY') {
      if (!declared) {
        errors.push(`${rule.key}: plan=NOTIFY 必须声明 needs（要谁去办）`);
      } else if (rule.needs !== null && !NEEDS_KINDS.includes(rule.needs)) {
        errors.push(`${rule.key}: needs="${rule.needs}" 不在 ${NEEDS_KINDS.join(' | ')} 之内`);
      }
    } else if (declared && rule.needs !== null) {
      errors.push(`${rule.key}: plan=${rule.plan} 不该声明一个非空的 needs（静默理由不打扰人）`);
    }
  }
  return errors;
}

export function resolveNotifyRule(reason) {
  const key = String(reason ?? '').trim();
  return key ? RULE_BY_KEY.get(key) ?? null : null;
}

// 完整性核对：给定一批「必须被覆盖」的理由，返回表里没有的。用于仓库守卫与用例——
// 新增一个失败分类却忘了在判据表里表态，会在这里立刻暴露，而不是等线上漏报。
export function missingPolicyKeys(keys = []) {
  return [...new Set(keys.map((key) => String(key ?? '').trim()).filter(Boolean))]
    .filter((key) => !RULE_BY_KEY.has(key));
}

// 编制收据用的理由全集校验表：sop-runtime 的失败分类 + 诊断层分类，两条词表都必须被覆盖。
// 诊断层的分类在这里以**字面量**出现（而不是 import supervisor-agent）——core 侧不允许依赖
// Agent 层（见 agent-proposal.assertAgentRemovable）。这份副本由单测与真实词表对齐。
export const DIAGNOSE_FAILURE_CLASSES = Object.freeze([
  'STALL_PAGE_REQUEST', 'EXPORT_DOWNLOAD_TIMEOUT', 'LOGIN_REQUIRED', 'PLATFORM_CONTROL',
  'BROWSER_DEBUG_PORT', 'FLOW_HUMAN_GATE', 'UNKNOWN',
]);

export function requiredPolicyKeys() {
  return [...FAILURE_CLASS, ...DIAGNOSE_FAILURE_CLASSES,
    'NOT_DUE', 'ALREADY_DONE', 'EMPTY_QUEUE', 'SUCCESS', 'AUTO_HEALED', 'WAITING_HUMAN',
    'HEALTH_BLOCKED', 'BUDGET_EXHAUSTED', 'ESCALATED_HUMAN', 'ROUND_ERROR',
    // 体检层会发出的理由（见文件末尾注释）：漏一条就会 fail-closed 成「未登记的故障理由」。
    'EGRESS_PROXY_UNREACHABLE', 'TARGET_PAGE_MISSING'];
}

function text(value) {
  return String(value ?? '').trim();
}

// 告警编号：给运营与服务方对账用。刻意**不含** 32 位以上连续字母数字（会被凭据遮盖规则吃掉）。
export function roundAlertId({ businessKey, now = Date.now(), prefix = 'round' } = {}) {
  const safeKey = text(businessKey).replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 24) || 'unknown';
  const at = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `T${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${prefix}-${safeKey}-${stamp}`;
}

function sourceOf(source = {}) {
  const out = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    const normalized = text(value);
    if (normalized) out[key] = normalized;
  }
  return out;
}

export function buildRoundAlert({
  reason,
  businessKey = null,
  now = Date.now(),
  source = {},
  evidence = {},
  severity = null,
  title = null,
  nextAction = null,
  detail = null,
}) {
  const rule = resolveNotifyRule(reason);
  return {
    version: ROUND_NOTIFY_CONTRACT_VERSION,
    alertId: roundAlertId({ businessKey, now }),
    type: text(reason) || 'ROUND',
    severity: text(severity || rule?.severity || 'HIGH').toUpperCase(),
    title: text(title || rule?.title) || '系统告警',
    createdAt: new Date(now).toISOString(),
    source: sourceOf(source),
    // 「原因」这一行给的是**具体发生了什么**（体检发现的哪一层、调度器给的那句原话），
    // 没有明细时才退回判据表里那句人话。运营看的是这一行。
    reason: text(detail) || text(rule?.title) || text(reason) || '未登记的失败理由',
    action: text(nextAction || rule?.nextAction) || '把这条连同诊断包交给服务方。',
    ...(Object.keys(evidence ?? {}).length ? { evidence: sourceOf(evidence) } : {}),
    delivery: { status: 'NOT_CONFIGURED' },
  };
}

// 恢复通知：内容由**原来那条**告警决定，不由当前这条静默理由决定。
// （当前理由是「成功了」，而运营需要知道的是「之前那个毛病没了」。）
export function buildResolvedAlert({ openAlert, now = Date.now(), source = {} } = {}) {
  const previousTitle = text(openAlert?.title) || '之前的异常';
  return {
    version: ROUND_NOTIFY_CONTRACT_VERSION,
    alertId: roundAlertId({ businessKey: openAlert?.businessKey ?? null, now, prefix: 'resolved' }),
    type: 'ROUND_RESOLVED',
    severity: 'INFO',
    title: `已恢复：${previousTitle}`,
    createdAt: new Date(now).toISOString(),
    source: sourceOf(source ?? openAlert?.source ?? {}),
    reason: `之前那条「${previousTitle}」的状态已经恢复。`,
    action: '无需处理。',
    ...(openAlert?.alertId ? { evidence: { 原告警编号: text(openAlert.alertId) } } : {}),
    delivery: { status: 'NOT_CONFIGURED' },
  };
}

// 判定入口（纯函数）。openAlert 是当前「还没收掉」的那条告警（无则 null）。
// 返回 action：
//   SEND     —— 要发（含把旧的收掉、换成新理由）
//   DEDUPED  —— 同一个原因还在响，不重复打扰
//   RESOLVE  —— 当前这轮证明故障已恢复，补发一条「已恢复」
//   NONE     —— 安静
export function decideNotification({ reason, openAlert = null } = {}) {
  const key = text(reason);
  const rule = resolveNotifyRule(key);
  const unmapped = rule === null;
  const previousKey = text(openAlert?.reason) || null;

  if (unmapped) {
    // fail-closed：没登记过的理由一律按「要通知」处理，并在收据里标 unmapped 让它可见。
    return {
      action: 'SEND',
      key,
      unmapped: true,
      plan: 'NOTIFY',
      severity: 'HIGH',
      title: `未登记的故障理由：${key || '(空)'}`,
      nextAction: '这是一个没有在通知判据表里表态的理由，按 fail-closed 处理为「需要人工」。请补进判据表。',
      previousKey,
    };
  }

  if (rule.plan === 'NOTIFY') {
    if (previousKey === rule.key) {
      return {
        action: 'DEDUPED',
        key: rule.key,
        unmapped: false,
        plan: 'NOTIFY',
        severity: rule.severity ?? 'HIGH',
        title: rule.title,
        nextAction: rule.nextAction,
        previousKey,
      };
    }
    return {
      action: 'SEND',
      key: rule.key,
      unmapped: false,
      plan: 'NOTIFY',
      severity: rule.severity ?? 'HIGH',
      title: rule.title,
      nextAction: rule.nextAction,
      previousKey,
    };
  }

  // 静默结论：只有「能证明恢复」的那几条才允许把旧告警收掉。
  if (openAlert && rule.provesRecovery === true) {
    return {
      action: 'RESOLVE',
      key: rule.key,
      unmapped: false,
      plan: 'SILENT',
      severity: 'INFO',
      title: rule.title,
      nextAction: rule.nextAction ?? '',
      previousKey,
    };
  }
  return {
    action: 'NONE',
    key: rule.key,
    unmapped: false,
    plan: 'SILENT',
    severity: null,
    title: rule.title ?? null,
    nextAction: rule.nextAction ?? null,
    previousKey,
    // 静默但没有收掉旧告警时要能解释为什么（用例会断言这条）。
    keptOpenBecause: openAlert ? `${rule.key} 不能证明「${previousKey}」已恢复` : null,
  };
}
