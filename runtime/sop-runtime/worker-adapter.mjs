// Worker / Adapter：确定性执行契约（Spec 11.1）。平台细节只在 Adapter 内。
// Worker 不拥有运行状态，只按 Controller 指派的 attempt 执行一次；不扫描或关闭未知资源。
import { runValidators, validateIdentity, validateScope, validateStructure, validateCompleteness, validateDigest } from './validator.mjs';

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

        const identity = await runValidators([{ name: 'identity', fn: validateIdentity, args: [context, observation] }]);
        if (!identity.ok) {
          throw Object.assign(new Error(`identity validation failed: ${identity.codes.join(',')}`), { failureClass: 'EVIDENCE_INVALID' });
        }

        const artifact = await adapter.collectArtifact({ attemptId, context, observation });
        let manifest = null;
        if (evidenceStore && artifact?.artifactId) {
          manifest = await evidenceStore.writeManifest({
            runId, attemptId,
            artifactId: artifact.artifactId,
            artifactKind: artifact.artifactKind ?? 'unknown',
            filePath: artifact.path ?? null,
            bytes: artifact.bytes ?? null,
            range: artifact.range ?? null,
            rowCount: artifact.rowCount ?? null,
            extra: manifestMeta,
          });
        }

        const scope = context.verifiedCursor ? validateScope(context, { range: artifact?.range }) : { ok: true };
        const validation = await runValidators([
          { name: 'scope', fn: () => scope },
          { name: 'structure', fn: validateStructure, args: [artifact, contract] },
          { name: 'completeness', fn: validateCompleteness, args: [artifact, contract.expectedRange ?? {}] },
          { name: 'digest', fn: validateDigest, args: [{ sha256: artifact?.sha256 ?? manifest?.sha256 }, manifest ?? {}] },
          { name: 'adapter', fn: adapter.validate, args: [artifact, context] },
        ]);

        if (!validation.ok) {
          await adapter.release({ attemptId, context }, 'EVIDENCE_INVALID');
          await controller.failAttempt(runId, { attemptId, failureClass: 'EVIDENCE_INVALID', detail: validation.codes.join(',') });
          return { ok: false, attemptId, failureClass: 'EVIDENCE_INVALID', validation };
        }

        await adapter.release({ attemptId, context }, 'SUCCESS');
        const updated = await controller.completeAttempt(runId, {
          attemptId,
          artifactRefs: manifest ? [{ artifactId: manifest.artifactId, kind: manifest.artifactKind, sha256: manifest.sha256, path: manifest.path }] : [],
          evidenceRefs: manifest ? [{ evidenceId: manifest.artifactId, digest: `sha256:${manifest.sha256}` }] : [],
          nextAction: 'COMMIT',
        });
        return { ok: true, attemptId, manifest, validation, context: updated };
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
