// 阶段 4a 配套单测：manifest validation 名 -> 实际验证器实现
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VALIDATOR_IMPLS, VALIDATION_STAGE, listValidatorNames, validatorsForStage,
  validationStageOf, assertValidatorCoverage, buildValidatorsFromManifest, runManifestValidation,
  ValidationRegistryError,
} from './validation-registry.mjs';
import { VALIDATION_NAMES } from './skill-manifest.mjs';

const context = { verifiedCursor: { start: 1, end: 10, version: 2 }, identity: { tenantId: 't-1' } };

function goodArtifact(overrides = {}) {
  return { artifactId: 'shard-11', sha256: 'a'.repeat(64), bytes: Buffer.from('x'), range: { start: 11, end: 20 }, rowCount: 10, ...overrides };
}

test('实现覆盖 manifest 允许声明的全部验证器名', () => {
  assert.deepEqual(
    [...listValidatorNames()].sort(),
    [...VALIDATION_NAMES].sort(),
    'VALIDATION_NAMES 与 VALIDATOR_IMPLS 必须一一对应，否则会出现在 manifest 里合法但无法执行的验证器',
  );
});

test('验证器按阶段划分且不重叠', () => {
  const collect = validatorsForStage(VALIDATION_STAGE.COLLECT);
  const publication = validatorsForStage(VALIDATION_STAGE.PUBLICATION);
  assert.equal(collect.length + publication.length, listValidatorNames().length);
  assert.deepEqual(publication.sort(), ['publication', 'readback']);
  assert.equal(validationStageOf('contiguous_prefix'), 'COLLECT');
  assert.equal(validationStageOf('readback'), 'PUBLICATION');
  assert.equal(validationStageOf('ghost_validator'), null);
});

test('assertValidatorCoverage 对未实现声明抛 fail-closed 错误', () => {
  assert.equal(assertValidatorCoverage({ name: 'a.b.c', validation: ['row_count'] }), true);
  assert.throws(
    () => assertValidatorCoverage({ name: 'a.b.c', validation: ['row_count', 'vibes'] }),
    (error) => error instanceof ValidationRegistryError
      && error.code === 'VALIDATION_NOT_IMPLEMENTED'
      && error.details.missing[0] === 'vibes',
  );
});

test('buildValidatorsFromManifest 只取声明过的、且属于该阶段的验证器', () => {
  const manifest = { name: 'a.b.c', validation: ['structure', 'contiguous_prefix', 'readback'] };
  const collect = buildValidatorsFromManifest(manifest, {});
  assert.deepEqual(collect.map((v) => v.name), ['structure', 'contiguous_prefix']);
  const publication = buildValidatorsFromManifest(manifest, {}, { stage: VALIDATION_STAGE.PUBLICATION });
  assert.deepEqual(publication.map((v) => v.name), ['readback']);
});

test('contiguous_prefix：范围必须紧接已验证游标', () => {
  const manifest = { name: 'a.b.c', validation: ['contiguous_prefix'] };
  const ok = buildValidatorsFromManifest(manifest, { context, artifact: goodArtifact() });
  assert.equal(ok[0].fn().ok, true);

  const bad = buildValidatorsFromManifest(manifest, { context, artifact: goodArtifact({ range: { start: 12, end: 20 } }) });
  const result = bad[0].fn();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCOPE_MISMATCH');
  assert.equal(result.details.cursorEnd, 10);
});

test('contiguous_prefix：缺 range 视为无效（不允许隐式空范围）', () => {
  const [validator] = buildValidatorsFromManifest({ name: 'a.b.c', validation: ['contiguous_prefix'] }, { context, artifact: { sha256: 'a'.repeat(64) } });
  assert.equal(validator.fn().ok, false);
});

test('row_count 与 structure 按 contract 生效', () => {
  const [rowCount] = buildValidatorsFromManifest({ name: 'a.b.c', validation: ['row_count'] }, { artifact: goodArtifact(), contract: { expectedRows: 12 } });
  const mismatch = rowCount.fn();
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'INCOMPLETE_RANGE');

  const [structure] = buildValidatorsFromManifest({ name: 'a.b.c', validation: ['structure'] }, { artifact: { range: {} }, contract: { requiredFields: ['价格'] } });
  assert.equal(structure.fn().code, 'STRUCTURE_INVALID');
});

test('artifact_integrity 与 digest 抓缺失摘要/摘要不符', () => {
  const [integrity] = buildValidatorsFromManifest({ name: 'a.b.c', validation: ['artifact_integrity'] }, { artifact: { path: null } });
  assert.equal(integrity.fn().ok, false);
  assert.equal(integrity.fn().code, 'ARTIFACT_INCOMPLETE');

  const [digest] = buildValidatorsFromManifest(
    { name: 'a.b.c', validation: ['digest'] },
    { artifact: goodArtifact(), evidenceManifest: { sha256: 'b'.repeat(64) } },
  );
  const mismatch = digest.fn();
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'DIGEST_MISMATCH');
});

test('发布期验证器需要回读收据，缺收据不判通过', () => {
  const manifest = { name: 'a.b.c', validation: ['publication', 'readback'] };
  const missing = buildValidatorsFromManifest(manifest, {}, { stage: VALIDATION_STAGE.PUBLICATION });
  assert.equal(missing[0].fn().ok, false);
  assert.equal(missing[0].fn().code, 'PUBLICATION_UNVERIFIED');

  const receipt = { rows: 10, digest: 'd1', verifiedAt: new Date().toISOString() };
  const ok = buildValidatorsFromManifest(manifest, { receipt, readbackReceipt: receipt, contract: { publication: { rows: 10, digest: 'd1' } } }, { stage: VALIDATION_STAGE.PUBLICATION });
  assert.equal(ok[0].fn().ok, true);
  assert.equal(ok[1].fn().ok, true);
});

test('runManifestValidation 聚合结果并按阶段过滤', async () => {
  const manifest = { name: 'a.b.c', validation: ['structure', 'contiguous_prefix', 'readback'] };
  const collect = await runManifestValidation(manifest, { context, artifact: goodArtifact(), contract: {} });
  assert.equal(collect.ok, true);
  assert.deepEqual(collect.results.map((r) => r.name), ['structure', 'contiguous_prefix']);

  const failed = await runManifestValidation(manifest, { context, artifact: goodArtifact({ range: { start: 99, end: 100 } }) });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.codes, ['SCOPE_MISMATCH']);

  const none = await runManifestValidation({ name: 'a.b.c', validation: ['publication'] }, {});
  assert.equal(none.ok, true);
  assert.equal(none.skipped, 'no validator declared for this stage');
});

test('VALIDATOR_IMPLS 每个实现都声明了合法阶段', () => {
  for (const [name, impl] of Object.entries(VALIDATOR_IMPLS)) {
    assert.ok(Object.values(VALIDATION_STAGE).includes(impl.stage), `${name} 阶段非法`);
    assert.equal(typeof impl.validate, 'function', `${name} 缺 validate`);
  }
});
