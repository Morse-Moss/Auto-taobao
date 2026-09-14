#!/usr/bin/env node
// 两段式迁移收据：把 xws.feishu.import 从「CLI 一把梭」改成
// 「采集 Worker（COLLECT）+ 发布 Publisher（PUBLISH）」。
//
// 用法：
//   # 采集段（真实解析本地 XLSX，不发起任何外部写入；默认模式）
//   node runtime/sop-runtime/run-feishu-import-two-stage.mjs \
//     --xlsx runtime/xws-bathtub-top3-with-images.xlsx \
//     --base-url "https://<host>/base/<appToken>?table=<tableId>" \
//     [--period-start YYYY-MM-DD --period-end YYYY-MM-DD] \
//     [--expected-rows N] [--operator NAME]
//
//   # 发布段（真实写飞书并回读；需要 --commit + --operator，且必须人工明确授权）
//   node ... --commit --env-file E:/小红书/.env.local --operator "<审批人>" ...
//
// 默认模式只跑采集段，因此不会触达人工闸门（准入不声明外部写入副作用）；
// --commit 模式按 manifest 声明的高风险副作用准入，必须带 --operator 才会记录审批。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildRegistryFromDisk } from './build-skill-registry.mjs';
import { createLoader } from './skill-loader.mjs';
import { createMemoryStore } from './stores/memory-store.mjs';
import { admitTask } from './task-admission.mjs';
import { createController } from './workflow-controller.mjs';
import { createSideEffectLedger } from './side-effect-ledger.mjs';
import { createEvidenceStore } from './evidence-store.mjs';
import { createCapabilityWorker } from './worker-adapter.mjs';
import { createCapabilityPublisher } from './publication.mjs';
import { summarize } from './context-schema.mjs';
// 源字段合同来自能力自己的 import-core，避免这里再抄一份 16 字段清单。
import { XWS_HEADERS } from '../../skills/xws-to-feishu-base/scripts/import-core.mjs';

const CAPABILITY_ID = 'xws.feishu.import';

function parseArgs(argv) {
  const args = { commit: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--commit') { args.commit = true; continue; }
    if (token === '--json') { args.json = true; continue; }
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (token.startsWith('--')) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      args[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.help) {
    if (!args.xlsx) throw new Error('--xlsx is required');
    if (!args.baseUrl) throw new Error('--base-url is required');
    if (args.commit && !args.envFile) throw new Error('--env-file is required with --commit');
    if (args.commit && !args.operator) throw new Error('--operator is required with --commit (records who approved the human gate)');
    if (Boolean(args.periodStart) !== Boolean(args.periodEnd)) throw new Error('--period-start and --period-end must be given together');
  }
  return args;
}

function parseEnvFile(file) {
  const values = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('usage: run-feishu-import-two-stage.mjs --xlsx <path> --base-url <url> [--commit --env-file <p> --operator <name>] [--period-start D --period-end D] [--expected-rows N] [--json]\n');
    return 0;
  }

  const xlsxPath = resolve(args.xlsx);
  if (!existsSync(xlsxPath)) throw new Error(`XLSX file not found: ${xlsxPath}`);
  const workDir = resolve(args.workDir ?? `runtime/sop-runtime/two-stage-${Date.now().toString(36)}`);
  const outputDir = resolve(workDir, 'images');
  await mkdir(outputDir, { recursive: true });

  const { registry, result } = await buildRegistryFromDisk();
  if (!result.ok) throw new Error(`registry invalid: ${JSON.stringify(result.errors)}`);
  const entry = registry.require(CAPABILITY_ID);
  const manifest = entry.manifest;

  const loader = createLoader({ registry });
  const store = createMemoryStore();
  const controller = createController({ store, idFactory: () => `run-${Date.now().toString(36)}` });
  const ledger = createSideEffectLedger({ store });
  const evidenceStore = createEvidenceStore({ root: resolve(workDir, 'evidence') });

  const period = args.periodStart ? { startDate: args.periodStart, endDate: args.periodEnd } : null;
  const expectedRows = args.expectedRows === undefined ? null : Number(args.expectedRows);

  const admission = await admitTask({
    store,
    spec: {
      taskId: `feishu-import-${manifest.version}`,
      workflow: 'competitor.weekly.import',
      capability: CAPABILITY_ID,
      identity: {
        tenantId: 'sycm', storeId: 'bathtub-flagship', platform: 'xws',
        accountId: 'operator', browserProfileId: 'local', contractVersion: 'xws-16f-v1',
      },
      target: args.baseUrl,
      targetEnd: expectedRows ?? 0,
      // 默认模式只请求采集段（本地解析），不请求外部写入 → 不开闸。
      // --commit 按 manifest 声明的副作用准入 → 高风险 → 开闸，需 --operator 记录审批。
      sideEffects: args.commit ? [...manifest.sideEffects] : [],
      write: args.commit,
    },
    registeredCapabilities: registry.names(),
  });

  if (!admission.admitted) {
    process.stdout.write(`${JSON.stringify({ admitted: false, reasons: admission.rejectionReasons, failureClass: admission.failureClass }, null, 2)}\n`);
    return 3;
  }
  const runId = admission.runId;

  let gate = { status: admission.context.humanGateStatus, decision: admission.policy.decision, riskClass: admission.policy.riskClass };
  if (gate.status === 'WAITING_HUMAN') {
    await controller.approve(runId, { operator: args.operator ?? 'unapproved', note: 'two-stage runner' });
    gate = { ...gate, status: 'APPROVED', operator: args.operator };
  }

  // ── 采集段：Worker + 采集期验证器（manifest 决定验证器集合） ──
  const capability = await createCapabilityWorker({
    registry, loader, controller, evidenceStore,
    capabilityId: CAPABILITY_ID,
    // structure 验证器按 requiredFields 检查工件键存在；工件把 16 个源列做成了每列非空计数。
    // expectedRows 未由操作者声明时不传该键（而不是传 null），语义更明确。
    contract: { requiredFields: [...XWS_HEADERS], ...(expectedRows === null ? {} : { expectedRows }) },
  });
  const collect = await capability.worker.runOnce({
    runId,
    stage: 'COLLECT',
    stepId: 'parse-xlsx',
    input: { xlsxPath, outputDir, baseUrl: args.baseUrl },
  });

  if (!collect.ok) {
    const receipt = {
      ok: false, stage: 'COLLECT', runId, capability: CAPABILITY_ID,
      failureClass: collect.failureClass,
      validation: collect.validation ?? null,
      error: collect.error ?? null,
      context: summarize(await controller.getContext(runId)),
    };
    writeFileSync(resolve(workDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return 2;
  }

  const afterCollect = await controller.markEvidenceValidated(runId);
  const evidence = collect.manifest;

  // ── 发布段 ──
  let publishResult = null;
  let cursor = null;
  if (!args.commit) {
    publishResult = {
      verdict: 'NOT_ATTEMPTED',
      reason: '采集段完成；发布段需要 --commit（真实写飞书）与人工授权，本次未执行。',
      note: 'publicationStatus 保持 NOT_REQUESTED，游标不推进——收据只证明采集段，不冒充发布已验收。',
    };
  } else {
    const env = parseEnvFile(resolve(args.envFile));
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('env file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
    const { FeishuClient } = await import('../../skills/xws-to-feishu-base/scripts/feishu-client.mjs');
    const { parseBaseUrl } = await import('../../skills/xws-to-feishu-base/scripts/import-core.mjs');
    const { createFeishuImportPublisher } = await import('../../skills/xws-to-feishu-base/scripts/adapter.feishu-import.mjs');

    const client = new FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, ...parseBaseUrl(args.baseUrl) });
    const artifactBytes = readFileSync(evidence.path);
    const hooks = createFeishuImportPublisher({ client, artifactBytes, period });
    const publisher = createCapabilityPublisher({
      registry, controller, ledger, capabilityId: CAPABILITY_ID,
      contract: {
        publication: { rows: expectedRows ?? undefined },
        readback: { rows: expectedRows ?? undefined },
      },
    });
    publishResult = await publisher.publish({
      runId,
      target: args.baseUrl,
      businessKey: `${args.baseUrl}|${args.periodStart ?? 'no-period'}`,
      effectClass: 'feishu_write',
      handler: hooks.handler,
      readBack: hooks.readBack,
      expected: { rows: expectedRows ?? undefined },
    });
    if (publishResult.verdict === 'VERIFIED') {
      cursor = await controller.advanceCursor(runId, {
        end: expectedRows ?? evidence.rowCount,
        commitRefs: [{ commitKey: publishResult.commitKey, capability: CAPABILITY_ID }],
      });
    }
  }

  const receipt = {
    ok: collect.ok && (!args.commit || publishResult?.verdict === 'VERIFIED'),
    runId,
    capability: `${manifest.name}@${manifest.version}`,
    entry: manifest.entry,
    mode: args.commit ? 'commit' : 'dry-run',
    gate,
    collect: {
      stage: 'COLLECT',
      artifactPath: evidence.path,
      sha256: evidence.sha256,
      rowCount: evidence.rowCount,
      validationSource: collect.validation.source,
      validators: collect.validation.results.map((r) => `${r.name}:${r.ok === true ? 'ok' : r.code}`),
      adapterSelfCheck: collect.validation.results.some((r) => r.name === 'adapter'),
    },
    publish: publishResult,
    publicationStatus: (await controller.getContext(runId)).publicationStatus,
    cursorAdvanced: Boolean(cursor),
    verifiedCursor: cursor?.verifiedCursor ?? (await controller.getContext(runId)).verifiedCursor,
    contextAfterCollect: summarize(afterCollect),
    workDir,
  };
  writeFileSync(resolve(workDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt.ok ? 0 : 2;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exit(1);
    });
}
