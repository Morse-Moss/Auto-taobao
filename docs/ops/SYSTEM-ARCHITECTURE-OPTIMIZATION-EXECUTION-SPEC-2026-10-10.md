# 系统架构优化执行规格

状态：执行规格（待实施）  
版本：v1  
日期：2026-10-10  
适用项目：`D:\Retire\sycm-automation`

本文供开发执行。它把本轮架构审查转成可验证的工程任务，不代表所有目标架构已经落地，也不授权推送、部署、创建定时任务或清理历史运行产物。

## 1. 目标

在不改变现有日报、周报、商品日报和推广日报业务口径的前提下，完成以下结果：

1. 新增业务流程时，只新增能力适配器和登记项，不再复制一套批次、锁、通知、收据和释放逻辑。
2. 日报、推广日报、商品日报、周报使用同一套可识别的工作流登记、运行回执和证据索引。
3. 业务规则与机械执行机制分离：公共层不理解阿里妈妈字段、页面按钮、飞书业务表或平台选择器。
4. 运行状态、证据状态、人工状态、资源状态和发布状态分开表达，避免一个 `status` 隐含多个事实。
5. 运行日志、下载文件、截图和回执不再持续污染源码目录。
6. 任何一次真实写入都能从观察结果追溯到校验工件、幂等提交和飞书回读。

## 2. 当前基线与边界

### 2.1 已有能力，必须复用

以下模块是现有机械执行层，开发不得另建同义实现：

- `runtime/batch-plan.mjs`
- `scripts/run-batches.mjs`
- `scripts/start-all.mjs` / `scripts/stop-all.mjs`
- `runtime/browser-ports.mjs` / `runtime/browser-inventory.mjs`
- `runtime/workflow-lock.mjs`
- `runtime/feishu-targets.mjs`
- `runtime/notify-feishu.mjs` / `runtime/notify-feishu-core.mjs`

推广日报独有的页面、报表参数、维度、ZIP 校验、字段映射和目标表规则必须继续留在：

- `skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs`
- `skills/sycm-alimama-daily-report/scripts/run-promotion-sales1.mjs`
- `skills/sycm-alimama-daily-report/scripts/import-promotion-daily-report.mjs`
- `skills/sycm-alimama-daily-report/scripts/promotion-daily-report-core.mjs`

### 2.2 当前事实，不得被规格改写成“已完成”

- 推广日报已经接入通用批次执行器，并有销售一部真实运行证据。
- 本地工作区仍有大量历史改动和运行产物；本规格不允许整体 `git add`、整体 reset 或批量删除。
- 当前远端和本地提交状态、定时任务状态、浏览器登录态必须在每次交付前重新核验。
- `GENERIC-ORCHESTRATION-PROPOSAL-2026-10-10.md` 是提案材料，不是已批准的实现事实。

### 2.3 本轮明确不做

- 不引入 Temporal、Docker、Kubernetes、Browser Broker 或新的通用 supervisor。
- 不把业务规则搬进 `runtime/`。
- 不自动修复 selector，不绕过登录、验证码、风控、权限或额度控制。
- 不迁移或删除历史 `evidence/`、`runtime/` 运行目录；清理必须另行完成归属盘点和可逆隔离。
- 不创建或修改生产定时任务，不推送远端，不部署。

## 3. 目标结构

```text
触发器 / 人工命令
        |
        v
统一入口契约（workflow + targetDate + mode + batchSize）
        |
        v
工作流目录（只登记入口、阶段、资源和策略）
        |
        v
公共执行层
锁 / 批次 / 浏览器起停 / 登录门禁 / 证据索引 / 通知 / 退出码
        |
        v
业务适配器
日报 / 推广日报 / 商品日报 / 周报
        |
        v
验证与发布
Validated Artifact -> Idempotent Commit -> Feishu Readback
```

公共执行层只处理机械语义。业务适配器负责平台页面、报表参数、数据结构、字段映射和业务验收。

## 4. 工作流登记契约

### 4.1 新增文件

新增：`runtime/workflow-catalog.mjs` 及对应测试 `runtime/workflow-catalog.test.mjs`。

该文件只保存字符串和确定性配置，不 import `skills/` 下的业务代码。入口脚本由调度器按字符串启动，避免继续扩大 `runtime -> skills` 的反向依赖。

### 4.2 登记项结构

每条工作流必须登记以下字段：

```js
{
  id: 'promotion-daily',
  version: '1.0.0',
  label: '推广日报',
  entry: {
    batch: 'skills/sycm-alimama-daily-report/scripts/run-promotion-sales1.mjs',
    single: 'skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs'
  },
  planner: 'batch-v1',
  defaultBatchSize: 5,
  dateInput: 'yesterday',
  mode: { manualDefault: 'dry-run', schedulerAllowed: ['apply'] },
  resources: ['merchant-browser', 'shop-browser', 'feishu'],
  shopSource: 'runtime/browser-ports.mjs',
  commitPolicy: 'explicit-apply',
  receiptSchema: 'run-receipt-v1',
  evidencePolicy: 'run-root-v1',
  notificationPolicy: 'shared-notify-v1'
}
```

四条现有主流程必须登记：

| id                | label | 业务入口                       | 默认批次 |
| ----------------- | ----- | -------------------------- | ---: |
| `daily-report`    | 日报    | 现有日报批次入口                   |    5 |
| `promotion-daily` | 推广日报  | `run-promotion-sales1.mjs` |    5 |
| `product-daily`   | 商品日报  | 现有商品日报入口                   |    5 |
| `weekly-report`   | 周报    | 现有周报入口                     |  按流程 |

### 4.3 登记校验

`workflow-catalog.test.mjs` 必须验证：

- id 唯一，版本符合 semver 形式。
- 所有入口文件存在。
- `defaultBatchSize` 为正整数；销售一部默认值为 5。
- `mode.manualDefault` 必须是 `dry-run` 或 `apply`。
- 生产写入只能由显式 `apply` 触发。
- `runtime/` 不得 import 业务入口模块。
- 未登记的 workflow 立即失败，不得回退到日报默认入口。

## 5. 统一入口契约

### 5.1 命令行参数

所有可批次执行的工作流必须支持同一组公共参数：

```text
--workflow <id>
--date yesterday|YYYY-MM-DD
--batch-size <n>
--shops <a,b,c>
--mode dry-run|apply
--print
--evidence-root <path>
--notify|--notify-print
```

兼容期内可以保留 `--commit`，但必须转换为 `--mode apply`，并在输出中显示转换结果。公共入口不得对某一条业务线无条件强制 `apply`。

### 5.2 行为不变量

- `dry-run` 不得写飞书，不得推进业务游标，不得伪造成功回执。
- `apply` 必须经过字段白名单、幂等键、写入和独立回读。
- `--print` 打印的命令、店铺名单、模式和批次必须与实际执行完全一致。
- 同一批次的起、跑、停必须使用同一份店铺名单。
- 失败店铺进入独立结果；其他店铺不得因单店业务失败而被静默跳过。
- 同一目标日重复运行必须命中幂等保护，不得重复创建业务数据。

## 6. 统一运行回执契约

### 6.1 新增文件

新增：`runtime/run-receipt-v1.mjs` 及 `runtime/run-receipt-v1.test.mjs`。

现有 `run-receipt.json`、`batches.json` 和能力级 `receipt.json` 可以在兼容期继续生成，但必须同时生成统一回执；后续以统一回执为查询入口，不能再新增第三种主格式。

### 6.2 最小结构

```json
{
  "schemaVersion": "run-receipt-v1",
  "runId": "promotion-daily-2026-10-09-<uuid>",
  "workflow": { "id": "promotion-daily", "version": "1.0.0" },
  "targetDate": "2026-10-09",
  "mode": "apply",
  "batchSize": 5,
  "execution": "SUCCEEDED",
  "batches": [
    {
      "index": 1,
      "shops": ["盖文淘宝"],
      "execution": "SUCCEEDED",
      "steps": [
        { "name": "collect-keyword", "execution": "SUCCEEDED", "evidence": [] },
        { "name": "collect-audience", "execution": "SUCCEEDED", "evidence": [] },
        { "name": "publish", "execution": "SUCCEEDED", "publication": "VERIFIED" }
      ],
      "release": { "requested": true, "observed": true, "status": "RELEASED" }
    }
  ],
  "shops": [],
  "artifacts": [],
  "failureClass": null,
  "startedAt": "2026-10-10T00:00:00Z",
  "finishedAt": "2026-10-10T00:30:00Z"
}
```

### 6.3 状态轴

不得用一个字段同时表示执行、证据、人工、资源和发布：

| 轴           | 允许值                                                      |
| ----------- | -------------------------------------------------------- |
| execution   | `QUEUED / RUNNING / PAUSED / SUCCEEDED / FAILED`         |
| evidence    | `NONE / CANDIDATE / VALIDATED / REJECTED`                |
| humanGate   | `NONE / WAITING_HUMAN / APPROVED / DENIED / EXPIRED`     |
| lease       | `WAITING / HELD / EXPIRED / RELEASED`                    |
| publication | `NOT_REQUESTED / READY / COMMITTED / VERIFIED / UNKNOWN` |

失败分类至少支持：`TRANSIENT_EXTERNAL`、`RESOURCE_BUSY`、`HUMAN_REQUIRED`、`CAPABILITY_DEGRADED`、`EVIDENCE_INVALID`、`POLICY_DENIED`、`USAGE_LIMIT_REACHED`、`COMMIT_UNKNOWN`、`BUG`。

## 7. 证据与运行目录治理

### 7.1 目标

源码目录只保留源码、测试和稳定文档。运行产物必须落到可配置的运行根目录，不得默认持续写入 `runtime/` 根目录。

### 7.2 新增解析器

新增：`runtime/run-root.mjs` 及测试 `runtime/run-root.test.mjs`。

规则：

```text
<run-root>/<workflow>/<target-date>/<run-id>/
  run-receipt.json
  manifest.json
  logs/
  artifacts/
  screenshots/
  downloads/
```

运行根目录通过 `SYCM_RUN_ROOT` 或 `--evidence-root` 指定。未配置时使用机器级外部运行目录；不得把凭据、Cookie、认证头写入任何子目录。

### 7.3 迁移纪律

- 先支持新目录并保留旧路径兼容读取。
- 不在同一变更中移动或删除历史证据。
- 每次运行回执记录实际证据根路径、文件大小、哈希和保留级别。
- 失败证据和成功证据都保留；清理只能依据明确保留策略并走单独变更。

## 8. 依赖边界

### 8.1 本轮要求

- `runtime/` 只能依赖公共运行时、标准库和登记字符串。
- `skills/<name>/` 可以依赖 `runtime/` 的公共机制，但业务规则不进入 `runtime/`。
- 新增反向依赖必须先登记并由 `runtime/arch-boundary.test.mjs` 审核。
- 不要求本轮一次性消除现有反向依赖；先禁止新增，后续逐批迁移。

### 8.2 迁移顺序

1. 先把可复用函数移入公共层并补纯函数测试。
2. 再让业务适配器调用公共函数。
3. 用旧入口和新入口各跑一次 dry-run，对比计划、店铺、参数和收据。
4. 真实 apply 通过后再删除旧实现。

## 9. 分阶段执行计划

### P0：冻结基线和登记现状

交付：

- 当前四条流程的入口、店铺、资源、目标和真实证据清单。
- 当前 `main`、远端、工作区、运行进程和调度器状态分开记录。
- `workflow-catalog.mjs` 初版和测试。
- `--print` 计划快照，证明新登记不会改变现有命令。

完成条件：四条 workflow 均能被登记、解析、打印；旧入口行为不变。

### P1：统一运行回执和状态轴

交付：

- `run-receipt-v1.mjs`。
- 日报、推广日报、商品日报至少在 dry-run 生成统一回执。
- 单店失败、批次失败、整轮失败分别可读。
- 回执包含证据路径、发布状态和释放观察结果。

完成条件：同一轮能从统一回执回答“跑了哪些店、哪一步失败、是否写入、是否回读、是否释放”。

### P2：统一入口，保留业务适配器

交付：

- `run-batches.mjs` 从 workflow catalog 解析入口。
- `run-daily-job.mjs` 与批次入口共享同一参数解析和模式语义。
- `--mode dry-run|apply` 接入；保留 `--commit` 兼容提示。
- 通知出口、退出码和失败分类只保留一套公共实现。

完成条件：日报和推广日报的 dry-run 计划逐项一致；推广日报不再被公共层隐式强制写入。

### P3：运行产物隔离

交付：

- `run-root.mjs` 和运行目录结构。
- 新运行默认写外部运行根目录。
- 旧证据可读，历史目录不删除。
- 文档补充运行目录、保留策略和恢复入口。

完成条件：一次完整 dry-run 不新增源码目录散落日志、截图或下载文件。

### P4：稳定性验收和文档对齐

交付：

- 至少三轮真实运行记录。
- 至少一次单店失败隔离和按批续跑记录。
- 至少一次“写入后回读失败/外部不可用”场景下的源工件复用记录。
- 更新 `docs/project-knowledge.md`、相关 `SKILL.md` 和运行手册。

完成条件：文档只描述已验证事实；未完成项明确标记为未验证或非目标。

## 10. 测试与验收

### 10.1 每阶段必跑

- `npm.cmd run check:staged`
- 受影响模块的 `npm.cmd run test:staged -- --budget-seconds=120`
- `git diff --check`
- 工作流登记、收据、运行根目录的独立单元测试。

不得在浏览器链运行期间启动会长时间占用浏览器的全量测试。

### 10.2 真实验证

真实 apply 必须按以下证据链验收：

```text
Observation
 -> Candidate Artifact
 -> Validated Artifact
 -> Decision
 -> Idempotent Commit
 -> Publication Receipt
```

推广日报逐店至少验证：

- 关键词 ZIP 存在、日期正确、列数符合允许集。
- 人群 ZIP 存在、日期正确、列数符合允许集。
- 页面参数命中 30 天累计和昨日口径。
- 飞书写入使用幂等键，写后独立回读一致。
- 单店失败不会静默阻塞其他店。
- 批次释放状态以端口复核为准，不能只看 stop 命令退出码。

### 10.3 生产准入

本规格完成不等于自动获准生产。推广日报进入定时任务前，必须另有：

- 远端包含目标提交。
- 调度器命令明确使用 `promotion-daily` 和批次大小 5。
- 运行用户、浏览器 profile、代理、日志根目录和告警出口已回读确认。
- 至少三轮真实运行成功，且有失败隔离和恢复证据。
- 业务负责人确认外部写入和告警投递授权。

## 11. 回滚

每个阶段必须提供旧入口回退：

- 新目录解析失败时回到旧 evidence 路径读取。
- workflow catalog 解析失败时停止运行，不猜默认 workflow。
- 统一回执生成失败时不得把旧收据标成成功。
- 新入口必须保留 `--legacy` 或等价配置开关，直到 P4 完成。
- 删除旧实现前必须保留一轮可复核的前后计划对比证据。

## 12. 开发提交边界

允许本规格范围内提交的内容：

- `runtime/workflow-catalog.*`
- `runtime/run-receipt-v1.*`
- `runtime/run-root.*`
- `scripts/run-batches.mjs`、`scripts/run-daily-job.mjs` 的最小接线改动。
- 对应测试、稳定文档和变更记录。

默认禁止纳入：

- `evidence/` 历史目录的整体变更。
- 浏览器 profile、下载缓存、凭据、`.env`、截图和运行日志。
- 与本规格无关的其他 skill 修复。
- 未经授权的远端推送、定时任务注册、飞书写入和进程清理。

## 13. 需要业务负责人确认的事项

开发可以按推荐值实现，但上线前必须得到明确答复：

| 事项             | 推荐默认值                      |
| -------------- | -------------------------- |
| 手动运行默认模式       | `dry-run`                  |
| 定时任务模式         | 显式 `apply`                 |
| 默认批次大小         | 5                          |
| 证据保留           | 成功 30 天、失败 180 天；未批准前不自动删除 |
| 推广日报调度         | 独立 workflow，不复用日报默认入口      |
| 外部告警           | 失败才投递，发送由调度配置显式开启          |
| Browser Broker | 本轮不做，出现第二并发消费方后重评          |
| Temporal       | 本轮不做，先用现有运行时和 PG 状态        |

## 14. 完成定义

只有同时满足以下条件，开发才能报告本规格完成：

1. 四条主流程均有唯一登记项和版本。
2. 公共入口不再靠新增 workflow 分支复制编排逻辑。
3. dry-run/apply 语义明确，公共层不隐式写入。
4. 统一回执能独立表达执行、证据、人工、资源和发布状态。
5. 新运行产物不污染源码目录，旧证据仍可读。
6. 推广日报的业务逻辑仍封装在其适配器内。
7. 受影响测试、边界测试和至少一轮真实验证通过。
8. 文档、代码、运行证据和交付状态相互对齐。
