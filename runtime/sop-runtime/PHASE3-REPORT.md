# sop-runtime 阶段 3 报告：Skill Manifest / Registry / Loader

日期：2026-09-14
范围：实施计划「阶段 3：Skill Manifest、Registry 和 Loader」（优先级 P0）
状态：代码已实现，65 项单测全绿；真实磁盘 Registry 校验通过；**未改动任何业务 Skill 逻辑、未触碰外部系统**
报告位置：runtime/sop-runtime/PHASE3-REPORT.md（不写入 docs/architecture/，那里只存架构决策与契约）

## 1. 新增文件

| 文件 | 职责 |
| --- | --- |
| runtime/sop-runtime/semver.mjs | 确定性 semver 子集：parse / compare / satisfies / maxSatisfying，支持 ^ ~ 精确 >= 区间并用与 `||` |
| runtime/sop-runtime/skill-manifest.mjs | manifest 契约（skill-manifest-v1）、字段与枚举校验、归一化、稳定序列化 |
| runtime/sop-runtime/skill-registry.mjs | Registry：静态校验、依赖解析、环检测、版本兼容、筛选、索引、副作用/权限闸门 |
| runtime/sop-runtime/skill-discovery.mjs | 从 `skills/*` 发现 manifest.json 与 `*.manifest.json`（manifest.mjs 需显式开启） |
| runtime/sop-runtime/skill-loader.mjs | Loader：只装载已注册能力，路径收敛在技能目录内，校验实现摘要与自报身份 |
| runtime/sop-runtime/build-skill-registry.mjs | 验收命令 `--check` / `--write` / `--json`，退出码 0/1/2 |
| runtime/sop-runtime/skill-registry.index.json | Registry 索引产物（含每个实现的 sha256 漂移基线） |
| runtime/sop-runtime/semver.test.mjs | 6 项 |
| runtime/sop-runtime/skill-manifest.test.mjs | 11 项 |
| runtime/sop-runtime/skill-registry.test.mjs | 12 项 |
| runtime/sop-runtime/skill-loader.test.mjs | 9 项 |

修改文件：

- runtime/sop-runtime/policy.mjs：把 `SIDE_EFFECT_RISK` 改为导出，作为副作用类的单一事实来源（manifest 的 sideEffects 必须取自它的 key，防止两处枚举漂移）。
- runtime/sop-runtime/index.mjs：出口补 semver / manifest / registry / discovery / loader。

新增 manifest（业务 Skill 目录，纯声明，不改代码）：

| Skill 目录 | manifest | 能力 ID |
| --- | --- | --- |
| skills/xws-export-market-analysis | manifest.json / adapter.xws.manifest.json | xws.market-analysis.collect / adapter.xws |
| skills/xws-to-feishu-base | manifest.json / adapter.feishu.manifest.json | xws.feishu.import / adapter.feishu |
| skills/sycm-export-search-rank | manifest.json | sycm.search-rank.export |
| skills/sycm-to-feishu-base | manifest.json | sycm.feishu.weekly |
| skills/xws-faq-raw-collection | manifest.json | xws.faq.raw-collect |
| skills/huitun-to-feishu-keyword-heat | manifest.json | huitun.keyword-heat.collect |

未登记的三个技能及原因（不伪造 manifest）：

- skills/xws-question-library-collection：SKILL.md 自述为 FAQ 原文采集的兼容入口，不是独立能力，登记为 xws.faq.raw-collect 的兼容别名即可。
- skills/xws-sku-collection、skills/xws-faq-operator：目录内没有 `.mjs` 实现（实现在 runtime/），按本项目约束「Loader 不能装载技能目录之外的任意脚本」，须先迁移为 Adapter/Workflow 契约再登记。

## 2. 契约要点

manifest 最小字段（Spec 8.1）：name / version / kind / description / entry / inputs / outputs / preconditions / permissions / sideEffects / dependencies / validation / recovery，另有可选 implementationDigest、owner、tags。

执行前必须失败的校验（均已单测覆盖）：

- name 必须是点分小写段（如 xws.market-analysis.collect）；version 必须 semver；kind 必须是 capability/adapter/validator/workflow。
- entry 必须是技能目录内的相对 `.mjs`：拒绝绝对路径、拒绝 `../` 逃逸、拒绝非 `.mjs` 实现。
- 权限：未知权限拒绝；`credentials.read` / `shell.arbitrary` / `cursor.advance` / `db.write.unbounded` 一律拒绝（对应 Spec 8.2 的 bounded read 边界）。
- 副作用：未知副作用拒绝；**声明外部副作用必须同时声明对应权限**（feishu_write→feishu.api、postgres_write→postgres.write、paid_provider_call→provider.call、external_publish→network.external）；**声明写权限必须声明对应副作用**（防止偷偷写外部系统）。
- 外部副作用（feishu_write/postgres_write/external_publish/paid_provider_call）必须 `recovery.supported=true` 且给出具体 `resumeFrom`，否则拒绝——不可恢复的外部写入不允许登记。
- 依赖串格式 `id@range`，range 用本地 semver 子集判定。

Registry 跨 manifest 校验：

- 同名同版本重复登记 → DUPLICATE_MANIFEST。
- 依赖未登记且不在 externalAllowlist → DEPENDENCY_MISSING。
- 依赖已登记但无版本满足区间 → DEPENDENCY_VERSION_INCOMPATIBLE。
- 依赖成环 → DEPENDENCY_CYCLE（三色 DFS，返回环路径）。
- 依赖指向 capability（而非 adapter/validator）→ 告警 DEPENDENCY_NOT_ADAPTER。

Loader 约束：

- 未注册 → LOADER_NOT_REGISTERED；无版本满足 → LOADER_VERSION_UNRESOLVED；入口缺失 → LOADER_FILE_MISSING。
- 解析后的绝对路径必须落在该技能目录内 → 否则 LOADER_PATH_ESCAPE（该守卫独立于 Registry 校验，单独单测）。
- 声明了 implementationDigest 时比对实际文件 sha256 → 不一致即 LOADER_DIGEST_MISMATCH。
- 实现自报 `capabilityId` / `manifestVersion` 与 manifest 不一致 → LOADER_MANIFEST_IMPLEMENTATION_MISMATCH。
- `loadAdapter()` 额外校验 Adapter 契约（checkSession/prepare/start/observe/collectArtifact/validate/release）→ 否则 LOADER_ADAPTER_CONTRACT。
- Registry 提供运行时闸门 `assertSideEffectDeclared` / `assertPermissionDeclared`，未声明即拒绝。

## 3. 验收命令与结果

```
node runtime/sop-runtime/build-skill-registry.mjs --check --write
```

输出：发现 manifest 8 个，注册条目 8 个（能力 6，适配器 2），告警 5 项（均为 `adapter.browser` 显式外部依赖：共享 web-access CDP 代理不在仓库内），`registryDigest=sha256:dd564ed1…873a`，索引写入 runtime/sop-runtime/skill-registry.index.json。

反例验证（临时目录，不污染仓库）：放进一个 name/version 非法、entry 逃逸、权限被禁、外部副作用不可恢复的 manifest →

```
registry.ok= false
error codes= NAME_INVALID, VERSION_INVALID, ENTRY_ESCAPE, PERMISSION_FORBIDDEN, PERMISSION_MISSING, RECOVERY_NOT_RESUMABLE
```

即「错误 manifest 在执行前失败」成立。

单测：

```
node --test runtime/sop-runtime/*.test.mjs        # pass 65  fail 0
```

（阶段 0 原有 27 项 + 本阶段新增 38 项；原有测试无回归。）

实现过程中修掉的自身缺陷：

1. `finalize()` 原本清空错误再重建，会把「非法 manifest」的 manifest 阶段错误静默丢掉（非法项不进 byName，重建时无从复现）→ 改为登记全部原始输入、finalize 从登记项幂等重建。
2. `finalize()` 内部经公开 API（resolveVersion/versionsOf）读取时触发 `ensure()` 重入 finalize，造成无限递归栈溢出 → 增加 `finalizing` 重入守卫 + 进入即清 dirty。
3. semver 单测最初把 `1.2` 误当作 `>=1.2.0 <2.0.0`（实为 `>=1.2.0 <1.3.0`）→ 修正测试而非放松实现。

## 4. 与架构验收标准的对照

| 验收项（实施计划阶段 3） | 状态 |
| --- | --- |
| 新 Skill 可只新增目录、manifest、实现和测试，不改核心 Runtime | 成立：Registry 按目录发现 manifest，核心模块不内联任何技能 ID；新增技能只需目录 + manifest（+ 实现 .mjs） |
| Registry 能按输入/前置条件筛选能力 | 成立：`list({ kind, hasPreconditions, acceptsInputs, declaresSideEffects, permissions, namePrefix })`，已单测 |
| 错误 manifest 在执行前失败 | 成立：校验失败即 registry.ok=false、CLI 退出码 1，且不进入 Loader |

风险项（实施计划已列）现状：frontmatter/版本漂移 → 索引记录每个 manifest 摘要与实现 sha256 作为漂移基线；动态路径逃逸 → Loader 路径收敛 + entry 静态校验双重拦截；Skill 自行持有跨流程状态 → 尚未收敛（属阶段 4/5，Adapter/Workflow 契约完成后再处理）。

## 5. 未做与阻塞（保持原状）

- 数据库迁移仍**未执行**：004 未 apply、005 仍为草案。阻塞原因未变——角色 `xws_agent` 无 CREATEDB，隔离库验证（语法/重复执行/rollback）无环境可做。本阶段不涉及数据库，未触碰。
- 目标库仍未确认（本机 `127.0.0.1:5432/xws_automation` vs 文档所称 Portretag PostgreSQL）。apply 前必须由用户确认目标环境。
- Controller 尚未改为通过能力 ID 调用（`loadAdapter()` 已就绪，接线属下一批）。
- xws-sku-collection / xws-faq-operator 尚未迁移为 Adapter/Workflow 契约，故未登记 manifest。

## 6. 下一步建议顺序

1. 阶段 4 前半：把 Validator 组合接口与 manifest 的 `validation` 字段对接（Validator 名 → 实际校验函数的注册表），并让 Worker 按 manifest 装配验证器。
2. Controller 接线：`registry.require(capability)` + `loader.loadAdapter()` 替换现有按路径调用的入口，保留旧 CLI 兼容。
3. 迁移 xws-sku-collection / xws-faq-operator 到 Adapter/Workflow 契约后补 manifest。
4. 解除数据库阻塞后执行 004/005 隔离验证与 apply，再用 pg-store 重跑垂直切片与真实跨进程故障注入。
