# sop-runtime 阶段 4a 报告：Validator 与 manifest 对接 + Controller 按能力 ID 接线

日期：2026-09-14
范围：实施计划「阶段 4：Validator 和 Adapter 收敛」的前半部分（Validator 组合接口 + 能力 ID 调用）
状态：代码已实现，84 项单测全绿；真实 manifest 的验证器声明全部有实现；未触碰数据库与外部系统
报告位置：runtime/sop-runtime/PHASE4-REPORT.md

## 1. 本阶段解决的问题

阶段 3 结束时 manifest 已经能声明 `validation: [...]`，但那个字段只是被校验「名字是否合法」，运行时并没有真的按它执行任何验证器——Worker 内部是写死的 identity/scope/structure/completeness/digest 五个。也就是说 manifest 的 validation 声明当时是**声明与执行脱节**的。

本阶段把这条缝补上：manifest 声明什么，Worker 就执行什么；声明了没有实现的名字，注册期直接失败。

## 2. 新增/修改文件

新增：

| 文件 | 职责 |
| --- | --- |
| runtime/sop-runtime/validation-registry.mjs | validation 名 → 实际验证函数的映射表、阶段划分、覆盖检查、按 manifest 装配 |
| runtime/sop-runtime/validation-registry.test.mjs | 11 项 |
| runtime/sop-runtime/capability-worker.test.mjs | 7 项（按能力 ID 装配的集成测试） |

修改：

| 文件 | 改动 |
| --- | --- |
| runtime/sop-runtime/validator.mjs | 新增 `validateArtifactIntegrity`、`validateContiguousPrefix`；`VALIDATOR_CODES` 增加 `ARTIFACT_INCOMPLETE` |
| runtime/sop-runtime/worker-adapter.mjs | `runOnce` 改为按 manifest 装配采集期验证器；新增 `createCapabilityWorker`；`failureClassOf` 把 VALIDATION_NOT_IMPLEMENTED / ADAPTER_CONTRACT_VIOLATION 归到 CAPABILITY_DEGRADED |
| runtime/sop-runtime/skill-registry.mjs | 新增 `knownValidators` 注入项，声明了未实现验证器即报 VALIDATION_NOT_IMPLEMENTED；`buildRegistry` 透传 |
| runtime/sop-runtime/build-skill-registry.mjs | 注入 `listValidatorNames()` 做覆盖检查；输出验证器实现清单（按阶段分组） |
| runtime/sop-runtime/index.mjs | 出口补 validation-registry |
| runtime/sop-runtime/skill-registry.test.mjs | 新增 knownValidators 用例（12 → 13 项） |

## 3. 关键设计决定

**验证器分两个阶段，不能混跑。**
采集期 9 个：source_identity、scope_match、structure、completeness、row_count、digest、artifact_integrity、relations、contiguous_prefix。
发布期 2 个：publication、readback。
理由：publication/readback 需要外部回读收据，采集完成时还没有该收据。如果混在同一批执行，声明了 publication 的能力会在采集期被误判为「证据无效」。因此 `buildValidatorsFromManifest` 带 `stage` 参数，Worker 只跑 COLLECT 阶段；发布期验证器已实现并有单测，但接入发布/提交路径属下一批（当前未接线，明确记录）。

**两道闸门，各管一段。**
- 枚举闸门（阶段 3 已有）：validation 名字必须在 `VALIDATION_NAMES` 内，否则 `VALIDATION_UNKNOWN`。
- 实现闸门（本阶段新增）：名字在枚举内但运行时没有实现，`VALIDATION_NOT_IMPLEMENTED`。
两者都必要：前者拦手误拼写，后者拦「架构上允许但还没实现」的漂移。两个测试分别覆盖。

**identity 校验不交给 manifest 决定。**
身份校验是硬不变量（Spec 3.1「模型不得修改身份字段」），因此 `runOnce` 无条件先跑 `source_identity`，再跑 manifest 声明的其余验证器。manifest 里声明不声明都不影响这条。

**无 manifest 时退回默认最小集合（兼容旧入口）。**
`createDeterministicWorker` 不传 manifest 时行为与阶段 3 之前一致（scope/structure/completeness/digest + adapter 自检），旧 CLI 与既有垂直切片测试不受影响——84 项测试里阶段 0/3 的既有用例全部未改动仍通过。

**副作用闸门挂在能力上，不挂在 Worker 上。**
`createCapabilityWorker` 返回 `assertEffect(effectClass)`，内部走 `registry.assertSideEffectDeclared`。提交路径上落地某个外部副作用前必须先过它，未在 manifest 声明即抛 SIDE_EFFECT_UNDECLARED。

**manifest 决定验证器这一点是可被证伪的。**
专门写了一个对照测试：同一个不连续分片缺陷，manifest 声明了 `contiguous_prefix` 时被拦（EVIDENCE_INVALID + REJECTED，游标不能推进），不声明时通过。这排除了「其实是硬编码在拦」的解释。

## 4. 验收结果

```
node --test runtime/sop-runtime/*.test.mjs
# tests 84   pass 84   fail 0
```

（阶段 0 的 27 项 + 阶段 3 的 38 项 + 本阶段 19 项；阶段 3 中 1 项 knownValidators 用例为新增，原有用例无改动无回归。）

```
node runtime/sop-runtime/build-skill-registry.mjs --check
# 发现 manifest 8 个，注册条目 8 个（能力 6，适配器 2）
# 验证器实现 11 个：采集期 9，发布期 2
# 告警 5 项（均为 adapter.browser 显式外部依赖）
# Registry 校验通过，registryDigest=sha256:dd564ed1…873a
```

结论：真实 8 个 manifest 声明的 validation 名字全部落在 11 个已实现验证器内，无 VALIDATION_NOT_IMPLEMENTED；registryDigest 与阶段 3 一致（未改 manifest，只改运行时）。

## 5. 实现过程中修掉的自身问题

1. 首次测试用 `vibes` 作为「未实现验证器」的反例，实际它先被 `VALIDATION_UNKNOWN`（枚举闸门）拦住，测不到本次新增的实现闸门。改为「枚举内但未注入实现」的 `row_count`，并补一条「枚举外名字在 manifest 阶段即被拒」的对照用例——两个闸门各自有了明确的测试证据。

## 6. 未做与阻塞

- 发布期验证器（publication/readback）已实现并单测覆盖，但**尚未接入发布/提交路径**；接线属阶段 4b。
- Controller 目前仍是「提供 `createCapabilityWorker` 这个接线点」，真正的业务 SOP（竞品周更、FAQ）还没有改成走能力 ID 调用；迁移按实施计划「先兼容旧 CLI，再切换 Controller」分批做。
- 数据库迁移仍**未执行**：004 未 apply、005 未 apply。原记录的阻塞原因（角色 `xws_agent` 无 CREATEDB、隔离库验证无环境）**已在 2026-09-14 被推翻**：实际连接角色是 `xws_runner`（superuser=true、createdb=true），隔离库验证已可执行，见下文更正与阶段 4b 报告第 5 节。
- xws-sku-collection / xws-faq-operator 仍未登记 manifest（目录内无 .mjs 实现，须先迁 Adapter/Workflow 契约）。

## 7. 下一步建议

1. 阶段 4b：把发布期验证器接到提交/发布路径，让「提交后回读校验」也由 manifest 声明驱动。
2. 用一个真实业务 SOP（建议先做 XWS 单分片采集）走一遍：admit → createCapabilityWorker → runOnce → 提交 → 回读 → 游标推进，产出前后对照收据。
3. 解除数据库阻塞后 apply 004/005，再用 pg-store 重跑垂直切片与真实跨进程故障注入。

## 8. 事后更正（2026-09-14 追记）

第 6 节原写「角色 xws_agent 无 CREATEDB，隔离库验证无环境」。该结论基于文档转述，实测不成立：

- 实际连接角色是 `xws_runner`，superuser=true、createdb=true，隔离库可以创建。
- 004 首次隔离验证**发现真实缺陷**：`architecture.phases` 的 7 行种子数据把 `risks`/`exit_criteria` 两个 jsonb 列写成了纯文本，执行到第 18640 字节处报 `invalid input syntax for type json`。已修正为 JSON 数组字面量。
- 修正后隔离验证 **17/17 通过**（语法、幂等、CHECK 约束、默认值、rollback、rollback 后重放）。
- 仍未对任何真实环境 apply；004 的 apply 仍需目标环境确认。
