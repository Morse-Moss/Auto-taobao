// 监督 Agent L4 处置层：白名单动作 + 预算控制。
// 公理 4：自主权被白名单、预算、幂等三重约束；白名单外 fail-closed。

export const ACTION_WHITELIST = new Set([
  'restart_flow_with_params', // 以新参数重启规则流程（最小侵入的主修复手段）
  'retry_export_with_params', // 仅重试导出阶段
  'reopen_login_window',      // 打开浏览器窗口供人工登录（不代做凭据）
  'escalate_human',           // 升级人工（唯一无边界出口：把决定权交还人）
  'mark_experience_failed',   // 标记某条经验应用失败（供记忆层降权）
]);

export class Budget {
  constructor({ maxActionsPerIncident = 3, maxRestartsPerHour = 6 } = {}) {
    this.maxActionsPerIncident = maxActionsPerIncident;
    this.maxRestartsPerHour = maxRestartsPerHour;
    this.used = 0;
    this.restarts = [];
  }

  /** 预算校验：动作是否允许执行。escalate_human 永远允许（人工是最后兜底）。 */
  allows(action, now = Date.now()) {
    if (!action || typeof action.type !== 'string') return false;
    if (!ACTION_WHITELIST.has(action.type)) return false;
    if (action.type === 'escalate_human') return true;
    if (this.used >= this.maxActionsPerIncident) return false;
    if (action.type === 'restart_flow_with_params') {
      this.restarts = this.restarts.filter((t) => now - t < 3_600_000);
      if (this.restarts.length >= this.maxRestartsPerHour) return false;
    }
    return true;
  }

  /** 记账（动作实际执行后调用）。 */
  consume(action, now = Date.now()) {
    if (action?.type === 'escalate_human') return;
    this.used += 1;
    if (action?.type === 'restart_flow_with_params') this.restarts.push(now);
  }
}

export function isActionSafe(action) {
  if (!action || typeof action !== 'object') return false;
  if (!ACTION_WHITELIST.has(action.type)) return false;
  if (!action.params || typeof action.params !== 'object' || Array.isArray(action.params)) return false;
  // overrides 只允许标量值（防注入任意结构）
  const overrides = action.params.overrides;
  if (overrides !== undefined) {
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) return false;
    if (!Object.values(overrides).every((v) => ['string', 'number', 'boolean'].includes(typeof v))) return false;
  }
  for (const [key, value] of Object.entries(action.params)) {
    if (key === 'overrides') continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return false;
  }
  return true;
}

/**
 * 动作执行器。executors 由调用方注入（CLI 里接真实实现，测试里是桩）——
 * 监督 Agent 的代码路径本身不执行任何业务动作，只做调度与校验。
 */
export async function executeActions(actions, executors, budget, { now = Date.now() } = {}) {
  const executed = [];
  const rejected = [];
  for (const action of actions) {
    if (!isActionSafe(action) || !budget.allows(action, now)) {
      rejected.push(action?.type ?? '<invalid>');
      continue;
    }
    const executor = executors[action.type];
    if (typeof executor !== 'function') {
      rejected.push(action.type);
      continue;
    }
    const result = await executor(action.params ?? {});
    budget.consume(action, now);
    executed.push({ type: action.type, params: action.params, result });
    if (action.type === 'escalate_human') break; // 升级人工后不再有后续动作
  }
  return { executed, rejected };
}
