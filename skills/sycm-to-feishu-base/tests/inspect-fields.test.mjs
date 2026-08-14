import assert from 'node:assert/strict';
import { mapVisibleFields } from '../scripts/inspect-feishu-fields.mjs';

const fields = {
  fldText: { id: 'fldText', name: '搜索词', type: 1 },
  fldNumber: { id: 'fldNumber', name: '排名', type: 2 },
  fldFormula: { id: 'fldFormula', name: '价格带', type: 20 },
};

assert.deepEqual(mapVisibleFields(fields, ['fldNumber', 'fldText', 'fldFormula']), [
  { order: 1, id: 'fldNumber', name: '排名', type: 2, typeName: 'number' },
  { order: 2, id: 'fldText', name: '搜索词', type: 1, typeName: 'text' },
  { order: 3, id: 'fldFormula', name: '价格带', type: 20, typeName: 'formula' },
]);

assert.throws(
  () => mapVisibleFields(fields, ['fldMissing']),
  /visible field not found: fldMissing/,
);

console.log('field inspection mapping passed');
