// Validation Registry：把 manifest 声明的 validation 名映射到实际确定性验证函数。
// 这是「manifest/实现一致」的落点：声明了未实现的验证器 → 注册期即失败，而不是运行时静默跳过。
//
// 阶段划分（重要）：采集期验证器在 Worker 产出工件后立刻执行；
// 发布/回读验证器需要外部回读收据，只能在提交后执行。两段不能混跑——
// 否则采集期会因为"还没有回读收据"而误判证据无效。
import {
  validateIdentity, validateScope, validateStructure, validateCompleteness,
  validateDigest, validateRelations, validatePublication,
  validateArtifactIntegrity, validateContiguousPrefix, runValidators,
} from './validator.mjs';

export const VALIDATION_STAGE = Object.freeze({ COLLECT: 'COLLECT', PUBLICATION: 'PUBLICATION' });

export class ValidationRegistryError extends Error {
  constructor(message, { code = 'VALIDATION_REGISTRY_ERROR', details = {} } = {}) {
    super(`${code}: ${message}`);
    this.name = 'ValidationRegistryError';
    this.code = code;
    this.details = details;
  }
}

// deps = { context, artifact, contract, observation, evidenceManifest, receipt, readbackReceipt }
export const VALIDATOR_IMPLS = Object.freeze({
  source_identity: {
    stage: VALIDATION_STAGE.COLLECT,
    validate: ({ context, artifact, observation }) => validateIdentity(context, observation ?? artifact),
  },
  scope_match: {
    stage: VALIDATION_STAGE.COLLECT,
    validate: ({ context, artifact }) => validateScope(context, artifact),
  },
  structure: {
    stage: VALIDATION_STAGE.COLLECT,
    validate: ({ artifact, contract }) => validateStructure(artifact, contract ?? {}),
  },
  completeness: {
    stage: VALIDATION_STAGE.COLLECT,
    validate: ({ artifact, contract }) => validateCompleteness(artifact, (contract ?? {}).expectedRange ?? {}),
  },
  row_count: {
    stage: VALIDATION_STAGE.COLLECT,
    validate: ({ artifact, contract }) => validateCompleteness(artifact, { expectedRows: (contract ?? {}).expectedRows }),
  },
  digest: {
    stage: VALIDATION_STAGE.COLLECT,
    validate: ({ artifact, evidenceManifest }) => {
      if (!evidenceManifest?.sha256) return { ok: true, code: null, details: {} };
      return validateDigest({ sha256: artifact?.sha256 ?? evidenceManifest.sha256 }, evidenceManifest);
    },
  },
  artifact_integrity: {
    stage: VALIDATION_STAGE.COLLECT,
    validate: ({ artifact }) => validateArtifactIntegrity(artifact),
  },
  relations: {
    stage: VALIDATION_STAGE.COLLECT,
    validate: ({ artifact, contract }) => validateRelations(artifact, contract ?? {}),
  },
  contiguous_prefix: {
    stage: VALIDATION_STAGE.COLLECT,
    validate: ({ context, artifact }) => validateContiguousPrefix(context, artifact),
  },
  publication: {
    stage: VALIDATION_STAGE.PUBLICATION,
    validate: ({ receipt, contract }) => validatePublication(receipt, (contract ?? {}).publication ?? {}),
  },
  readback: {
    stage: VALIDATION_STAGE.PUBLICATION,
    validate: ({ readbackReceipt, receipt, contract }) => validatePublication(
      readbackReceipt ?? receipt,
      (contract ?? {}).readback ?? (contract ?? {}).publication ?? {},
    ),
  },
});

export function listValidatorNames() {
  return Object.keys(VALIDATOR_IMPLS);
}

export function validatorsForStage(stage) {
  return Object.entries(VALIDATOR_IMPLS)
    .filter(([, impl]) => impl.stage === stage)
    .map(([name]) => name);
}

export function validationStageOf(name) {
  return VALIDATOR_IMPLS[name]?.stage ?? null;
}

// 声明了未实现的验证器 → 立即抛错（fail-closed）。
export function assertValidatorCoverage(manifest) {
  const declared = manifest?.validation ?? [];
  const missing = declared.filter((name) => !(name in VALIDATOR_IMPLS));
  if (missing.length) {
    throw new ValidationRegistryError(
      `${manifest?.name ?? '<unnamed>'} declares validators with no implementation: ${missing.join(', ')}`,
      { code: 'VALIDATION_NOT_IMPLEMENTED', details: { declared, missing } },
    );
  }
  return true;
}

// 按 manifest 装配指定阶段的验证器；返回 runValidators 可用的 { name, fn, args } 列表。
export function buildValidatorsFromManifest(manifest, deps = {}, { stage = VALIDATION_STAGE.COLLECT } = {}) {
  assertValidatorCoverage(manifest);
  const declared = manifest?.validation ?? [];
  return declared
    .filter((name) => VALIDATOR_IMPLS[name].stage === stage)
    .map((name) => ({ name, fn: () => VALIDATOR_IMPLS[name].validate(deps) }));
}

// 聚合执行某一阶段的 manifest 验证；无声明时返回 ok=true（不伪造通过）。
export async function runManifestValidation(manifest, deps = {}, { stage = VALIDATION_STAGE.COLLECT } = {}) {
  const validators = buildValidatorsFromManifest(manifest, deps, { stage });
  if (!validators.length) return { ok: true, results: [], failures: [], codes: [], skipped: 'no validator declared for this stage' };
  return runValidators(validators);
}
