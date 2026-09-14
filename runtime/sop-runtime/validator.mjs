// Validation Framework：可组合确定性验证器（纯函数，不调用模型，不推进游标）
export const VALIDATOR_CODES = Object.freeze([
  'IDENTITY_MISMATCH', 'SCOPE_MISMATCH', 'STRUCTURE_INVALID',
  'INCOMPLETE_RANGE', 'DIGEST_MISMATCH', 'RELATION_INVALID', 'PUBLICATION_UNVERIFIED',
  'ARTIFACT_INCOMPLETE',
]);

function result(ok, code, details = {}) {
  return { ok, code: ok ? null : code, details };
}

export function validateIdentity(context, observation) {
  if (!observation?.identity) return result(true);
  const expected = context.identity ?? {};
  const actual = observation.identity ?? {};
  const diffs = Object.keys(expected).filter((key) => String(expected[key]) !== String(actual[key]));
  return diffs.length
    ? result(false, 'IDENTITY_MISMATCH', { diffs, expected, actual })
    : result(true);
}

export function validateScope(context, artifact) {
  const cursor = context.verifiedCursor;
  const range = artifact?.range;
  if (!range) return result(true);
  if (cursor && Number(range.start) !== Number(cursor.end) + 1) {
    return result(false, 'SCOPE_MISMATCH', { reason: 'range must continue from verified cursor', cursor, range });
  }
  if (Number(range.start) > Number(range.end)) {
    return result(false, 'SCOPE_MISMATCH', { reason: 'start must not exceed end', range });
  }
  return result(true);
}

export function validateStructure(artifact, contract = {}) {
  const required = contract.requiredFields ?? [];
  const missing = required.filter((field) => artifact?.[field] === undefined || artifact?.[field] === null);
  return missing.length ? result(false, 'STRUCTURE_INVALID', { missing }) : result(true);
}

export function validateCompleteness(artifact, expectedRange = {}) {
  const rows = artifact?.rowCount;
  if (rows === undefined || rows === null) return result(true);
  const expected = expectedRange.expectedRows;
  if (expected !== undefined && Number(rows) !== Number(expected)) {
    return result(false, 'INCOMPLETE_RANGE', { rows, expected });
  }
  if (Number(rows) <= 0) return result(false, 'INCOMPLETE_RANGE', { rows, reason: 'empty artifact' });
  return result(true);
}

export function validateDigest(artifact, manifest) {
  if (!manifest?.sha256) return result(true);
  if (artifact?.sha256 !== manifest.sha256) {
    return result(false, 'DIGEST_MISMATCH', { artifact: artifact?.sha256, manifest: manifest.sha256 });
  }
  return result(true);
}

export function validateRelations(artifact, contract = {}) {
  const checks = contract.relations ?? [];
  const failures = checks.filter((check) => {
    const actual = artifact?.[check.field];
    return check.expected !== undefined && String(actual) !== String(check.expected);
  });
  return failures.length ? result(false, 'RELATION_INVALID', { failures }) : result(true);
}

export function validatePublication(receipt, expected = {}) {
  if (!receipt) return result(false, 'PUBLICATION_UNVERIFIED', { reason: 'no receipt' });
  if (expected.rows !== undefined && Number(receipt.rows) !== Number(expected.rows)) {
    return result(false, 'PUBLICATION_UNVERIFIED', { reason: 'read-back row mismatch', receipt, expected });
  }
  if (expected.digest !== undefined && receipt.digest !== expected.digest) {
    return result(false, 'PUBLICATION_UNVERIFIED', { reason: 'read-back digest mismatch', receipt, expected });
  }
  if (!receipt.verifiedAt) return result(false, 'PUBLICATION_UNVERIFIED', { reason: 'receipt not verified' });
  return result(true);
}

// 工件完整性：必须有摘要，且必须能落到具体字节或文件路径；声明行数时不得为 0。
// 只判断"工件是否可被独立复验"，不判断业务内容对错。
export function validateArtifactIntegrity(artifact) {
  if (!artifact) return result(false, 'ARTIFACT_INCOMPLETE', { reason: 'no artifact' });
  const problems = [];
  if (!/^[0-9a-f]{64}$/.test(String(artifact.sha256 ?? ''))) problems.push('missing sha256 digest');
  const hasBytes = artifact.bytes !== undefined && artifact.bytes !== null;
  const hasPath = typeof artifact.path === 'string' && artifact.path.length > 0;
  if (!hasBytes && !hasPath) problems.push('missing bytes or path');
  if (artifact.rowCount !== undefined && artifact.rowCount !== null && Number(artifact.rowCount) <= 0) problems.push('rowCount must be positive');
  return problems.length ? result(false, 'ARTIFACT_INCOMPLETE', { problems }) : result(true);
}

// 连续前缀：分片范围必须紧接已验证游标，且 end 不小于 start。
// 与 validateScope 的差别：这里要求 range 必须存在（连续采集不允许隐式空范围）。
export function validateContiguousPrefix(context, artifact) {
  const range = artifact?.range;
  if (!range) return result(false, 'SCOPE_MISMATCH', { reason: 'contiguous prefix requires an explicit range' });
  const cursorEnd = Number(context?.verifiedCursor?.end ?? 0);
  if (Number(range.start) !== cursorEnd + 1) {
    return result(false, 'SCOPE_MISMATCH', { reason: 'range must start immediately after the verified cursor', cursorEnd, range });
  }
  if (Number(range.end) < Number(range.start)) {
    return result(false, 'SCOPE_MISMATCH', { reason: 'range end must not precede range start', range });
  }
  return result(true);
}

// 聚合执行（异步）：任一失败即整体失败，返回全部失败码便于审计。
// 允许 async 验证器；不 await 会把 Promise 当空结果，导致坏证据被误判通过。
export async function runValidators(validators = []) {
  const results = [];
  for (const entry of validators) {
    const { name, fn, args } = entry;
    const outcome = await fn(...(args ?? []));
    results.push({ name, ...outcome });
  }
  const failures = results.filter((entry) => entry.ok !== true);
  return {
    ok: failures.length === 0,
    results,
    failures,
    codes: [...new Set(failures.map((entry) => entry.code))],
  };
}
