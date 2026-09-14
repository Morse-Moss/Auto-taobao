// 发布 / 回读路径（Spec 6.3、11.1，ADR-004）。
//
// 核心约束：外部写入不允许在「本地调用返回成功」后就算完成。
// 必须依次满足——
//   1. 副作用已在能力 manifest 里声明（Registry 闸门）；
//   2. 提交前登记稳定幂等键（Side Effect Ledger）；
//   3. 提交后由外部系统真实回读，得到收据；
//   4. 收据通过 manifest 声明的 PUBLICATION 阶段验证器；
// 四条全过，才允许把 publicationStatus 结算成 VERIFIED，游标才可能推进。
//
// 与采集期的区别：采集期验证器跑在 Worker 里（拿到工件即可判定）；
// 发布期验证器必须等到提交之后才有收据，所以单独走这里，不在 Worker 里提前跑。
import { runManifestValidation, VALIDATION_STAGE, validationStageOf } from './validation-registry.mjs';
import { EXTERNAL_WRITE_EFFECTS, classifyRisk, requiresApproval } from './policy.mjs';

// 结算结论：VERIFIED 已验收 / UNKNOWN 无法判定（只对账） / REJECTED 确定未发生（可重试）
export const PUBLICATION_VERDICT = Object.freeze(['VERIFIED', 'UNKNOWN', 'REJECTED']);

// 外部写副作用类：**不是**这里的第二份定义，而是 policy 的同一份清单（原先这里是拷贝，已改为同源）。
// 名字保留 `EXTERNAL_WRITE_EFFECTS` 是因为发布段调用方用它，并且 `createCapabilityPublisher`
// 允许调用方显式覆盖（`externalEffects`）——覆盖是刻意的逃生门，默认值必须与 policy 一致。
export { EXTERNAL_WRITE_EFFECTS };

function publisherError(message, code, details = {}) {
  return Object.assign(new Error(`${code}: ${message}`), { name: 'PublicationError', code, details });
}

// 该 manifest 声明的发布期验证器（顺序保持声明顺序）。
export function publicationValidatorsOf(manifest) {
  return (manifest?.validation ?? []).filter((name) => validationStageOf(name) === VALIDATION_STAGE.PUBLICATION);
}

export function declaresPublication(manifest) {
  return publicationValidatorsOf(manifest).length > 0;
}

export function writesExternally(manifest, externalEffects = EXTERNAL_WRITE_EFFECTS) {
  return (manifest?.sideEffects ?? []).some((effect) => externalEffects.includes(effect));
}

export function createCapabilityPublisher({
  registry,
  controller,
  ledger,
  capabilityId,
  version = '*',
  contract = {},
  preconditions = [],
  externalEffects = EXTERNAL_WRITE_EFFECTS,
} = {}) {
  if (!registry || typeof registry.require !== 'function') {
    throw publisherError('registry with require() is required', 'REGISTRY_REQUIRED');
  }
  if (!controller || typeof controller.settlePublication !== 'function') {
    throw publisherError('controller with settlePublication() is required', 'CONTROLLER_REQUIRED');
  }
  if (!ledger || typeof ledger.commit !== 'function' || typeof ledger.prepare !== 'function') {
    throw publisherError('side effect ledger with prepare()/commit() is required', 'LEDGER_REQUIRED');
  }

  const entry = registry.require(capabilityId, { version, preconditions });
  const manifest = entry.manifest;
  const declaredValidators = publicationValidatorsOf(manifest);
  const required = writesExternally(manifest, externalEffects);

  // 风险等级取自 manifest 声明的副作用，而不是调用方传进来的 spec——
  // 否则「按只读副作用准入、却真的去写外部」就能绕过人工闸门。
  const riskClass = classifyRisk({ sideEffects: [...(manifest.sideEffects ?? [])] });
  const approvalRequired = requiresApproval(riskClass);

  // 写外部却在 manifest 里没有发布期验证器 → 提交路径不允许启动（fail-closed）。
  // 与 skill-manifest 的 PUBLICATION_VALIDATOR_MISSING 是同一义务的运行时兜底：
  // manifest 校验发生在注册期，这里保证「即使绕过了注册期校验也不会静默放行」。
  function assertPublicationDeclared() {
    if (required && !declaredValidators.length) {
      throw publisherError(
        `${manifest.name}@${manifest.version} writes externally but declares no PUBLICATION-stage validator`,
        'PUBLICATION_VALIDATOR_MISSING',
        { sideEffects: [...manifest.sideEffects], declared: [...(manifest.validation ?? [])] },
      );
    }
    return true;
  }

  // 人工闸门：写外部的高风险能力必须处于 APPROVED 才能提交，
  // WAITING_HUMAN 一律拒绝（提交前的最后一道，不依赖调度层是否守规矩）。
  async function assertHumanGateApproved(runId) {
    if (!approvalRequired) return true;
    const context = await controller.getContext(runId);
    if (context?.humanGateStatus !== 'APPROVED') {
      throw publisherError(
        `${manifest.name}@${manifest.version} risk ${riskClass} requires human approval before any external write; humanGateStatus=${context?.humanGateStatus}`,
        'HUMAN_APPROVAL_REQUIRED',
        { riskClass, humanGateStatus: context?.humanGateStatus ?? null },
      );
    }
    return true;
  }

  return {
    manifest,
    manifestDigest: entry.digest ?? null,
    publicationValidators: declaredValidators,
    writesExternally: required,
    riskClass,
    approvalRequired,
    assertPublicationDeclared,
    assertHumanGateApproved,

    async publish({
      runId,
      target = null,
      businessKey,
      effectClass = null,
      attemptId = null,
      artifactDigest = null,
      handler,
      readBack,
      expected = {},
      contract: callContract = null,
    }) {
      if (!businessKey) throw publisherError('businessKey is required for idempotent publish', 'BUSINESS_KEY_REQUIRED');
      if (effectClass) registry.assertSideEffectDeclared(capabilityId, effectClass, { version });

      // 不写外部的能力没有发布义务：不触碰发布轴，保持 NOT_REQUESTED。
      if (!required) {
        return { verdict: 'NOT_REQUESTED', capability: manifest.name, reason: 'capability declares no external write effect' };
      }
      assertPublicationDeclared();
      await assertHumanGateApproved(runId);
      if (typeof handler !== 'function') throw publisherError('handler is required', 'HANDLER_REQUIRED');
      if (typeof readBack !== 'function') throw publisherError('readBack is required to verify publication', 'READBACK_REQUIRED');

      const effectiveContract = { ...contract, ...(callContract ?? {}) };
      const resolvedTarget = target ?? capabilityId;

      await controller.markPublicationReady(runId, { commitKey: null });
      const prepared = await ledger.prepare({ runId, attemptId, target: resolvedTarget, businessKey, artifactDigest });
      const commitKey = prepared.commitKey;
      const committed = await ledger.commit({ commitKey, handler, businessKey });

      if (committed.status === 'FAILED') {
        const context = await controller.settlePublication(runId, {
          verdict: 'REJECTED',
          commitKey,
          failureClass: committed.failureClass ?? 'BUG',
          detail: committed.error ?? 'commit rejected deterministically',
        });
        return { verdict: 'REJECTED', commitKey, error: committed.error ?? null, context };
      }

      if (committed.status === 'UNKNOWN') {
        const context = await controller.settlePublication(runId, {
          verdict: 'UNKNOWN',
          commitKey,
          detail: committed.error ?? 'commit result unknown, must reconcile before retry',
        });
        return { verdict: 'UNKNOWN', commitKey, requiresReconcile: true, context };
      }

      await controller.markPublicationCommitted(runId, { commitKey });

      const verified = await ledger.verify({ commitKey, readBack, expected, businessKey });
      let receipt = verified.receipt ?? null;
      // 已 VERIFIED 的幂等短路不返回收据；补齐一次回读以便复验 manifest 声明（失败不升级为错误）。
      if (!receipt && verified.status === 'VERIFIED') {
        try {
          receipt = await readBack({ businessKey, commitKey, target: resolvedTarget });
        } catch { receipt = null; }
      }

      // 发布期验证器只在拿到收据后执行；无声明时不伪造通过（runManifestValidation 会标 skipped）。
      const declared = await runManifestValidation(
        manifest,
        { receipt, readbackReceipt: receipt, contract: effectiveContract, commitKey },
        { stage: VALIDATION_STAGE.PUBLICATION },
      );

      if (verified.status !== 'VERIFIED' || !declared.ok) {
        const detail = verified.status !== 'VERIFIED'
          ? `read-back not verified: ${verified.error ?? 'receipt does not match expected'}`
          : `manifest publication validators failed: ${declared.codes.join(', ')}`;
        const context = await controller.settlePublication(runId, { verdict: 'UNKNOWN', commitKey, detail });
        return { verdict: 'UNKNOWN', commitKey, requiresReconcile: true, receipt, validation: declared, context };
      }

      const context = await controller.settlePublication(runId, {
        verdict: 'VERIFIED',
        commitKey,
        receipt,
        detail: `validators=${declared.results.map((result) => result.name).join(',') || 'none'}`,
      });
      return { verdict: 'VERIFIED', commitKey, receipt, validation: declared, context };
    },
  };
}
