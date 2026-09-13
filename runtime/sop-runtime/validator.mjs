// Validation Framework：可组合确定性验证器（纯函数，不调用模型，不推进游标）
export const VALIDATOR_CODES = Object.freeze([
  'IDENTITY_MISMATCH', 'SCOPE_MISMATCH', 'STRUCTURE_INVALID',
  'INCOMPLETE_RANGE', 'DIGEST_MISMATCH', 'RELATION_INVALID', 'PUBLICATION_UNVERIFIED',
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
