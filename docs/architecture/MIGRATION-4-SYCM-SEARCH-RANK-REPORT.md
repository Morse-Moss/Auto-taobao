# 迁移 4：SYCM 搜索排行（只读采集接入两段式，零发布义务）

日期：2026-09-14
对应实施计划：第 5 节「首批流程迁移顺序」第 4 项（SYCM 搜索排行：周期/字段/连续排名验证和本地工件）
本报告是深报告，摘要见 `docs/architecture/PHASE-ARCHIVE.md` 第 7.5 节。

## 1. 这一轮要解决的到底是什么

`skills/sycm-export-search-rank` 的业务实现（670 行 CLI + 3 个同目录模块）本身是成熟的：七天窗口校验、分页 50 行约束、排名 1..N 连续且无重、搜索词不重复、指标非空、CSV/XLSX 配对复验，全都有测试。

但它**不在运行时里**。具体地说：

- `manifest.json` 的 `entry` 指向 `scripts/export-search-rank.mjs`，那是个 CLI——进程入口，不是适配器契约模块。Controller 按能力 ID 调用时，Loader 拿不到 `adapter`，`createCapabilityWorker` 会直接抛 `ADAPTER_CONTRACT_VIOLATION`；
- CLI 的成功路径只做一件事：`console.log(JSON.stringify({...}))`。**没有任何可复验的证据工件**，也没有结构化返回值。想复用只能 `spawn` 子进程再解析 stdout，代价是丢掉失败分类（`HUMAN_REQUIRED` 等中文人工提示会被运行时的英文关键词分类器猜成 `BUG`）、丢掉 attempt 绑定、丢掉恢复所需的上下文。

要改的就是这件事：让这条只读采集成为**可被运行时驱动、可自证来源与范围**的一条能力，并且**不虚构发布义务**。

## 2. 交付物

| 文件 | 作用 |
| --- | --- |
| `skills/sycm-export-search-rank/scripts/adapter.search-rank.mjs` | 新：能力 `sycm.search-rank.export@1.1.0` 的实现（7 方法 Worker 契约 + 能力自检）。只读，**刻意不导出 `createPublisher`** |
| `skills/sycm-export-search-rank/scripts/adapter.search-rank.test.mjs` | 新：16 项：契约与 manifest 对齐、真 registry 驱动的端到端采集、工件复验（摘要/产物/表面一致）、失败分类、参数校验、**与 runtime 验证器的交叉验证** |
| `skills/sycm-export-search-rank/scripts/export-search-rank.mjs` | 改：抽出 `runSearchRankExport(args, {log})` 程序化入口；默认参数抽成 `defaultExportArgs()`、取值校验抽成 `resolveExportArgs()`（CLI 与适配器共用同一份）；补 `isMain` 闸门（此前 `import` 本模块会直接真实导出一次）；所有进度输出改走注入的 `log` |
| `skills/sycm-export-search-rank/manifest.json` | 改：`entry` → `scripts/adapter.search-rank.mjs`，`version` 1.0.0 → 1.1.0，`inputs` 按实际 collectInput 重写 |

`runtime/sop-runtime/` **没有新增任何模块**。这是有意的：通用两段式运行器（迁移 2 的产物）就是为了让「新能力=新目录 + manifest + 实现 + 测试」成立。本能力零外部写，因此连 `two-stage-runner.mjs` 都不需要改一行。

## 3. 关键决策

### D1 只读能力必须走「无发布段」路径，而不是导出一个空 publisher

manifest 的 `sideEffects = [browser_read, local_artifact]` 里没有任何外部写（`EXTERNAL_WRITE_EFFECTS` 不含这两项），因此：

- 采集准入用 `collectSideEffects(manifest)`，不会因为「这条能力将来可能写飞书」而提前触发人工闸门；
- `runTwoStage` 的 `shouldPublish = commit && writesExternally` 恒为 false → `publish.verdict = NOT_ATTEMPTED`、`publicationStatus` 保持 `NOT_REQUESTED`、游标不推进 → 随后 `controller.succeed()` 把运行终结为 `SUCCEEDED`。

反面做法（明确拒绝）：为了让收据"好看"而导出一个 `createPublisher` 返回空 handler。那会把一次读操作变成一条 `COMMITTED/UNKNOWN` 待对账的外部写入，制造出根本不存在的对账工作，并且破坏「`NOT_REQUESTED` = 从未请求过发布」这个语义。

### D2 工件是**证据 manifest 的 JSON 字节**，不是 CSV

单看一个 CSV 说不出「这批数据来自哪个类目页、哪个七天窗口、翻了几页、每页多少行、排名是否连续 1..N」。证据要能自证来源与范围，才谈得上对抗性复核。因此工件是一个 JSON（`evidenceSchemaVersion = sycm-search-rank-evidence-v1`），CSV/XLSX 作为**产物**记在里面（路径 + sha256 + 字节数），仍可被独立复验。

### D3 `range = {start: 1, end: rowCount}` 是对事实的陈述，不是对未来的期望

运行时的 `contiguous_prefix` 验证器要求 `range.start === verifiedCursor.end + 1`。只读采集模式下调用方不声明预期行数（`expectedRows = null`），`verifiedCursor` 保持空 → `cursorEnd = 0` → `range.start` 必须是 1。

这恰好与业务语义一致：搜索排行从第 1 名开始且连续（流程内 `validateRows` 已经硬校验过 1..N 连续、无重）。所以 `1..rowCount` 不是"凑验证器"，而是对已发生事实的陈述。

### D4 刻意**不**声明的验证器与理由（写进 `collectContract().omittedValidators`，并有测试锁住）

| 验证器 | 为什么不声明 |
| --- | --- |
| `artifact_integrity` | 它会在 `rowCount <= 0` 时失败；空排名是否合法只能由流程判定，不该由这个通用验证器代替 |
| `digest` | 与 `validate()` 里对工件字节的摘要复算完全重复，声明它只是同一件事算两遍，不增加任何保证 |
| `completeness` | 导出前不知道总行数（页面有多少排名就有多少），声明一个"预期范围"等于编造 |

这条是背在迁移 3（FAQ）教训上的：**声明了做不到的验证器只会制造假失败**，而漏声明会制造假通过。两者都必须显式写清楚，而不是默认沉默。

### D5 失败分类必须显式映射，不能靠默认分类器猜

运行时 `failureClassOf` 只在 `error.failureClass` 缺失时按**英文**关键词猜（`/login|captcha|风控|risk/i` 等）。而本流程的人工提示是中文的：

```
标签页已登录但不在搜索排行页面，请人工通过市场 > 搜索排行打开目标页
```

默认分类器会把它判成 `BUG`（"去改代码"），而正确结论是 `HUMAN_REQUIRED`（"等人处理"）。同理 `fetch failed`（代理浏览器不可达）会被判成 `BUG`，而它是**可重试的外部故障**。

因此适配器做了两层映射：`toFlowFailure()` 把 `code === 'HUMAN_REQUIRED'` 判为 `HUMAN_REQUIRED`、把连接类错误判为 `TRANSIENT_EXTERNAL`（→ 进入 `RETRY_WAIT` 并按 `retryBudget` 重试）；`SearchRankEvidenceError` 按错误码映射 `EVIDENCE_MISSING/EVIDENCE_INCOMPLETE/PRODUCT_MISSING → EVIDENCE_INVALID`（→ `evidenceStatus = REJECTED` + `nextAction = RECOLLECT`）。两条都有测试。

### D6 CLI 与适配器必须共用同一份默认参数

默认类目（`50002411` / 普通浴缸）、`delayMs=1200`、`maxPages=20`、`period=7d` 原来只写在 `parseArgs()` 里。适配器若自建一份副本，两处会随改动静默漂移——出现「CLI 跑的是普通浴缸、运行时跑的是另一个默认类目」这类只在真实运行中才暴露的分叉。所以默认值抽成 `defaultExportArgs()`，取值校验抽成 `resolveExportArgs()`，`parseArgs` 也走同一条校验。测试直接断言两条路径的默认值一致。

### D7 补 `isMain` 闸门（原文件没有）

原 `export-search-rank.mjs` 顶层直接 `main().catch(...)`。任何 `import` 它的代码都会**顺带真实导出一次生意参谋**。适配器必须 `import` 它（复用同一条业务路径），所以这道闸门不是可选项。已验证：`import('./adapter.search-rank.mjs')` 不再触发任何导出动作。

## 4. 验证

复现命令与结果：

```
node --test skills/sycm-export-search-rank/scripts/adapter.search-rank.test.mjs
  # tests 16 / pass 16 / fail 0

node --test skills/sycm-export-search-rank/scripts/full-flow.test.mjs \
  skills/sycm-export-search-rank/scripts/output-publish.test.mjs \
  skills/sycm-export-search-rank/scripts/source-period-proof.test.mjs
  # tests 26 / pass 26 / fail 0   （与 evidence/test-baseline-20260911.md 的 26/26 基线一致，重构未回归）

node runtime/sop-runtime/build-skill-registry.mjs --check --write
  # 发现 manifest 9 个，注册条目 9 个（能力 7，适配器 2）
  #   sycm.search-rank.export@1.1.0
  # Registry 校验通过，registryDigest=sha256:e74f195b853770e243c3094bda8e0c9f942e6ae00d300ce8a788419d85fe0036

node skills/sycm-export-search-rank/scripts/export-search-rank.mjs --help          # 用法正常
node skills/sycm-export-search-rank/scripts/export-search-rank.mjs --delay-ms 100  # {"ok":false,...,"message":"delayMs must be at least 800"}
node -e "import('./skills/sycm-export-search-rank/scripts/adapter.search-rank.mjs').then(m=>console.log(m.capabilityId))"
  # sycm.search-rank.export（且不触发任何导出）
```

端到端那条测试用的是**真 registry + 真 loader + 真 adapter + 真证据库 + 真 Controller**，只有 store 在内存里、浏览器流程换成写真实文件的夹具。因此它验证的是「这条能力能不能被运行时驱动」，而不是「函数能不能被调用」。断言里包含：

- `evidenceStatus=VALIDATED`、`publicationStatus=NOT_REQUESTED`、`cursorAdvanced=false`、`executionStatus=SUCCEEDED`；
- 四个 manifest 声明的采集期验证器逐个 `name:ok`，外加能力自检 `adapter:ok`；
- 证据字节里 `collectContract().requiredFields` 的每个字段都在（防 D11 类缺陷）；
- 与 runtime 的 `validateContiguousPrefix / validateStructure / validateCompleteness` 交叉验证，同一组事实两边结论一致。

## 5. 本轮抓到的真实缺陷（3 条，均已修并各有测试）

1. **`import` 该 CLI 会真实导出一次**（顶层无 `isMain` 闸门）——见 D7。
2. **中文人工提示被默认分类器判成 `BUG`**——见 D5。这不是"文案问题"：`BUG` 的落态是 `FAILED/TERMINAL`，会把一次等待人工的登录问题变成一条终态失败的 run。
3. **零行导出被当成合法证据**（首版实现里 `rowCount=0` 会走到工件生成）——空排名没有任何可复核内容，必须在 `collectArtifact` 之前拒绝。已改为 `EVIDENCE_MISSING` → `EVIDENCE_INVALID`，并有测试。

## 6. 未做项（刻意不做，避免范围膨胀）

| 未做项 | 原因 |
| --- | --- |
| 真实浏览器跑一次 `sycm.search-rank.export` | 需要 Edge 调试实例上的生意参谋登录态；本轮没有在调试浏览器里重新登录（memory/2026-09-12 记录过 `HUMAN_REQUIRED`）。**这条能力目前只被夹具流程端到端驱动过，未被真实浏览器驱动过**，必须如实记录 |
| 迁移顺序第 3 项（XWS SKU） | 它的业务实现全部住在 `runtime/`（payload 解析、拓扑、dry-run manifest、按周同步等十余个模块），要迁移就得先把这些逻辑搬进技能目录。顺序上先做「实现已经在技能目录内、且无外部写」的第 4 项，风险更低。见 PHASE-ARCHIVE 第 9 节 |
| 把 `xws-export-market-analysis`（迁移顺序第 1 项）的专用运行路径改用通用运行器 | 技术债，未排入本轮 |
| 收紧 `advanceCursor` 前置条件 | 计划要求第三个能力迁完后收紧。本能力是只读、不推进游标，因此计数不变（仍为 2）；收紧动作留给下一个带外部写的能力迁完再做 |
