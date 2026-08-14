const OLD_RECENT_FIELD = '近8批出现次数';
const RECENT_FIELD = '近2周重点达标次数';
const HUITUN_VIEWS_FIELD = '灰豚话题浏览量';

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fieldsNamed(fields, name) {
  return fields.filter((field) => field.field_name === name);
}

function requiredSingle(fields, name) {
  const matches = fieldsNamed(fields, name);
  if (matches.length !== 1) throw new Error(`Expected exactly one field named ${name}; received ${matches.length}`);
  return matches[0];
}

function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(plain).join('');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return String(value);
}

function canonicalRecords(records) {
  const ignored = new Set([OLD_RECENT_FIELD, RECENT_FIELD, HUITUN_VIEWS_FIELD]);
  return [...records]
    .map((record) => ({
      record_id: record.record_id,
      fields: Object.fromEntries(Object.entries(record.fields ?? {})
        .filter(([name]) => !ignored.has(name))
        .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))),
    }))
    .sort((left, right) => left.record_id.localeCompare(right.record_id));
}

export function buildDecisionSchemaPlan({ fields, records }) {
  requiredSingle(fields, '搜索词');
  requiredSingle(fields, '内容热度（后续）');

  const oldMatches = fieldsNamed(fields, OLD_RECENT_FIELD);
  const recentMatches = fieldsNamed(fields, RECENT_FIELD);
  if (oldMatches.length > 1 || recentMatches.length > 1 || (oldMatches.length && recentMatches.length)) {
    throw new Error('Decision helper fields are ambiguous');
  }

  const updates = [];
  if (oldMatches.length === 1) {
    const old = oldMatches[0];
    if (old.type !== 2) throw new Error(`${OLD_RECENT_FIELD} expected number type 2; received ${old.type}`);
    const populated = records.filter((record) => plain(record.fields?.[OLD_RECENT_FIELD]).trim() !== '');
    if (populated.length) throw new Error(`${OLD_RECENT_FIELD} contains ${populated.length} non-empty records`);
    updates.push({
      fieldId: old.field_id,
      oldName: OLD_RECENT_FIELD,
      fieldName: RECENT_FIELD,
      body: {
        field_name: RECENT_FIELD,
        type: 2,
        ...(old.property ? { property: structuredClone(old.property) } : {}),
      },
    });
  } else if (recentMatches.length === 1 && recentMatches[0].type !== 2) {
    throw new Error(`${RECENT_FIELD} expected number type 2; received ${recentMatches[0].type}`);
  } else if (recentMatches.length === 0) {
    throw new Error(`Missing both ${OLD_RECENT_FIELD} and ${RECENT_FIELD}`);
  }

  const viewMatches = fieldsNamed(fields, HUITUN_VIEWS_FIELD);
  if (viewMatches.length > 1) throw new Error(`Expected at most one field named ${HUITUN_VIEWS_FIELD}`);
  if (viewMatches.length === 1 && viewMatches[0].type !== 2) {
    throw new Error(`${HUITUN_VIEWS_FIELD} expected number type 2; received ${viewMatches[0].type}`);
  }
  const creates = viewMatches.length === 0
    ? [{ fieldName: HUITUN_VIEWS_FIELD, body: { field_name: HUITUN_VIEWS_FIELD, type: 2 } }]
    : [];

  return { updates, creates, recordsWillBeWritten: false };
}

export function assertDecisionSchemaMutation({ appToken, tableId, plan, method, path, body }) {
  const approvedUpdate = plan.updates.some((update) =>
    method === 'PUT' &&
    path === `/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${update.fieldId}` &&
    same(body, update.body));
  const approvedCreate = plan.creates.some((create) =>
    method === 'POST' &&
    path === `/bitable/v1/apps/${appToken}/tables/${tableId}/fields` &&
    same(body, create.body));
  if (!approvedUpdate && !approvedCreate) {
    throw new Error(`Blocked unauthorized decision schema mutation: ${method} ${path}`);
  }
}

export function verifyDecisionSchemaMigration({ before, after, plan }) {
  if (before.records.length !== after.records.length || !same(canonicalRecords(before.records), canonicalRecords(after.records))) {
    throw new Error('Decision schema migration changed business record data');
  }
  if (after.fields.length !== before.fields.length + plan.creates.length) {
    throw new Error('Decision schema migration changed the field count unexpectedly');
  }

  const updatesById = new Map(plan.updates.map((update) => [update.fieldId, update]));
  for (const prior of before.fields) {
    const next = after.fields.find((field) => field.field_id === prior.field_id);
    if (!next) throw new Error(`Decision schema migration removed field ${prior.field_name}`);
    const update = updatesById.get(prior.field_id);
    if (!update) {
      if (!same(prior, next)) throw new Error(`Decision schema migration changed unauthorized field ${prior.field_name}`);
      continue;
    }
    if (next.field_name !== update.fieldName || next.type !== update.body.type ||
        !same(next.property ?? null, update.body.property ?? null)) {
      throw new Error(`Decision schema migration did not apply approved rename for ${update.oldName}`);
    }
  }

  const priorIds = new Set(before.fields.map((field) => field.field_id));
  const added = after.fields.filter((field) => !priorIds.has(field.field_id));
  if (added.length !== plan.creates.length || added.some((field, index) =>
    field.field_name !== plan.creates[index]?.fieldName || field.type !== plan.creates[index]?.body.type)) {
    throw new Error('Decision schema migration created an unauthorized field');
  }
  requiredSingle(after.fields, RECENT_FIELD);
  requiredSingle(after.fields, HUITUN_VIEWS_FIELD);

  return {
    fieldsRenamed: plan.updates.length,
    fieldsCreated: plan.creates.length,
    recordsWritten: 0,
  };
}
