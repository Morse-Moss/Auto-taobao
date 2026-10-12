# 附：v1 三块设计存档（**冻结，暂不实施**）

> 本文件是 v1 提案（2026-10-10 上午）里三块设计的存档，**不是待办**。
> 状态：**P3 冻结**。什么时候解冻，看
> [`GENERIC-ORCHESTRATION-PROPOSAL-2026-10-10.md`](GENERIC-ORCHESTRATION-PROPOSAL-2026-10-10.md) §5.3 的三条触发条件。
>
> 存档理由：这三块的**接口形状**是最难改、最贵改的东西（上游提案 §4.2 明写）；
> 把它写下来不等于要做它，而是为了将来真要做时不必重新推一遍。

---

## A. 资源管家（Browser Broker 的"有并发消费方"那一半）

### A.1 落点与分工

| 文件 | 性质 | 职责 |
| --- | --- | --- |
| `runtime/browser-broker/lane-key.mjs` | 纯函数 | 由 `browser-ports.mjs` 推导 lane 键：`<租户>:<店铺>:<平台>:<账号>:<profile>` |
| `runtime/browser-broker/plan.mjs` | 纯函数 | `planAcquire()` / `planRelease()` / `planReconcile()`：只算"该起谁、该停谁、该拒谁" |
| `runtime/browser-broker/lease-store.mjs` | 只做文件 | 租约与 lane 锁落盘：`runtime/.instance-leases/<租约id>.json`、`runtime/.lane-locks/<lane 摘要>.json` |
| `scripts/instance-broker.mjs` | CLI 门面 | `status` / `reconcile`（只读）｜`acquire` / `release`（要 `--commit`） |

**管家不重新实现起停**：它 spawn 现有 `scripts/start-all.mjs` / `stop-all.mjs`。
理由：那两条命令已经有"幂等""拒停外来""独立回读自证"三条判据，重写一遍＝把三条判据各写第二遍。

### A.2 接口形状（沿用上游 §4.2）

```text
node scripts/instance-broker.mjs status [--json]
    → declareInstances() + listLive() + reconcile()
node scripts/instance-broker.mjs reconcile [--json]
    → { matched: [], orphan: [], missing: [], staleLeases: [] }   # 只报告，绝不终止进程
node scripts/instance-broker.mjs acquire --shops a,b --shared dailyReport --commit [--json]
    → { leaseId, acquired: [...], reused: [...], refused: [{ key, code, why }] }
node scripts/instance-broker.mjs release --lease <leaseId> --commit [--json]
    → { stopped: [...], kept: [{ key, why }] }

# 明确不存在的方法：getCookies()｜killOrphan()｜autoDetectMemory()
```

### A.3 五条不变量

1. `SHARED_INSTANCE_KEYS`（日报共用商家浏览器）**永远不在** `release` 的 `stop` 里。
2. **只停本租约 `acquired` 过的键**；他人租约持有的键落 `kept` 并给理由。
3. **存活状态永远当场探测，不落盘**；租约只记"谁申请过、什么时候、用于什么"。
4. 租约指向的进程已消失 ⇒ 判 `EXPIRED` 并如实报告，**不重启、不清理**。
5. lane 互斥：同一 lane 同一时刻只允许一个持有者；拒绝时给 `RESOURCE_BUSY` ＋ 持有者是谁。

### A.4 判据

| # | 判据 |
| --- | --- |
| B1 | `status` 判决与 `runtime/browser-inventory.mjs` **逐条一致** |
| B2 | 同一批连跑两次 `acquire` ⇒ 第二次 `acquired: []` |
| B3 | `acquire` 含未登记店名 ⇒ 当场拒（复用 `resolveShopNames`） |
| B4 | `release` 的 `stop` **永不含** `SHARED_INSTANCE_KEYS` |
| B5 | `release` 不碰非本租约的键 |
| B6 | 租约进程已死 ⇒ `status` 报 `staleLeases`，且**零动作** |
| B7 | 未给 `--commit` 时 `acquire` / `release` 零副作用 |

---

## B. 作业单

### B.1 载体与落点

```text
runtime/stage-registry.mjs    # 纯：阶段名 → { file(字符串路径), args(参数模板), blocking, note, kind, artifact? }
runtime/work-order.mjs        # 纯：normalizeWorkOrder() ＋ compileXxxOrder()
runtime/work-order.test.mjs
```

先做**纯函数**、不做 JSON 文件：纯函数能被离线用例完整断言。

### B.2 schema（v1）

```js
{
  schemaVersion: 'work-order-v1',
  name: 'daily-report',
  dateInput: 'yesterday',
  select: { shops: null, batches: null },
  resources: { shared: ['dailyReport'], perShop: true, release: 'always' },
  behavior: { commit: false, notify: 'print', autoLogin: true, hold: true, reloginOnWall: false },
  stages: [
    { id: 'ensure-instances', stage: 'broker.acquire-shared', blocking: false, note: '…' },
    { id: 'login-preflight',  stage: 'sycm.check-login', artifact: 'login-preflight.json', blocking: false },
    { id: 'chain',            stage: 'sycm.daily-chain', blocking: true,
      stopWhen: { verdict: 'ROUND_BLOCKED' } },
    { id: 'hold',             stage: 'hold.and-resume', onlyWhenChainFailed: true, blocking: false },
  ],
}
```

三个设计要点：

1. `stages[].stage` 写**阶段名**，不写路径；插值变量有白名单（`{date} {shops} {shopKey} {proxy} {evidence} {logs} {loginPreflight}`），
   出现未登记变量当场抛。
2. `note` **必填** —— `--print` 是人确认"将要执行什么"的唯一凭据。
3. **策略留在作业单里**（`stopWhen` 就是例子），不留在外壳里。

### B.3 与 `skills/*/manifest.json` 的关系：**不合并**

| | `manifest.json` | 阶段登记表 |
| --- | --- | --- |
| 描述什么 | 一个**能力**：一次调用、一份产出 | 编排里的**一步**：有序、可 `blocking:false` |
| 关心的事 | 权限、副作用、依赖、恢复 | 顺序、成败、谁来收结论 |

把 `blocking` / `artifactPath` 加进 manifest，等于让"能力自描述"长出**编排概念**。

### B.4 回归判据：快照

`compileDailyReportOrder()` 必须**逐字复现** `buildJobPlan()` 的 `steps`。
做法：先用四组典型参数（默认／`--batches 5 --commit --notify`／`--auto-repair …`／不给 `artifactsDir`）
把今天的 `steps` 序列化进 `runtime/__snapshots__/daily-plan.v1.json`，改造后逐字节比对。

**注释必须跟着搬**：`daily-job-plan.mjs` 那 725 行里大部分是"为什么这个默认值停在这一侧"，
它们是判据的一部分，不是文档。

---

## C. 统一外壳

### C.1 今天被写了两遍以上的横切关注点

| 关注点 | `run-daily-job` | `run-batches` | `run-product-data-job` |
| --- | --- | --- | --- |
| 版本行落日志第一行 | 有 | 有 | 有 |
| 证据目录 + 日志 fd + `log()` | 有 | 有 | 有 |
| 环境预检 | 有 | **无** | 有 |
| 全局锁 | 有 | **无** | 有 |
| 收据文件 | `run-receipt.json` | `batches.json`（另一种形状） | `workflow-receipt` |
| `--print` 只打印模式 | 有 | 有 | **无** |
| 告警出口唯一化 | 计划层拦 | 参数层拦 | 有 |
| 退出码口径（只有续跑成功能翻绿） | 有 | 有 | 有 |
| 驻留 / 续跑调用 | 有 | 有 | 有 |

### C.2 落点

```text
runtime/shell/shell-plan.mjs     # 纯：shouldRunStep() / 退出码口径 / 作业单校验
runtime/shell/shell-run.mjs      # IO：遍历 steps、spawn、捕获 artifact、写收据、开锁、开日志
scripts/run-work-order.mjs       # 唯一入口：--order <名> [--print]
```

**外壳不认识业务**：一个 `if (name === 'chain')` 都不许有。
三个旧宿主退化成薄壳，保留一个版本周期，配 `--legacy-host` 回退。

---

## D. 从这三块里抽出来的四条边界（**即使不实施也成立**）

1. `runtime/` 永不 import `skills/`；脚本一律记**路径字符串**（与 `JOB_FILES` 同一条理由）。
2. 不做内存档位自动探测（`batch-plan.mjs` 已写明："宁可让人显式给一个数"）。
3. 不做 Docker/K8s、不搬浏览器（上游 §7.4）。
4. 不新造第二个通用编排器：登记式那条路（排期＋能力表＋探测）继续只服务"一次调用一份产出"的能力。
