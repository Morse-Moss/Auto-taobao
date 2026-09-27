import test from 'node:test';
import assert from 'node:assert/strict';
import { runEnvironmentPreflight } from './environment-preflight.mjs';

test('environment preflight reports deterministic registry checks', () => {
  const result = runEnvironmentPreflight({ root: process.cwd(), workflow: 'product-data' });
  assert.equal(result.version, 1);
  assert.equal(result.workflow, 'product-data');
  assert.equal(result.checks.find(check => check.name === 'ports-unique').ok, true);
  assert.equal(typeof result.ok, 'boolean');
});
