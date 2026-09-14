// Worker / Adapter：确定性执行契约（Spec 11.1）。平台细节只在 Adapter 内。
// Worker 不拥有运行状态，只按 Controller 指派的 attempt 执行一次；不扫描或关闭未知资源。
import { runValidators, validateIdentity, validateScope, validateStructure, validateCompleteness, validateDigest } from './validator.mjs';
import { runManifestValidation, VALIDATION_STAGE } from './validation-registry.mjs';

export const CAPABILITY_CONTRACT = Object.freeze([
  'checkSession', 'prepare', 'start', 'observe', 'collectArtifact', 'validate', 'release',
]);

export function assertAdapter(adapter) {
  const missing = CAPABILITY_CONTRACT.filter((name) => typeof adapter?.[name] !== 'function');
  if (missing.length) {
    const error = new Error(`adapter is missing contract methods: ${missing.join(', ')}`);
    error.code = 'ADAPTER_CONTRACT_VIOLATION';
    throw error;
  }
  return adapter;
}

function failureClassOf(error) {
  if (error?.failureClass) return error.failureClass;
  if (error?.code === 'VALIDATION_NOT_IMPLEMENTED' || error?.code === 'ADAPTER_CONTRACT_VIOLATION') return 'CAPABILITY_DEGRADED';
  const message = String(error?.message ?? error);
  if (/login|captcha|风控|risk/i.test(message)) return 'HUMAN_REQUIRED';
  if (/timeout|network|ECONN|ETIMEDOUT|5\d\d/i.test(message)) return 'TRANSIENT_EXTERNAL';
  if (/busy|lease|lock/i.test(message)) return 'RESOURCE_BUSY';
  if (/selector|dom|page structure|capability/i.test(message)) return 'CAPABILITY_DEGRADED';
  return 'BUG';
}

export function createDeterministicWorker({
  adapter,
  controller,
  evidenceStore = null,
  contract = {},
  heartbeatMs = 0,
  manifest = null,
} = {}) {
  assertAdapter(adapter);

  return {
    // 执行一次确定性步骤：begin -> prepare/start -> observe -> artifact -> validate -> 登记
    async runOnce({ runId, input = {}, stage = 'RUN', stepId = null, manifestMeta = {} }) {
      const context = await controller.beginAttempt(runId, { stage, stepId });
      const attemptId = context.attemptId;
      let timer = null;
      if (heartbeatMs > 0) timer = setInterval(() => { controller.heartbeat(attemptId).catch(() => {}); }, heartbeatMs);

      try {
        const session = await adapter.checkSession(context);
        if (session?.ok === false) {
          throw Object.assign(new Error(session.reason ?? 'session check failed'), { failureClass: session.failureClass ?? 'HUMAN_REQUIRED' });
        }
        await adapter.prepare(input, context);
        const started = await adapter.start(input, context);
        const observation = await adapter.observe({ attemptId, context, started });

        // 身份校验是硬不变量，与 manifest 声明无关，永远先跑。
        const identity = await runValidators([{ name: 'source_identity', fn: () => validateIdentity(context, observation) }]);
        if (!identity.ok) {
          throw Object.assign(new Error(`identity validation failed: ${identity.codes.join(',')}`), { failureClass: 'EVIDENCE_INVALID' });
        }

        const artifact = await adapter.collectArtifact({ attemptId, context, observation });
        let evidenceManifest = null;
        if (evidenceStore && artifact?.artifactId) {
          evidenceManifest = await evidenceStore.writeManifest({
            runId, attemptId,
            artifactId: artifact.artifactId,
            artifactKind: artifact.artifactKind ?? 'unknown',
            filePath: artifact.path ?? null,
            bytes: artifact.bytes ?? null,
            range: artifact.range ?? null,
            rowCount: artifact.rowCount ?? null,
            extra: { ...manifestMeta, capability: manifest?.name ?? null, capabilityVersion: manifest?.version ?? null },
          });
        }

        const validation = await assembleCollectValidation({ manifest, adapter, context, artifact, contract, observation, evidenceManifest });

        if (!validation.ok) {
          await adapter.release({ attemptId, context }, 'EVIDENCE_INVALID');
          await controller.failAttempt(runId, { attemptId, failureClass: 'EVIDENCE_INVALID', detail: validation.codes.join(',') });
          return { ok: false, attemptId, failureClass: 'EVIDENCE_INVALID', validation };
        }

        await adapter.release({ attemptId, context }, 'SUCCESS');
        const updated = await controller.completeAttempt(runId, {
          attemptId,
          artifactRefs: evidenceManifest ? [{ artifactId: evidenceManifest.artifactId, kind: evidenceManifest.artifactKind, sha256: evidenceManifest.sha256, path: evidenceManifest.path }] : [],
          evidenceRefs: evidenceManifest ? [{ evidenceId: evidenceManifest.artifactId, digest: `sha256:${evidenceManifest.sha256}` }] : [],
          nextAction: 'COMMIT',
        });
        return { ok: true, attemptId, manifest: evidenceManifest, validation, context: updated };
      } catch (error) {
        const failureClass = failureClassOf(error);
        try { await adapter.release({ attemptId, context }, failureClass); } catch { /* release 失败不影响主失败路径 */ }
        await controller.failAttempt(runId, { attemptId, failureClass, detail: String(error?.message ?? error) });
        return { ok: false, attemptId, failureClass, error: String(error?.message ?? error) };
      } finally {
        if (timer) clearInterval(timer);
      }
    },
  };
}

// 采集期验证装配：
//  - 有 manifest：按 manifest 声明的 COLLECT 阶段验证器执行（manifest 是唯一事实来源）；
//  - 无 manifest（兼容旧入口）：退回默认最小集合 identity/scope/structure/completeness/digest；
//  - adapter.validate 是能力自检，两种情况都作为最后一道。
async function assembleCollectValidation({ manifest, adapter, context, artifact, contract, observation, evidenceManifest }) {
  const adapterCheck = await runValidators([{ name: 'adapter', fn: () => adapter.validate(artifact, context) }]);

  let declared = { ok: true, results: [], failures: [], codes: [] };
  if (manifest) {
    declared = await runManifestValidation(manifest, { context, artifact, contract, observation, evidenceManifest }, { stage: VALIDATION_STAGE.COLLECT });
  } else {
    const scope = context.verifiedCursor ? validateScope(context, { range: artifact?.range }) : { ok: true };
    declared = await runValidators([
      { name: 'scope_match', fn: () => scope },
      { name: 'structure', fn: () => validateStructure(artifact, contract) },
      { name: 'completeness', fn: () => validateCompleteness(artifact, contract.expectedRange ?? {}) },
      { name: 'digest', fn: () => validateDigest({ sha256: artifact?.sha256 ?? evidenceManifest?.sha256 }, evidenceManifest ?? {}) },
    ]);
  }

  return {
    ok: declared.ok && adapterCheck.ok,
    results: [...declared.results, ...adapterCheck.results],
    failures: [...declared.failures, ...adapterCheck.failures],
    codes: [...new Set([...declared.codes, ...adapterCheck.codes])],
    source: manifest ? `manifest:${manifest.name}@${manifest.version}` : 'default-set',
  };
}

// 按能力 ID 装配 Worker：Registry 解析版本与前置条件，Loader 装载实现，
// manifest 决定验证器集合，副作用闸门由 Registry 提供。
// 这是 Controller「按能力 ID 调用」的接线点；旧 CLI 入口不受影响。
export async function createCapabilityWorker({
  registry,
  loader,
  controller,
  evidenceStore = null,
  capabilityId,
  version = '*',
  contract = {},
  heartbeatMs = 0,
  preconditions = [],
} = {}) {
  if (!registry || typeof registry.require !== 'function') {
    throw Object.assign(new Error('registry with require() is required'), { code: 'REGISTRY_REQUIRED' });
  }
  if (!loader || typeof loader.loadAdapter !== 'function') {
    throw Object.assign(new Error('loader with loadAdapter() is required'), { code: 'LOADER_REQUIRED' });
  }
  const entry = registry.require(capabilityId, { version, preconditions });
  const loaded = await loader.loadAdapter(capabilityId, { version });
  const adapter = loaded.adapter;

  const worker = createDeterministicWorker({ adapter, controller, evidenceStore, contract, heartbeatMs, manifest: entry.manifest });

  return {
    worker,
    adapter,
    manifest: entry.manifest,
    manifestDigest: entry.digest,
    sourcePath: loaded.sourcePath,
    // 外部副作用必须先在该能力 manifest 里声明，才能在提交路径上落地。
    assertEffect: (effectClass) => registry.assertSideEffectDeclared(capabilityId, effectClass, { version }),
    assertPermission: (permission) => registry.assertPermissionDeclared(capabilityId, permission, { version }),
  };
}
