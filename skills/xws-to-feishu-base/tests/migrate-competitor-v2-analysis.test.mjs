import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCompetitorFieldContract } from '../scripts/migrate-competitor-v2-analysis.mjs';

const before = [
  { field_id: 'fldTitle', field_name: '商品标题', type: 1 },
  { field_id: 'fldPrice', field_name: '价格', type: 2 },
  { field_id: 'fldClass', field_name: '竞品分类', type: 3 },
];

test('field contract preserves field identity and immutable types while allowing named formula fields to change type', () => {
  assert.doesNotThrow(() => assertCompetitorFieldContract({
    before,
    after: [
      { field_id: 'fldTitle', field_name: '商品标题', type: 1 },
      { field_id: 'fldPrice', field_name: '价格', type: 2 },
      { field_id: 'fldClass', field_name: '竞品分类', type: 20 },
    ],
    mutableFieldNames: new Set(['竞品分类']),
  }));
  assert.throws(() => assertCompetitorFieldContract({
    before,
    after: [
      { field_id: 'fldTitle', field_name: '商品标题', type: 2 },
      { field_id: 'fldPrice', field_name: '价格', type: 2 },
      { field_id: 'fldClass', field_name: '竞品分类', type: 20 },
    ],
    mutableFieldNames: new Set(['竞品分类']),
  }), /immutable field changed/u);
});

test('field contract rejects additions and removals even when mutable fields are present', () => {
  assert.throws(() => assertCompetitorFieldContract({
    before,
    after: before.slice(1),
    mutableFieldNames: new Set(['竞品分类']),
  }), /field count changed/u);
});

test('field contract rejects type changes on AI fields even when formula fields are mutable', () => {
  assert.throws(() => assertCompetitorFieldContract({
    before: [
      { field_id: 'fldAi', field_name: '材质分类', type: 1 },
      { field_id: 'fldClass', field_name: '竞品分类', type: 3 },
    ],
    after: [
      { field_id: 'fldAi', field_name: '材质分类', type: 4 },
      { field_id: 'fldClass', field_name: '竞品分类', type: 20 },
    ],
}), /immutable field changed/u);
});

test('field contract keeps mutable analysis fields formula-only', () => {
  assert.throws(() => assertCompetitorFieldContract({
    before: [{ field_id: 'fldClass', field_name: '竞品分类', type: 3 }],
    after: [{ field_id: 'fldClass', field_name: '竞品分类', type: 1 }],
  }), /mutable formula field changed to non-formula/u);
});
