const APPROVED_SPACES = new Set(['小户型', '常规卫生间']);

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function required(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(name + ' is required');
  return normalized;
}

function toCreateItems(manifest) {
  return manifest?.plan?.items?.filter((item) => item.action === 'toCreate') ?? [];
}

function assertManifestTarget(manifest, target, expectedRecordCount) {
  if (manifest?.version !== 'xws-sku-dry-run-manifest-v1' || manifest?.mode !== 'DRY_RUN') {
    throw new Error('Unsupported SKU dry-run manifest');
  }
  if (!same(manifest.target, target)) throw new Error('Manifest target differs from the approved target');
  if (!manifest.plan?.summary?.writeReady) throw new Error('Manifest is not write-ready');
  if (Number(manifest.plan.summary.toCreate) !== expectedRecordCount) {
    throw new Error('Manifest to-create count differs from the approved record count');
  }
  if (Number(manifest.plan.summary.conflict) !== 0 || Number(manifest.plan.summary.duplicateExistingKeys) !== 0) {
    throw new Error('Manifest contains a SKU conflict or duplicate key');
  }
}

function assertItem(item, target, mainRecordId) {
  const fields = item?.writeFields ?? {};
  const uniqueKey = required(fields.SKU唯一键, 'SKU unique key');
  if (item.action !== 'toCreate' || item.uniqueKey !== uniqueKey || !required(item.skuId, 'SKU ID')) {
    throw new Error('Manifest SKU item is not a valid create item');
  }
  if (!APPROVED_SPACES.has(fields.适用空间)) {
    throw new Error('SKU 适用空间 is outside the approved values');
  }
  if (!Array.isArray(fields.所属竞品) || fields.所属竞品.length !== 1 || fields.所属竞品[0] !== mainRecordId) {
    throw new Error('SKU 所属竞品 must be the selected main record ID');
  }
  if (!uniqueKey.startsWith(required(fields.商品ID, 'SKU product ID') + '|')) {
    throw new Error('SKU unique key does not begin with its product ID');
  }
  return fields;
}

export function buildSkuBatchCreateRequest(manifest, { target, expectedRecordCount }) {
  assertManifestTarget(manifest, target, expectedRecordCount);
  const mainRecordId = required(manifest?.evidence?.source?.mainRecordId, 'manifest main record ID');
  const items = toCreateItems(manifest);
  if (items.length !== expectedRecordCount || items.length === 0 || items.length > 500) {
    throw new Error('Manifest create items differ from the approved record count');
  }
  const keys = new Set();
  const records = items.map((item) => {
    const fields = assertItem(item, target, mainRecordId);
    if (keys.has(fields.SKU唯一键)) throw new Error('Manifest contains duplicate SKU unique keys');
    keys.add(fields.SKU唯一键);
    return { fields };
  });
  return {
    method: 'POST',
    path: '/bitable/v1/apps/' + target.appToken + '/tables/' + target.skuTableId + '/records/batch_create',
    body: { records },
  };
}

function comparableItems(plan) {
  return (plan?.items ?? []).map((item) => {
    if (item.action === 'toCreate') {
      return { uniqueKey: item.uniqueKey, action: item.action, writeFields: item.writeFields };
    }
    return {
      uniqueKey: item.uniqueKey,
      action: item.action,
      reason: item.reason ?? null,
      recordId: item.recordId ?? null,
      recordIds: item.recordIds ?? null,
    };
  }).sort((left, right) => String(left.uniqueKey).localeCompare(String(right.uniqueKey)));
}

export function assertFreshPlanMatchesManifest(manifest, freshPlan, { expectedRecordCount }) {
  assertManifestTarget(manifest, manifest.target, expectedRecordCount);
  if (!freshPlan?.summary?.writeReady || Number(freshPlan.summary.toCreate) !== expectedRecordCount) {
    throw new Error('Fresh SKU plan is not ready for the approved record count');
  }
  if (!same(comparableItems(manifest.plan), comparableItems(freshPlan))) {
    throw new Error('Fresh SKU plan differs from the approved manifest');
  }
}

export function assertPostWritePlan(plan, { expectedRecordCount }) {
  const summary = plan?.summary ?? {};
  if (Number(summary.parsedRows) !== expectedRecordCount
    || Number(summary.toCreate) !== 0
    || Number(summary.alreadyPresent) !== expectedRecordCount
    || Number(summary.conflict) !== 0
    || Number(summary.duplicateExistingKeys) !== 0) {
    throw new Error('Post-write SKU plan does not contain only already present records');
  }
  const items = plan?.items ?? [];
  if (items.length !== expectedRecordCount || items.some((item) => item.action !== 'alreadyPresent' || !item.recordId)) {
    throw new Error('Post-write SKU records are not all already present');
  }
}
