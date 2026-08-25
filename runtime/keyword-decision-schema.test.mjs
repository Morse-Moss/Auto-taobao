import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDecisionSchemaMutation,
  buildDecisionSchemaPlan,
  verifyDecisionSchemaMigration,
} from './keyword-decision-schema.mjs';

function field(id, name, type = 1, property = null) {
  return { field_id: id, field_name: name, type, property };
}

function currentFields() {
  return [
    field('fldSearch', '搜索词'),
    field('fldContentHeat', '内容热度（后续）'),
    field('fldOldRecent', '近8批出现次数', 2, { formatter: '0.0' }),
  ];
}

function currentRecords(value = null) {
  return [{ record_id: 'rec1', fields: { 搜索词: '浴缸', 近8批出现次数: value } }];
}

test('plans the content-name normalization and the admitted helper fields', () => {
  const plan = buildDecisionSchemaPlan({ fields: currentFields(), records: currentRecords() });

  assert.deepEqual(plan, {
    updates: [
      {
        fieldId: 'fldContentHeat',
        oldName: '内容热度（后续）',
        fieldName: '内容热度',
        body: { field_name: '内容热度', type: 1 },
      },
      {
        fieldId: 'fldOldRecent',
        oldName: '近8批出现次数',
        fieldName: '近2周重点达标次数',
        body: { field_name: '近2周重点达标次数', type: 2, property: { formatter: '0.0' } },
      },
    ],
    creates: [
      { fieldName: '灰豚话题浏览量', body: { field_name: '灰豚话题浏览量', type: 2 } },
      { fieldName: '近2周A级达标次数', body: { field_name: '近2周A级达标次数', type: 2 } },
      { fieldName: '近2周探索达标次数', body: { field_name: '近2周探索达标次数', type: 2 } },
      { fieldName: '上一有效周重点达标', body: { field_name: '上一有效周重点达标', type: 2 } },
      { fieldName: '上一有效周A级达标', body: { field_name: '上一有效周A级达标', type: 2 } },
      { fieldName: '上一有效周探索达标', body: { field_name: '上一有效周探索达标', type: 2 } },
    ],
    recordsWillBeWritten: false,
  });
});

test('adds the three previous-valid-week snapshots without repurposing current count values', () => {
  const fields = [
    field('fldSearch', '搜索词'),
    field('fldContentHeat', '内容热度'),
    field('fldRecent', '近2周重点达标次数', 2),
    field('fldViews', '灰豚话题浏览量', 2),
    field('fldRecentA', '近2周A级达标次数', 2),
    field('fldRecentExplore', '近2周探索达标次数', 2),
  ];
  const records = [{ record_id: 'rec1', fields: { 搜索词: '浴缸', 近2周重点达标次数: 2 } }];
  const plan = buildDecisionSchemaPlan({ fields, records });
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.creates.map((item) => item.fieldName), [
    '上一有效周重点达标',
    '上一有效周A级达标',
    '上一有效周探索达标',
  ]);
});

test('refuses to repurpose the old helper field when it contains data', () => {
  assert.throws(
    () => buildDecisionSchemaPlan({ fields: currentFields(), records: currentRecords(3) }),
    /近8批出现次数.*non-empty/iu,
  );
});

test('mutation guard permits only the planned field rename and creation', () => {
  const plan = buildDecisionSchemaPlan({ fields: currentFields(), records: currentRecords() });
  const context = { appToken: 'app', tableId: 'table', plan };
  const recentRename = plan.updates.find((item) => item.oldName === '近8批出现次数');

  assert.doesNotThrow(() => assertDecisionSchemaMutation({
    ...context,
    method: 'PUT',
    path: '/bitable/v1/apps/app/tables/table/fields/fldOldRecent',
    body: recentRename.body,
  }));
  assert.doesNotThrow(() => assertDecisionSchemaMutation({
    ...context,
    method: 'POST',
    path: '/bitable/v1/apps/app/tables/table/fields',
    body: plan.creates[0].body,
  }));

  for (const request of [
    { method: 'POST', path: '/bitable/v1/apps/app/tables/table/records', body: { fields: {} } },
    { method: 'PUT', path: '/bitable/v1/apps/app/tables/table/fields/fldSearch', body: { field_name: '搜索词', type: 1 } },
    { method: 'POST', path: '/bitable/v1/apps/app/tables/table/fields', body: { field_name: '灰豚话题浏览量', type: 1 } },
  ]) {
    assert.throws(() => assertDecisionSchemaMutation({ ...context, ...request }), /blocked/iu);
  }
});

test('is idempotent after both new fields exist', () => {
  const fields = [
    field('fldSearch', '搜索词'),
    field('fldContentHeat', '内容热度'),
    field('fldRecent', '近2周重点达标次数', 2, { formatter: '0.0' }),
    field('fldViews', '灰豚话题浏览量', 2),
    field('fldRecentA', '近2周A级达标次数', 2),
    field('fldRecentExplore', '近2周探索达标次数', 2),
    field('fldPreviousTargets', '上一有效周重点达标', 2),
    field('fldPreviousA', '上一有效周A级达标', 2),
    field('fldPreviousExplore', '上一有效周探索达标', 2),
  ];
  const records = [{ record_id: 'rec1', fields: { 搜索词: '浴缸' } }];

  assert.deepEqual(buildDecisionSchemaPlan({ fields, records }), {
    updates: [],
    creates: [],
    recordsWillBeWritten: false,
  });
});

test('verification permits only the approved schema delta and no business-record change', () => {
  const before = { fields: currentFields(), records: currentRecords() };
  const plan = buildDecisionSchemaPlan(before);
  const after = {
    fields: [
      field('fldSearch', '搜索词'),
      field('fldContentHeat', '内容热度'),
      field('fldOldRecent', '近2周重点达标次数', 2, { formatter: '0.0' }),
      field('fldViews', '灰豚话题浏览量', 2),
      field('fldRecentA', '近2周A级达标次数', 2),
      field('fldRecentExplore', '近2周探索达标次数', 2),
      field('fldPreviousTargets', '上一有效周重点达标', 2),
      field('fldPreviousA', '上一有效周A级达标', 2),
      field('fldPreviousExplore', '上一有效周探索达标', 2),
    ],
    records: [{ record_id: 'rec1', fields: { 搜索词: '浴缸', 近2周重点达标次数: null, 灰豚话题浏览量: null } }],
  };

  assert.deepEqual(verifyDecisionSchemaMigration({ before, after, plan }), {
    fieldsRenamed: 2,
    fieldsCreated: 6,
    recordsWritten: 0,
  });

  const corrupted = structuredClone(after);
  corrupted.records[0].fields.搜索词 = '被改写';
  assert.throws(() => verifyDecisionSchemaMigration({ before, after: corrupted, plan }), /changed.*record data/iu);
});
