import test from 'node:test';
import assert from 'node:assert/strict';
import { shopBrowserKeys } from './browser-ports.mjs';
import { buildProductJobPlan, renderProductJobEntry } from './product-data-job-core.mjs';

test('product job defaults to yesterday and covers all registered shops in parallel waves', () => {
  const plan = buildProductJobPlan();
  assert.equal(plan.dateInput, 'yesterday');
  assert.deepEqual(plan.shops, shopBrowserKeys());
  assert.equal(plan.parallelShopCount, 5);
  assert.deepEqual(plan.reportOrder, ['product', 'inquiry', 'promotion']);
});

test('product job plan rejects unknown or empty shop selection', () => {
  assert.throws(() => buildProductJobPlan({ shops: [] }), /at least one/u);
  assert.throws(() => buildProductJobPlan({ shops: ['missing'] }), /unknown shops/u);
});

test('scheduled entry targets the independent product-data job and commits yesterday by default', () => {
  assert.equal(renderProductJobEntry({ nodeExe: 'C:\\Program Files\\node\\node.exe', repoRoot: 'D:\\repo' }),
    '"C:\\Program Files\\node\\node.exe" "D:\\repo\\scripts\\run-product-data-job.mjs" --date yesterday --commit');
});
