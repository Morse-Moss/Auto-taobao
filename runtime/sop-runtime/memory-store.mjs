// Memory Store：分层记忆（Spec 第 12 节 / 实施计划阶段 5）
// 五层记忆严格分开，权威性和生命周期不同：
//   RUN_CONTEXT  —— 当前运行的上下文（权威在 Context Store，这里只做检索投影）
//   EVIDENCE     —— 当前运行产生的事实证据（权威在 Evidence Store）
//   VERIFIED_FACT—— 已通过验证器、跨运行可复用的稳定事实
//   RULE_DECISION—— 已批准的规则/架构决策
//   EXPERIENCE   —— 经验（可能过时，只作兜底，绝不允许覆盖当前证据）
// 硬规则：当前 run 的证据优先于任何历史事实/规则/经验；过期的记忆不得被检索出来；
//        退役的记忆保留可追溯性（不物理删除），但不再参与决策。
export const MEMORY_LAYERS = Object.freeze([
  'RUN_CONTEXT', 'EVIDENCE', 'VERIFIED_FACT', 'RULE_DECISION', 'EXPERIENCE',
]);

// 优先级：数字越大越权威。当前运行的证据（RUN_CONTEXT/EVIDENCE）恒高于历史层。
export const LAYER_PRECEDENCE = Object.freeze({
  RUN_CONTEXT: 4,
  EVIDENCE: 4,
  VERIFIED_FACT: 3,
  RULE_DECISION: 2,
  EXPERIENCE: 1,
});

// 「当前运行」层：只有这两层能代表当前事实，其余都是历史。
export const CURRENT_RUN_LAYERS = Object.freeze(['RUN_CONTEXT', 'EVIDENCE']);

export const DEFAULT_CONFIDENCE = Object.freeze({
  RUN_CONTEXT: 1, EVIDENCE: 1, VERIFIED_FACT: 0.9, RULE_DECISION: 0.8, EXPERIENCE: 0.5,
});

export class MemoryError extends Error {
  constructor(message, { code = 'MEMORY_ERROR', details = {} } = {}) {
    super(`${code}: ${message}`);
    this.name = 'MemoryError';
    this.code = code;
    this.details = details;
  }
}

export function isExpired(record, atIso) {
  if (!record?.validUntil) return false;
  const until = Date.parse(record.validUntil);
  const at = Date.parse(atIso);
  if (Number.isNaN(until) || Number.isNaN(at)) return false;
  return until <= at;
}

export function isUsable(record, atIso) {
  return Boolean(record) && record.retired !== true && !isExpired(record, atIso);
}

// 记录级校验：缺作用域或来源的记忆一律拒绝入库（否则将来无法判断它属于谁、从哪来）。
export function validateMemory(record) {
  const errors = [];
  if (!record || typeof record !== 'object') return { ok: false, errors: ['record must be an object'] };
  if (!MEMORY_LAYERS.includes(record.layer)) errors.push(`invalid layer: ${record.layer}`);
  if (!record.scope || typeof record.scope !== 'string') errors.push('scope is required');
  if (!record.source || typeof record.source !== 'string') errors.push('source is required');
  if (record.value === undefined) errors.push('value is required');
  const confidence = Number(record.confidence ?? DEFAULT_CONFIDENCE[record.layer] ?? 0.5);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push(`confidence must be within [0,1], got ${record.confidence}`);
  if (record.validFrom && Number.isNaN(Date.parse(record.validFrom))) errors.push('validFrom must be an ISO timestamp');
  if (record.validUntil && Number.isNaN(Date.parse(record.validUntil))) errors.push('validUntil must be an ISO timestamp');
  if (record.validFrom && record.validUntil && Date.parse(record.validUntil) <= Date.parse(record.validFrom)) {
    errors.push('validUntil must be after validFrom');
  }
  return { ok: errors.length === 0, errors };
}

function normalize(record, { nowIso, seq }) {
  return {
    memoryId: record.memoryId ?? `mem-${seq}-${record.layer}`,
    layer: record.layer,
    scope: record.scope,
    topic: record.topic ?? null,
    source: record.source,
    confidence: Number(record.confidence ?? DEFAULT_CONFIDENCE[record.layer] ?? 0.5),
    value: record.value,
    runId: record.runId ?? null,
    evidenceDigest: record.evidenceDigest ?? null,
    validFrom: record.validFrom ?? nowIso,
    validUntil: record.validUntil ?? null,
    retired: false,
    retiredReason: null,
    supersedes: [],
    createdAt: nowIso,
  };
}

// 冲突判定：同一 scope+topic 的两条记忆谁更权威。
// 顺序固定：层级优先级 -> 置信度 -> validFrom 更新者胜 -> memoryId 字典序（保证确定性，不依赖插入顺序）。
export function compareAuthority(a, b) {
  const pa = LAYER_PRECEDENCE[a.layer] ?? 0;
  const pb = LAYER_PRECEDENCE[b.layer] ?? 0;
  if (pa !== pb) return pa - pb;
  if (a.confidence !== b.confidence) return a.confidence - b.confidence;
  const ta = Date.parse(a.validFrom ?? 0) || 0;
  const tb = Date.parse(b.validFrom ?? 0) || 0;
  if (ta !== tb) return ta - tb;
  return String(a.memoryId).localeCompare(String(b.memoryId));
}

export function resolveConflict(records = []) {
  const usable = records.filter((record) => record && record.retired !== true);
  if (!usable.length) return null;
  return usable.slice().sort(compareAuthority).at(-1);
}

// 记忆检索 + 冲突解决。当前运行的证据一旦存在，历史层一律不参与裁决。
export function resolveMemory({ scope, topic = null, at = new Date().toISOString(), records = [] } = {}) {
  const scoped = records.filter((record) => record.scope === scope && (topic === null || record.topic === topic));
  const usable = scoped.filter((record) => isUsable(record, at));
  const current = usable.filter((record) => CURRENT_RUN_LAYERS.includes(record.layer));
  if (current.length) {
    const winner = resolveConflict(current);
    return {
      source: 'CURRENT_RUN',
      record: winner,
      overridden: usable.filter((record) => record !== winner).map((record) => ({ memoryId: record.memoryId, layer: record.layer })),
      reason: 'current-run evidence outranks historical memory',
    };
  }
  const historical = usable.filter((record) => !CURRENT_RUN_LAYERS.includes(record.layer));
  const winner = resolveConflict(historical);
  return {
    source: winner ? 'HISTORICAL' : 'NONE',
    record: winner ?? null,
    overridden: historical.filter((record) => record !== winner).map((record) => ({ memoryId: record.memoryId, layer: record.layer })),
    reason: winner ? 'no current-run evidence; highest-authority historical memory used' : 'no usable memory found',
  };
}

// 显式防线：任何「用历史覆盖当前」的尝试都要在这里失败关闭。
export function assertNoHistoryOverride({ current = null, history = [] } = {}) {
  if (!current) return { ok: true, overridden: [] };
  const attempts = history.filter((record) => !CURRENT_RUN_LAYERS.includes(record.layer));
  if (attempts.length) {
    throw new MemoryError(
      `historical memory must not override current-run evidence: ${attempts.map((r) => `${r.layer}:${r.memoryId}`).join(', ')}`,
      { code: 'HISTORY_OVERRIDE_FORBIDDEN', details: { attempts } },
    );
  }
  return { ok: true, overridden: [] };
}

// 默认端口：内存实现（单元测试与单进程用）。PG 端口见 stores/pg-memory-store.mjs。
export function createMemoryPort({ nowIso = () => new Date().toISOString() } = {}) {
  const rows = new Map();
  let seq = 0;
  return {
    async insert(record) {
      rows.set(record.memoryId, record);
      return record;
    },
    async update(memoryId, patch) {
      const existing = rows.get(memoryId);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      rows.set(memoryId, next);
      return next;
    },
    async get(memoryId) {
      return rows.get(memoryId) ?? null;
    },
    async list({ layer = null } = {}) {
      const all = [...rows.values()];
      return layer ? all.filter((record) => record.layer === layer) : all;
    },
    nextSeq() {
      seq += 1;
      return seq;
    },
    nowIso,
  };
}

export function createMemoryStore({ port = createMemoryPort(), nowIso = () => new Date().toISOString() } = {}) {
  async function put(record) {
    const check = validateMemory(record);
    if (!check.ok) throw new MemoryError(`invalid memory: ${check.errors.join('; ')}`, { code: 'INVALID_MEMORY', details: check.errors });
    const normalized = normalize(record, { nowIso: typeof port.nowIso === 'function' ? port.nowIso() : nowIso(), seq: port.nextSeq() });
    // 只在「同一层 + 同 scope+topic」内自动退役旧的同类记忆（新事实替换旧事实）。
    // 跨层冲突不在这里处理：那是读取期由优先级裁决的（当前证据 > 已验证事实 > 规则 > 经验），
    // 若在写入期就把历史层退役掉，等于用「删掉历史」冒充「当前优先」，会丢掉可追溯性。
    if (normalized.topic) {
      const existing = (await port.list({ layer: normalized.layer }))
        .filter((row) => row.scope === normalized.scope && row.topic === normalized.topic && row.retired !== true);
      const superseded = existing.filter((row) => compareAuthority(normalized, row) > 0);
      for (const row of superseded) {
        await port.update(row.memoryId, { retired: true, retiredReason: `superseded by ${normalized.memoryId}` });
        normalized.supersedes.push(row.memoryId);
      }
    }
    return port.insert(normalized);
  }

  return {
    put,

    async get(memoryId) {
      return port.get(memoryId);
    },

    async retire(memoryId, { reason = 'manual' } = {}) {
      const row = await port.get(memoryId);
      if (!row) throw new MemoryError(`memory not found: ${memoryId}`, { code: 'MEMORY_NOT_FOUND' });
      return port.update(memoryId, { retired: true, retiredReason: reason });
    },

    async list({ layer = null, includeRetired = false } = {}) {
      const rows = await port.list({ layer });
      return includeRetired ? rows : rows.filter((row) => row.retired !== true);
    },

    async resolve({ scope, topic = null, at = nowIso(), currentEvidence = null } = {}) {
      const rows = await this.list({ includeRetired: false });
      const scoped = rows.filter((row) => row.scope === scope && (topic === null || row.topic === topic));
      const history = scoped.filter((row) => !CURRENT_RUN_LAYERS.includes(row.layer));
      if (currentEvidence) {
        return {
          source: 'CURRENT_RUN',
          record: {
            layer: 'EVIDENCE', scope, topic,
            source: currentEvidence.source ?? 'current-run',
            confidence: 1,
            value: currentEvidence.value ?? currentEvidence,
            evidenceDigest: currentEvidence.evidenceDigest ?? null,
          },
          overridden: history.map((row) => ({ memoryId: row.memoryId, layer: row.layer })),
          reason: 'explicit current-run evidence wins over any historical memory',
        };
      }
      return resolveMemory({ scope, topic, at, records: scoped });
    },

    assertNoHistoryOverride,
    port,
  };
}
