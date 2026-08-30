import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDocumentModel } from './generate-weekly-analysis-doc.mjs';
import { ANALYSIS_REGISTRY, canonicalDigest } from './weekly-local-analysis.mjs';

test('document model binds the executable registry and publish artifact', () => {
  const artifact = {
    status: 'PUBLISH_READY', registryVersion: ANALYSIS_REGISTRY.version,
    registryDigest: canonicalDigest(ANALYSIS_REGISTRY), artifactDigest: 'artifact-digest',
    providerResults: [{ provider: 'codex', validation: 'VALIDATED' }],
    huitunResults: { source: { collected_at: '2026-08-27T00:00:00Z' }, items: [] },
    evidence: { providerDigest: 'provider', huitunDigest: canonicalDigest({ source: { collected_at: '2026-08-27T00:00:00Z' }, items: [] }) },
    sourceEvidence: { csvSha256: 'csv-source', xlsxSha256: 'xlsx-source', inputSnapshotDigest: 'snapshot' },
    analysisValues: [{ fields: { 优先级: 'A候选' } }],
    publishPlan: { planDigest: 'plan-digest', tables: {
      current: { tableId: 'current', updates: [{ record_id: 'r1' }] },
      history: { tableId: 'history', creates: [], updates: [{ record_id: 'h1' }] },
      library: { tableId: 'library', creates: [], },
    } },
  };
  const model = buildDocumentModel({ artifact });
  assert.equal(model.registryVersion, ANALYSIS_REGISTRY.version);
  assert.equal(model.registryDigest, canonicalDigest(ANALYSIS_REGISTRY));
  assert.equal(model.fields.length, ANALYSIS_REGISTRY.fields.length);
  assert.equal(model.prompts.productDirection, ANALYSIS_REGISTRY.prompts.productDirection);
  assert.ok(model.fields.some((field) => field.name === '内容热度' && field.owner === 'llm'));
  assert.equal(model.artifactDigest, 'artifact-digest');
  assert.equal(model.planDigest, 'plan-digest');
  assert.deepEqual(model.publishSummary, { currentUpdates: 1, historyCreates: 0, historyUpdates: 1, libraryCreates: 0 });
  assert.equal(model.providerSummary.validated, 1);
  assert.equal(model.huitunSummary.items, 0);
  assert.equal(model.evidenceDigests.provider, 'provider');
  assert.equal(model.evidenceDigests.huitun, canonicalDigest({ source: { collected_at: '2026-08-27T00:00:00Z' }, items: [] }));
  assert.equal(model.sourceEvidence.csvSha256, 'csv-source');
});
