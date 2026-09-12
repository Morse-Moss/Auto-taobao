// 能力注册表：预注册动作 + 固定参数 schema + 适用故障 + 预算/冷却。
// Agent 只能请求这里注册的 action；未注册即整体拒绝（设计文档 3.5 / 5.2）。
// 参数一律是预注册档位（profile/枚举），不存在任意路径、任意命令、任意 selector。

export const CAPABILITY_REGISTRY = {
  ESCALATE_HUMAN: {
    riskClass: 'HUMAN_REQUIRED',
    description: '升级人工：把决定权交还运营',
    appliesTo: null, // 任何故障类别都可升级
    maxPerRun: 2,
    cooldownSeconds: 0,
    paramsSchema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', maxLength: 300 },
      },
      additionalProperties: false,
    },
  },
  RETRY_EXPORT_PROFILE_V2: {
    riskClass: 'LOW',
    description: '按预注册参数档位重试导出（修正导出下载等待与卡停阈值）',
    appliesTo: ['STALL_PAGE_REQUEST', 'EXPORT_DOWNLOAD_TIMEOUT'],
    maxPerRun: 1,
    cooldownSeconds: 120,
    paramsSchema: {
      type: 'object',
      required: ['profile'],
      properties: {
        profile: { type: 'string', enum: ['download-120-stall-900', 'download-120-stall-300'] },
      },
      additionalProperties: false,
    },
  },
  OPEN_HUMAN_LOGIN_GATE: {
    riskClass: 'HUMAN_REQUIRED',
    description: '打开预注册的人工登录闸门窗口（不代做任何凭据）',
    appliesTo: ['LOGIN_REQUIRED'],
    maxPerRun: 1,
    cooldownSeconds: 0,
    paramsSchema: {
      type: 'object',
      required: ['gate'],
      properties: {
        gate: { type: 'string', enum: ['xws_login', 'taobao_login'] },
      },
      additionalProperties: false,
    },
  },
  RESUME_FROM_VERIFIED_CURSOR: {
    riskClass: 'LOW',
    description: '从最后已验证游标继续（Controller 读取权威状态执行）',
    appliesTo: ['STALL_PAGE_REQUEST', 'TRANSIENT_EXTERNAL'],
    maxPerRun: 2,
    cooldownSeconds: 300,
    paramsSchema: {
      type: 'object',
      required: [],
      properties: {},
      additionalProperties: false,
    },
  },
  RECONCILE_UNKNOWN_COMMIT: {
    riskClass: 'MEDIUM',
    description: '对状态为 UNKNOWN 的提交做对账（只读对账，不盲写）',
    appliesTo: ['COMMIT_UNKNOWN'],
    maxPerRun: 1,
    cooldownSeconds: 0,
    paramsSchema: {
      type: 'object',
      required: ['commitRecordId'],
      properties: {
        commitRecordId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
      },
      additionalProperties: false,
    },
  },
};

export function isRegisteredAction(action) {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_REGISTRY, action);
}

/** 按注册表 schema 校验参数：未知字段/任意值一律拒绝。 */
export function validateParamsFor(action, parameters) {
  const spec = CAPABILITY_REGISTRY[action];
  if (!spec) return { ok: false, reasons: [`未注册 action: ${String(action)}`] };
  const schema = spec.paramsSchema;
  const reasons = [];
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return { ok: false, reasons: ['parameters 必须是对象'] };
  }
  for (const key of Object.keys(parameters)) {
    if (!Object.keys(schema.properties ?? {}).includes(key)) reasons.push(`未知参数字段: ${key}`);
  }
  for (const key of schema.required ?? []) {
    if (!(key in parameters)) reasons.push(`缺少必需参数: ${key}`);
  }
  for (const [key, rule] of Object.entries(schema.properties ?? {})) {
    const value = parameters[key];
    if (value === undefined) continue;
    if (rule.type === 'string') {
      if (typeof value !== 'string') reasons.push(`参数 ${key} 必须是字符串`);
      else if (rule.maxLength && value.length > rule.maxLength) reasons.push(`参数 ${key} 超长`);
      else if (rule.enum && !rule.enum.includes(value)) reasons.push(`参数 ${key} 不在枚举内`);
      else if (rule.pattern && !new RegExp(rule.pattern).test(value)) reasons.push(`参数 ${key} 格式非法`);
    } else if (rule.type === 'number' && typeof value !== 'number') {
      reasons.push(`参数 ${key} 必须是数字`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
