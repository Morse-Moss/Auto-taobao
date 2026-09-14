// 运行器 CLI 的公共装配：把「注册表 + 加载器 + store + Controller + 账本 + 证据库」
// 这一组依赖的构造收敛到唯一一处。
//
// 为什么必须收敛（而不是两个 CLI 各写一份）：这套装配里藏着一个**必须两处一致**的默认值——
// store 是内存还是真实 PG。两个入口各维护一份，早晚会出现「一个跑在内存 store 上、另一个跑在
// 权威库上」的静默分叉；后果是恢复语义（游标 / 租约 / 提交账本 / UNKNOWN 对账）在最不该出错的
// 地方悄悄失效，而且**看起来还是绿的**。这与 manifest 是同一类约束：同一份语义由两处维护，
// 就一定会漂移。因此这里把装配抽成工厂，两段式运行器与调度器共用。
//
// 本模块只做装配，不含任何业务判决：不读参数语义、不校验能力、不碰外部系统。
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildRegistryFromDisk } from './build-skill-registry.mjs';
import { createLoader } from './skill-loader.mjs';
import { createMemoryStore } from './stores/memory-store.mjs';
import { createController } from './workflow-controller.mjs';
import { createSideEffectLedger } from './side-effect-ledger.mjs';
import { createEvidenceStore } from './evidence-store.mjs';

// 默认 runId 生成器与两段式运行器 CLI 原先内联的一致（保持行为不变是这次抽取的硬要求）。
const defaultIdFactory = () => `run-${Date.now().toString(36)}`;

export async function createRuntimeContext({
  databaseUrl = null,
  workDir = null,
  workDirPrefix = 'two-stage',
  idFactory = defaultIdFactory,
} = {}) {
  const { registry, result } = await buildRegistryFromDisk();
  if (!result.ok) throw new Error(`registry invalid: ${JSON.stringify(result.errors)}`);
  const loader = createLoader({ registry });

  // 默认内存 store（dry-run 不需要持久化）；--database-url 时用真实 PG，
  // 这样「恢复/游标」跑在权威库上，而不是只在内存里好看。
  let store;
  if (databaseUrl) {
    const { createPgStore } = await import('./stores/pg-store.mjs');
    store = await createPgStore(databaseUrl);
  } else {
    store = createMemoryStore();
  }

  const controller = createController({ store, idFactory });
  const ledger = createSideEffectLedger({ store });
  const dir = resolve(workDir ?? `runtime/sop-runtime/${workDirPrefix}-${Date.now().toString(36)}`);
  await mkdir(dir, { recursive: true });
  const evidenceStore = createEvidenceStore({ root: resolve(dir, 'evidence') });

  return { registry, loader, store, controller, ledger, evidenceStore, workDir: dir };
}
