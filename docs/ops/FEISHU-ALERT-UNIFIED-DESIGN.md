# 飞书预警机制统一设计（2026-10-13）

> 目标：把「每条流程跑完叫一次人、每条流程失败也叫一次人」从**各链各自手搓**收敛成**一套触发条件、一套判定规则、一套编号域、一套去重**。
> 本文只做设计与梳理，不改任何生产链行为。落地顺序见 §10。

---

## 1. 边界

在范围内：`runtime/workflow-catalog.mjs` 登记的四条流程（日报 / 推广日报 / 商品数据 / 周报），以及它们共用的守卫层（跑前登录预检、驻留续跑、商家登录）。

不在范围内：关键词链与竞品链（`SHOPS_NOT_COLLECTING_YET` 之外的那部分半自动段，无单一编排入口、第 6 步买家号登录必须人），本文只把它们已有的守卫级告警纳入「标题表与去重」两件公共事，不给它们加自动完成通知。

---

## 2. 现状盘点（全部可核对，不是印象）

### 2.1 三层设施已存在，且都只有一个来源

| 层 | 文件 | 职责 | 现状 |
|---|---|---|---|
| 投递 | `runtime/notify-feishu-core.mjs`（388 行）+ `runtime/notify-feishu.mjs`（176 行） | 三跳投递链（自建应用→主收件人 → 自建应用→兜底收件人 → 群 webhook）、token 提前 5 分钟过期、认证类错误清缓存重取一次、缺 scope 给指引、收据 `SENT/FAILED/NOT_CONFIGURED`、渲染白名单 `READABLE_SOURCE_KEYS`（9 键）、`TITLE_BY_TYPE`（14 项） | 健康，无需改 |
| 去重 | `runtime/alert-throttle.mjs` | `alertId + fingerprint`，6 小时窗口，状态文件 `runtime/alert-throttle.json`（不进 git），写失败不影响主流程，只认「真送出去」才记账 | 健康，无需改 |
| 判定 | `runtime/sop-runtime/round-notify-policy.mjs`（555 行） | `ROUND_NOTIFY_RULES` 规则表、`NEEDS_KINDS` 五轴（ONSITE/UPSTREAM/CONFIG/RECONCILE/VENDOR）、`resolveNotifyRule`、`decideNotification`、`buildRoundAlert`、`buildResolvedAlert`（恢复通知，`ROUND_RESOLVED`/INFO） | **有内核、没接线**（见 §3.3） |

另有两件已共享的小设施：`resolveAlertDispatch({notify, notifyPrint, mode})`（告警出口必须恰好一个，`--notify` 与 `--notify-print` 互斥）与 `runtime/hold-and-resume-plan.mjs` 的 `closeOutNotice`（驻留超时必发）。

### 2.2 各流程接入矩阵

| 流程 | workflow id | 失败告警 | 完成告警 | 去重 | 实证 |
|---|---|---|---|---|---|
| 日报 | `daily-report` | 有：`DAILY_ROUND_FAILED`（`run-multi-shop-day.mjs:1101`）、跑前登录 `sycm-login-round-<日>`、驻留续跑失败 `daily-hold-resume-failed-<日>`、`DAILY_HOLD_TIMEOUT` | **无** | 有 | `runtime/alert-throttle.json` 里 `daily-round-*` 共 15 条 |
| 推广日报 | `promotion-daily` | 有：`PROMOTION_ROUND_FAILED`（`run-promotion-sales1.mjs:32`）、`promotion-hold-resume-failed-<日>` | **无** | 有 | `promotion-round-20261011` 1 条 |
| 商品数据 | `product-daily` | 有：`product-data-<日>`（`scripts/run-product-data-job.mjs:104` 的 `notifyFailure`） | **无**（该函数注释原话：「成功不叫 —— 与日报链同一口径」） | 有 | `product-data-*` 共 5 条 |
| 周报 | `weekly-report` | 有（失败段） | **有，且是唯一一条**（`runtime/run-weekly-collection.mjs:173`，`severity: failures.length ? 'ERROR' : 'INFO'`，标题「竞品周采集完成：…」） | **无**：`alertId: weekly-collect-${Date.now()}` ⇒ 每轮都是新编号，且不写 throttle | throttle 文件里 `weekly-*` **0 条** |
| 关键词/灰豚 | 未登记 | 有：`xws-sku-auth-preflight.mjs` 的 `XWS_*` 7 类 + `runtime/supervise-collection.mjs` 状态机（`RUNNING/SUSPECT_STALLED/COMPLETED/FAILED/UNKNOWN`，只投状态变化，`COMPLETED` 默认要投） | 部分（仅自适应采集） | 部分 | — |

### 2.3 实证：`runtime/alert-throttle.json` 现在长什么样

文件里 35 条记录，编号域只有五种：`daily-round-<日>`、`sycm-login-round-<日>`、`product-data-<日>`、`promotion-round-<日>`、`*-hold-resume-failed-<日>`。

**没有任何一条成功/完成类编号。** 这就是「完成提醒缺失」最硬的证据 —— 不是没设计，是根本没发过。

---

## 3. 四个真缺口

### 3.1 完成提醒缺失（三条主链 + 一条脱节）

日报、推广日报、商品数据三条链，跑完了收信人收不到任何消息。收信人要知道「今天收完了」，只能自己去飞书底单数行。这与「自动化」的目的是反的：**安静的通道等于没有通道**。

商品链的注释把「成功不叫」写成了与日报链同一口径 —— 那是把缺陷当成了约定继承下来。

### 3.2 周报链的完成通知与公共体系脱节

`alertId: weekly-collect-${Date.now()}`：每轮一个新编号 ⇒ `resolveAlertDedup` 永远判「这个编号之前没发过」⇒ 永不节流；同时它不写 throttle 文件 ⇒ 别的链看不到它、它也别想挡别人。同一件事在两套口径下各做一遍，就是漂移的来源。

### 3.3 统一判定内核没接到生产链

`round-notify-policy.mjs` 已经写好了规则表、五轴归因、恢复通知，但它挂在 `sop-runtime/round-runner.mjs` 上；生产链（日报/推广/商品）各自手搓 alert 对象、各自判「要不要发」。后果：规则表是**死表**——改它不影响任何一条真实链路；而四条链对「同类失败该不该叫」给出各自的答案。

### 3.4 标题表漏项没有守卫（潜伏，不是活故障）

在用的四个 round 级 type —— `DAILY_ROUND_FAILED`、`DAILY_HOLD_TIMEOUT`、`PROMOTION_ROUND_FAILED`、`ROUND_RESOLVED` —— **都不在 `TITLE_BY_TYPE` 里**。现在没出事，是因为这四处调用都传了显式 `title`（`run-multi-shop-day.mjs:1103`、`run-promotion-sales1.mjs:34`、`noticeBase()` 透传、`buildResolvedAlert`）。`resolveAlertTitle` 的优先级是「显式 title > 表 > 原样透出 type」。

`notify-feishu-core.mjs:43` 自己写着：「table 里漏一项 = 那条告警永远说不了人话，而且**不会有任何报错**」。而现有守卫只覆盖 `XWS_*`（`xws-sku-auth-preflight.test.mjs` 读 `ALERT_BY_STATUS`）。**谁把这四个 title 去掉一个，那条告警的第一行就静默变成 `DAILY_ROUND_FAILED` 这种机器词。**

### 3.5 severity 只有两档（不是缺口，是取舍）

实际只用了 `ERROR` / `INFO`。`renderAlertText` 只区分 `INFO→【提示】` 与其它 `→【需要处理】`。见 §6 为什么不引入第三档。

---

## 4. 统一设计思路：四层，每层只有一个来源

```
① 触发层（各链入口，唯一的「什么时候该想起来」）
      ↓  只传事实：flow / 业务日 / 跑了哪些对象 / 各自结果 / 退出码
② 判定层（runtime/round-notify-policy.mjs，唯一的「该不该叫、叫多重」）
      ↓  返回 decision：{ notify, severity, title, reason, action, needs, alertId, fingerprint }
③ 组装 + 去重层（buildRoundAlert + runtime/alert-throttle.mjs，唯一的「怎么编、要不要压」）
      ↓  写 alert.json 落盘（收信人可自查证据）
④ 投递层（runtime/notify-feishu.mjs，唯一的「怎么出去」）
      ↓  收据 SENT/DEDUPED/FAILED/NOT_CONFIGURED 回写，只有真送出去才记账
```

四条规矩：

1. **触发层不许判「要不要发」。** 它只负责把事实喂给判定层。现在四条链各写一遍 `if (failed.length) build...Alert(...)`，这就是规则漂移的入口。
2. **判定层只做纯函数。** 不碰 IO、不碰进程、不起浏览器 —— 保持离线可测。
3. **组装层的字段名必须落在 `READABLE_SOURCE_KEYS`（9 键）里**，否则那一行被静默丢掉。新写告警不要再塞 `loginUrl`（2026-09-19 实测：http 链接走系统默认浏览器，到不了目标 profile）。
4. **投递层不判静默、不判严重级。** 它只回答「出去没有」。

---

## 5. 触发条件矩阵（核心交付）

### 5.1 完成类（INFO，`【提示】`）

| 编号 | 场景 | 触发条件 | 发送方 |
|---|---|---|---|
| `<flow>-ok-<业务日>` | 一轮全部成功 | 该轮实际跑了 ≥1 个采集对象，且全部成功 | 链最外层（见 §5.4） |
| `<flow>-ok-<业务日>` | 失败后修复成功 | 同一业务日重跑后全部成功，**且** 同一编号域下存在未闭环的失败告警 ⇒ 改发「已恢复」而非「完成」 | 链最外层 |
| `<flow>-ok-<业务日>` | 部分成功 | **不发完成通知**，按失败告警走（见 5.2） | — |

「实际跑了 ≥1 个采集对象」这条不能省：整部门停采（`SHOPS_NOT_COLLECTING_YET`）时 0 对象跑完也发「完成」，是纯噪声。

### 5.2 失败类（ERROR，`【需要处理】`）

| 编号 | 场景 | 触发条件 | 现状 |
|---|---|---|---|
| `<flow>-round-<业务日>` | 部分店铺失败 | 至少 1 家失败、且未整轮被挡 | 日报 / 推广 / 商品已有 |
| `<flow>-round-<业务日>` | 整轮被挡（`ROUND_BLOCKED`） | 没有任何一家跑起来 | 日报已有 |
| `sycm-login-round-<业务日>` | 跑前登录预检发现掉登录 | `judgePreflight` 判需人 | 已有 |
| `<flow>-hold-resume-failed-<业务日>` | 驻留自动续跑没成功 | 续跑退出码非 0 | 已有 |
| `<flow>-hold-<业务日>` | 驻留等到截止仍无人处理 | `closeOutNotice` | 已有（必发，因为窗口一放人就接不上手了） |

**指纹必须含「停在哪一步」**（现状已做到）：同一编号但停的地方变了算新信息，不该被去重挡掉。

### 5.3 已知「不是故障」的形态 —— 不发

- `Ranks are not contiguous 1..N`
- 某阶段保护性重试后通过
- 代理连接层失败第 1/3 次、重发即通
- `push` 撞 `duplicate daily report row exists`（同日重跑必然撞，是去重闸门正确工作）
- `readback` 退出码 4「数据已核对、仅佐证不完整」（底单截图 CDP 超时）

这些是显式静默，必须在规则表里列名，不允许「表里查不到」被当成默认静默 —— 现在的默认方向是对的：**表里查不到的理由一律按「通知」处理**（`round-runner.mjs:17`）。

### 5.4 触发点：必须在链的最外层

日报链按 `--batches` 分批跑，一轮 = 2 批。**完成通知只能在最外层发一次**，在批内发会一天来两条。

| 流程 | 完成通知的挂点 | 判据来源 |
|---|---|---|
| daily-report | `scripts/run-daily-job.mjs` 的 `main()` 尾部（现在那里已经打「=== 定时任务结束 ===」） | `evidence/batches-<日>/batches.json` 的 `rounds[].chainStatus` |
| promotion-daily | `scripts/run-batches.mjs` 的收尾（现在那里打「=== 分批跑结束 ===」） | 同上 |
| product-daily | `scripts/run-product-data-job.mjs` 的 `main()` 尾部 | 已有的 `failure` / 退出码 |
| weekly-report | `runtime/run-weekly-collection.mjs` 已有的收尾告警（改编号域即可） | `failures.length` |

---

## 6. 完成通知的正文模板

只放白名单内的键，其余整行不输出。

```
【提示】日报采集完成（统计日 2026-10-12）
对象：日报一轮 · 8 家店铺
数据周期：2026-10-12
任务：各店铺日报
店铺：里可林淘宝、网林天猫、盖文淘宝、盖文天猫、科塔淘宝、网林淘宝、里可林天猫、网林家居
原因：8/8 家 11 个阶段全部通过；底单新增 8 行，询单表 8 行全部有值。
下一步：无需处理。要看明细可打开 evidence/batches-2026-10-12/batches.log
证据：<run-receipt.json 路径>
时间：2026-10-13 11:32:58
告警编号：daily-ok-20261012
```

「已恢复」变体（`buildResolvedAlert` 已实现，直接复用）：

```
【提示】已恢复：盖文天猫的日报没收完（统计日 2026-10-11）
…
原因：之前那条「…」的状态已经恢复。
下一步：无需处理。
```

**为什么不引入 WARN 第三档**：`renderAlertText` 只有 `INFO→【提示】` / 其它 `→【需要处理】` 两个前缀。加第三档要改渲染核心 + 加守卫 + 让收件人重新学一套颜色，而当前所有真实场景两档就够 —— 「部分成功（6/8）」本来就需要人补跑那 2 家，归 ERROR 是对的。**不建议加。**

---

## 7. 编号域与防轰炸规则

### 7.1 编号命名规范（新增，与现有五种并存）

```
<flow>-ok-<业务日>            完成 / 已恢复
<flow>-round-<业务日>         整轮或逐店失败
sycm-login-round-<业务日>     跑前登录预检
<flow>-hold-<业务日>          驻留超时
<flow>-hold-resume-failed-<业务日>
```

`<flow>` 取 `workflow-catalog.mjs` 的 id：`daily` / `promotion` / `product` / `weekly`。**业务日必须进编号**（现在的 `daily-round-<日>` 已是这个形状），否则跨日复用会把昨天的失败挡成今天的静默。

### 7.2 去重规则（复用 `resolveAlertDedup`；2026-10-17 加了 `ignoreFingerprintChange` 一档，默认关闭）

- 完成通知：`alertId = <flow>-ok-<业务日>`，`fingerprint = 成功数/总数`。同一业务日重复成功 ⇒ 6 小时窗口内挡掉。
- 失败→修复→成功：编号从 `<flow>-round-<日>` 变成 `<flow>-ok-<日>`，**编号不同 ⇒ 一定发**，且 type 用 `ROUND_RESOLVED`（INFO）。这正是 `buildResolvedAlert` 的设计意图。
- 失败告警：**按业务日结算，一天最多一条**（2026-10-17 改，`ignoreFingerprintChange: true`）。
  原先的写法是「编号相同 + 指纹相同 + 6 小时内 ⇒ 挡；指纹变了（停的地方变了）⇒ 发」，
  而实践里它变成了同一天多条：2026-10-17 一个业务日先停 `product-import` 发一条（02:24）、
  补跑那轮停 `promotion-import` 又发一条（03:31），随后补齐再发一条「已恢复」——
  三条消息讲同一件事，收信人看到的是「没收齐 → 还是没收齐 → 好了」。
  **中途换了个地方停，对收信人不是新信息**；他要的是「要不要我动手」和「最后好没好」。
  指纹仍然记进 throttle（排查时能看到这一轮停在哪），只是不再作为「再发一条」的理由。
- 例外（必须留着，否则「好了又坏」会被自己的历史永久挡住）：同一业务日已经发过 `<flow>-ok-<日>`、
  且它的发送时间**晚于**最近一条 `<flow>-round-<日>` ⇒ 说明是新故障，恢复正常判据、照发。
  商品链的判据是 `recoveredSinceLastFailure`（`run-product-data-job.mjs` 的 `notifyFailure`）。
- 读不懂 `sentAt` ⇒ 宁可发。

### 7.2.1 还没有照这个口径改的链（已知欠账）

目前只有商品链接了 `ignoreFingerprintChange`。日报链与推广日报链仍是「指纹变了就再发」，
且它们的 `hold-resume-failed` 与 `round` 常常间隔 3 分钟成对出现
（2026-10-14 六条、10-16 七条）。要不要一起收敛，取决于愿不愿意动「先报后挂」这个顺序
（见 7.4），**没有拍板前不要逐条链偷偷改**，否则同一件事两条链给出不同节奏。

### 7.3 一个要补的洞：`ROUND_RESOLVED` 发出去之后，那条失败的「开口」没有闭

throttle 只支持「记一条发过」，没有 close 操作。现状靠「编号不同所以不会被挡」侥幸工作。建议在 `writeAlertThrottle` 旁边加一个显式的 `closeAlertId(alertId)`（删掉 `byAlertId[alertId]` 或标 `closedAt`），让「已恢复」成为可验证的状态转移，而不是靠编号命名约定。**这是唯一需要动 `alert-throttle.mjs` 的地方。**

2026-10-17 的临时做法：商品链不新增 close 操作，而是**比较两条记录的时间**
（`product-ok-<日>.sentAt > product-round-<日>.sentAt` ⇒ 已恢复过）。
好处是不动存储结构、老状态文件照读；代价是「闭口」这件事仍然靠调用方记得判，
所以它在 `runtime/flow-ok-notice-wiring.test.mjs` 里有一条接线守卫盯着。

### 7.4 更根本的一条（未做，需拍板）：日报链是「先报后挂」，顺序反了

驻留机制的初衷是「失败了先挂住 4 小时等人处理，最后才叫人」，但实现是
**立刻发 `round` 告警 → 再挂住 → 续跑结果再发一条**。于是「能自动修好的那种失败」也提前叫了人，
修好之后再补一条「已恢复」。理想顺序是先挂、到期仍失败才发。
改它要动日报链的状态机与告警触发点，风险高于收益，**留待单独批次**。

---

## 8. 落地顺序与改动清单

按「先补洞、再接内核、最后加完成通知」排，每步独立可回滚。

**第 0 步（必做，零生产风险）**
- `runtime/notify-feishu-core.mjs`：把 `DAILY_ROUND_FAILED` / `DAILY_HOLD_TIMEOUT` / `PROMOTION_ROUND_FAILED` / `ROUND_RESOLVED` 补进 `TITLE_BY_TYPE`。
- 新增一条跨模块守卫：遍历仓库里所有 `type:` 字面量（或导出的告警构造器表），断言每个都在 `TITLE_BY_TYPE` 里 —— 把 `xws-sku-auth-preflight.test.mjs` 那条只覆盖 `XWS_*` 的判据升级成全仓判据。
- 验证：`node --test "runtime/notify-feishu*.test.mjs"`；突变验证：从表里删一项，确认新守卫红。

**第 1 步：周报链编号域归一（小、独立）**
- `runtime/run-weekly-collection.mjs`：`alertId` 从 `weekly-collect-${Date.now()}` 改成 `weekly-ok-<业务日>`；接入 `resolveAlertDedup` + `writeAlertThrottle`，只认 `SENT` 才记账。
- 风险：周报是周更，编号域换成业务日后，同一周重复跑不会轰炸。

**第 2 步：把判定内核接到生产链（核心，改动面最大）**
- `runtime/sop-runtime/round-notify-policy.mjs` 增加一个薄适配层 `decideRoundNotify({ flow, businessDate, results, openAlert })`，输入是各链已有的 summary，输出 decision。
- 日报链 `run-multi-shop-day.mjs` 的 `buildRoundFailureAlert` 改为调适配层；推广链 `run-promotion-sales1.mjs` 的 `buildPromotionRoundAlert` 同样；商品链 `run-product-data-job.mjs` 的 `notifyFailure` 同样。
- **保留各自的 title 措辞**（日报/推广/商品的标题现在都是人话，且带店名与阶段，是资产），只把「要不要发、severity、needs 归到哪一轴、要不要弹恢复通知」这四件收到一处。

**第 3 步：加完成通知**
- 三个外层入口各加一次 `notifyRoundOk(...)`，判据见 §5.1 / §5.4；遵守 `resolveAlertDispatch`（`--notify` 与 `--notify-print` 互斥，`--notify-print` 只打印不投递）。
- 完成通知也要落盘 `alert.json`（收据可自查），与失败告警同一路径。

**第 4 步：补 `closeAlertId`（§7.3）**

**每步的验收口径（缺一不可）**
1. 定向用例：`node --test "runtime/sop-runtime/round-notify-policy.test.mjs"`、`node --test "skills/sycm-alimama-daily-report/scripts/*.test.mjs"`。
2. 突变验证：每个新守卫都要改坏源码确认指名的用例变红。
3. 真机：下一轮日报定时跑（11:00）后，回读 `runtime/alert-throttle.json` 必须多出 `daily-ok-<业务日>` 一条；且一次「补跑同业务日」确认不再重复发。
4. 版本号 + `CHANGELOG.md` + 显式路径提交（不走 `-A`）。

---

## 9. 明确不做的事

- 不给关键词链 / 竞品链加自动完成通知（无单一编排入口、有人工步骤，完成与否本就该由人判）。
- 不改三跳投递链、不改收件人配置来源（仍以 `runtime/feishu-targets.mjs` 的 profile 为单点）。
- 不引入 WARN 第三档、不改 `READABLE_SOURCE_KEYS` 的 9 键集合。
- 不把告警发去任何消息面以外的新通道（邮件/微信一律不碰）。
