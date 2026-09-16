# 运营台交互设计：一个页面里的统一登录、启动 SOP、观察进度

面向的问题：运营（非技术）在一台电脑上，能否**只用一个页面**做完三件事 ——
①看清所有账号的登录态并就地重登 ②启动某条 SOP ③看它跑到哪、卡在哪、要不要我动手。

参考实现 = 用户指定的 `E:\小红书`（其登录/就绪度实现已在
`docs/ops/LOGIN-STATE-MANAGEMENT.md` §5 逐条对照过，本文不重复）。本文只解决**它没有的**那部分：
把「检查、重登、启动、进度」合成一个**可实现的界面规格**。
`docs/ops/CLIENT-DESKTOP-DELIVERY-PLAN.md` §2.2 已经定过「界面只留四块」，本文把它落到字段级。

---

## 0. 结论（先看这六条）

1. **页面是只读渲染器 + 动作触发器，永远不当第二份状态真相**（交付计划 P0-3 的原话）。
   所有状态必须来自 CLI 的 JSON 输出或落盘工件；页面自己算出来的「进度」「是否登录」一律不算数。
2. **账号体检按「浏览器 profile」分组，不按平台分组**。一个 profile 只能是一个淘宝身份，
   所以页面上必须是两列（甲＝买家浏览器、乙＝商家浏览器），每列各自亮灯、各自检查、各自重登。
   跨列检查会得到「已登录」而实际登的是另一个账号（`ACCOUNT_MISMATCH` 要拦的正是这个）。
3. **「开始」之前必须先探队列**。`READY / EMPTY / WAITING_HUMAN` 三种结果必须给三种不同的脸 ——
   「今天没活」不是失败，「等你扫码」也不是失败。现有 `capability-scheduler.mjs` 已经是这套语义。
4. **进度用「阶段清单」表达，不用百分比**。等人工扫码时百分比毫无意义；
   而阶段清单在数据上是有依据的（FAQ 链的 8 个阶段是现成的，其它链要补）。
5. **登录成功后自动续跑 —— 这一步我们比 `E:\小红书` 多。** 它扫码成功只 upsert 账号，
   发布失败只落 `publish_error` 等人工重发；我们要把「登录完成 → 恢复被暂停的那一步」做成闭环。
   代价是必须在**开登录窗口之前**先落「恢复点」，否则中途死掉就丢失续跑依据。
6. **三个前置缺口**（不补则这套交互只能在 FAQ 一条链上跑通）：
   ①体检的状态词表只实现了一半（`ACCOUNT_MISMATCH`/`AUTH_EXPIRING`/`AUTH_UNKNOWN` 尚在文档里）；
   ②日报链目前**完全没有**登录态判定；③运行内核 `runtime/sop-runtime/` 还没有生产调用方。

---

## 1. 现实起点：先对齐事实，否则设计会架在空气上

### 1.1 账号体检：骨架是对的，但只覆盖了两个平台

`runtime/xws-sku-auth-preflight.mjs`（407 行）已经结构正确，可推广，**不需要重写**
（接线点清单见 `LOGIN-STATE-MANAGEMENT.md` §6）。现状：

- 判定方式：CDP 注入 `PAGE_EXPRESSION`（`:139-165`），读**可见弹窗文案** + `location.href` 的 `id`
  + `#xws-detail-tool` / `.xws-sku-preview` 是否存在。不截图、不猜。
- 代码里**实际只有 5 个状态**（`:167-184`）：`SOURCE_MISMATCH` / `AUTH_REQUIRED` /
  `PLUGIN_UNAVAILABLE` / `PLUGIN_NOT_READY` / `AUTH_READY`，另有兜底 `UNKNOWN`。
- 结果是两份东西：`xws-sku-auth-status-<runId>.json`（`buildAuthStatus`，只有英文 `reason`）
  与 `xws-sku-operator-alert.json`（`buildOperatorAlert`，**唯一带 `action` 人话的地方**）。
- 退出码：`2=HUMAN_REQUIRED`、`3=STALLED`（`:401-408`）。

**意味着**：界面上「红了 + 下一步做什么」这句话，只能从 **alert 文件**取；
status 文件里有原因、没有动作。二者缺一，界面就会退化成只报状态码（§4 硬规则 2 明令禁止）。

另外两份现成的体检实现，语义与它不同，界面要能表达三种**不同**的坏法：

| 实现 | 位置 | 坏法 |
| --- | --- | --- |
| 飞书网页 | `runtime/feishu-ui-preflight.mjs:81-85` | `FEISHU_CAPTCHA_REQUIRED` / `QR_REQUIRED` / `SMS_REQUIRED` / `SECURITY_CHALLENGE` / `LOGIN_REQUIRED` → `BLOCKED` + `reasonCode`（`:97`） |
| 灰豚 | `run-huitun-topic-heat.mjs:304-321` | 一个 `riskPattern` 正则打出 `humanRequired`；`waitForAccount` 只等 10 秒（`:333-344`） |
| 生意参谋搜索排行 | `export-search-rank.mjs:275-293` | 读 DOM 文案 → 抛 `humanRequired` |

而 `skills/sycm-alimama-daily-report/scripts/`（日报主链）**一处登录判定都没有**（全目录 grep 0 命中；
注意它的搜索排行子步骤属于另一个 skill `sycm-export-search-rank`，那个是**有**判定的，见上表）。
这是「灯全绿但跑到一半卡住」的根因：**体检的覆盖面 ≠ 实际会卡住的面**。

### 1.2 启动 SOP：内核没有生产调用方

- `runtime/sop-runtime/` 有 32 个模块、22 个测试文件，`two-stage-runner.mjs:83 runTwoStage(...)`
  与 `capability-scheduler.mjs` 都带 CLI，但**全仓库没有任何业务脚本 import 它们**，
  引用只落在各 skill 的 `tests/` 与文档的 CLI 示例里。
- 真正在跑的是各链自己的脚本：`run-faq-operator.mjs --advance`、`run-weekly-pre-ai.mjs`、
  `run-daily-report.mjs`、`run-adaptive-export.mjs`。
- `run-faq-operator.mjs` 是**唯一**已经具备「可停、可续、一次一阶段」范式的入口（§3 会说明它为什么适合当模板）。

**所以「启动 SOP」要分两期接**（§4.4）：一期接既有 CLI（现在就能做），
二期在内核有了真实调用方之后接 `two-stage-runner`。

### 1.3 观察进度：没有统一的「运行清单」

全仓库有 **5 个互不隶属的 manifest 概念**（证据工件 manifest、FAQ 采集清单、SKU 干跑清单、
两段式收据、技能注册表），**没有一个统一入口**。`run-status.json` 也不是全局状态，
它只存在于 `runtime/question-library-collection/<period>/<商品ID>/run-status.json`
（`record-faq-qa-evidence.mjs:85-95`，`version: faq-run-status-v1`，且商品级）。

**所以界面不能假装有一个统一运行清单。** 正确做法：§5.1 那张「界面元素 ← 真相源」的对照表，
先逐链适配；等三期再做统一聚合层，且聚合层只能是**只读投影**。

---

## 2. 页面结构（五块）

```
┌──────────────────────────────────────────────────────────────────┐
│ ① 今天                                                           │
│   今天该做什么 · 上次跑完是什么时候 · 结果在哪（飞书表链接）        │
│   数据来自 round-runner --show-plan 的 PLAN_REPORT_FIELDS         │
│   （due / triggerAt / nextTriggerAt / windowKey / businessKey）   │
├──────────────────────────────────────────────────────────────────┤
│ ② 账号体检（按浏览器分组，两列不能合并）                            │
│  ┌─ 甲 = 买家浏览器（9222 / 3457）─┐ ┌─ 乙 = 商家浏览器（19022/19023）┐│
│  │ 环境灯：Edge ✓  代理 ✓  配置 ✓ │ │ 环境灯：Edge ✓  代理 ✓  配置 ✓ ││
│  │ ▢ 淘宝买家号        AUTH_READY │ │ ▢ 生意参谋        AUTH_READY  ││
│  │ ▢ 小旺神插件        PLUGIN_…   │ │ ▢ 阿里妈妈        AUTH_UNKNOWN││
│  │                                │ │ ▢ 千牛/卖家工作台（预留，灰） ││
│  │                                │ │ ▢ 飞书网页        AUTH_READY  ││
│  │                                │ │ ▢ 灰豚            AUTH_REQUIRED│
│  └────────────────────────────────┘ └───────────────────────────────┘│
│   [全部检查]  每张卡右侧 [重新登录] / [我已完成，重新检查]            │
├──────────────────────────────────────────────────────────────────┤
│ ③ 启动                                                            │
│   路线 ▾（7 条，来自 ROUTES）· 周期/日期 ▾ · [预览这次会做什么]      │
│   预览：队列状态 · 预计动作 · 会写哪些外部系统（副作用清单）          │
│   [开始] ← 已有活跃运行时此键变成 [查看当前运行]                    │
├──────────────────────────────────────────────────────────────────┤
│ ④ 进度（阶段清单，不是百分比）                                     │
│   体检 → 探队列 → 采集 → 验证 → 发布 → 回读    当前：采集（已 4 分钟）│
│   证据链接 · 本次运行唯一键 · [继续] / [放弃本轮]                   │
├──────────────────────────────────────────────────────────────────┤
│ ⑤ 需要你做的事（空则整块隐藏）                                     │
│   「灰豚需要扫码+拼图验证」[打开登录窗口] ·「本次写入结果未知，需对账」│
└──────────────────────────────────────────────────────────────────┘
```

五块与交付计划 §2.2 的「四块」对应关系：②③④ 是原「账号体检 / 一键按钮 / 状态卡」拆开后的
可操作形态，⑤ 由「修复与求助」演进（拆出「系统能自动修」与「只能人来做」两类）。

---

## 3. 统一登录页的交互规格

### 3.1 分组：按浏览器 profile 分组（继承 `runtime/browser-ports.mjs`）

页面的分组**不允许硬编码**，必须从登记表读：`BROWSER_LABELS`（显示名）、`BROWSER_ACCOUNT`
（这个 profile 必须是什么身份）、`routesOnBrowser()`（它承载哪几条路线）、
`PROJECT_PORTS`/`BROWSER_PROFILES`（环境灯要查的端口与配置路径）、
`ROUTES[*].sites`（每张卡是哪几个站点）。

每条链的账号卡归哪一列，**由它自己的 `browser` 字段决定**，不由「谁先开的浏览器」决定。
启动器 `runtime/start-project-browser.mjs` 已经在做同一件事的一句话版
（`账号=buyer 插件=小旺神 路线=competitor…`），界面上的分组标题可以直接用
`describeBrowserRoutes(key)` 的字符串，保证**页面、启动器、登记表三处同一口径**。

### 3.2 一张账号卡的字段契约

| 界面元素 | 取值来源 | 备注 |
| --- | --- | --- |
| 卡标题（账号名） | `ROUTES[*].label` 的站点名 + 平台名 | 用可读名，**不出现端口号之外的编号** |
| 所属 profile | `BROWSER_LABELS[key]` | 必须显示，因为检查要在它上面跑 |
| 灯（状态） | 见 §3.3 的状态词表 | 五色：绿/黄/红/灰/蓝 |
| 人话原因 | `buildAuthStatus.reason` **或** `buildOperatorAlert.reason` | status 文件只有英文 reason，故优先取 alert |
| 下一步做什么 | `buildOperatorAlert.action` | 只有 alert 文件有；没有就显示「需要重新检查」 |
| 检查时间 | `checkedAt` | 超过陈旧阈值（建议 30 分钟）要显示「可能已过期」 |
| 证据链接 | `evidence.authStatusFile` | 点开是那次检查的原始 JSON |
| 按钮 | 按状态映射（§3.4） | 不允许「一个按钮走天下」 |

**灰灯（未检查/预留）**：`sellerWorkbench`（千牛）在仓库内没有调用方，
它的卡必须是灰的并写明「预留」，**不许显示成绿灯**——假绿灯比红灯危害大。

### 3.3 「检查」的触发与返回

- 触发：手动点（一次只读探针）。**不做后台自动轮询**：L3 端到端层每轮只跑一次且失败不重试
  （`LOGIN-STATE-MANAGEMENT.md` §3 末），自动轮询就是风控加速器。
- 分组执行：选中一列 → 按该列的顺序串行跑（同一个 profile 上并发多个 CDP 动作会互相抢焦点）。
  「全部检查」＝ 两列各跑一遍，**两列之间可以并行，列内不并行**。
- 每张卡返回统一形状（由体检 CLI 的 stdout JSON 决定，页面只渲染）：

```json
{
  "ok": true,
  "accountKey": "merchant:sycm",
  "profileKey": "dailyReport",
  "status": "AUTH_READY",
  "reason": "…人话…",
  "action": "…下一步做什么…",
  "checkedAt": "2026-09-16T…Z",
  "evidencePath": "evidence/…/xws-sku-auth-status-…json"
}
```

- 失败也要给形状：拿不到结论 = `AUTH_UNKNOWN`（**fail-closed，不放行**），
  不是「假装绿」。这条是现有实现里**缺的**：代码里只有兜底 `UNKNOWN`，没有进状态词表。
- 退出码只作为「这次检查有没有跑完」的信号，不作为状态：`2`/`3` 时页面照常读 JSON。

### 3.4 「重新登录」的交互与状态机

沿用并扩展 `LOGIN-STATE-MANAGEMENT.md` §4 的词表；**动作按状态映射，不给统一按钮**：

| 状态 | 灯 | 页面给什么按钮 | 点下去发生什么 |
| --- | --- | --- | --- |
| `AUTH_READY` | 绿 | 无 | — |
| `AUTH_EXPIRING` | 黄 | [重新登录]（可选） | 同 `AUTH_REQUIRED`，但**不阻断本轮** |
| `AUTH_REQUIRED` | 红 | **[打开登录窗口]** | 开可见 Edge 到该平台登录页 → 等扫码 → 轮询同一套判据 |
| `ACCOUNT_MISMATCH` | 红 | **[换个账号登录]** | 同上，但先明确提示「现在登的是 A，需要 B」 |
| `RISK_BLOCKED` | 红 | **[我去浏览器里完成验证]** + [我已完成，重新检查] | **不开自动化、不绕**（§6 边界） |
| `PLUGIN_UNAVAILABLE` / `PLUGIN_NOT_READY` | 红 | [重开这个浏览器] | 预算内自愈一次，仍失败升级 |
| `AUTH_UNKNOWN` | 灰 | [重新检查] | 连续 N 轮 UNKNOWN 才升级为强通知（平台改版早期信号） |
| `SOURCE_MISMATCH` | 蓝（非账号问题） | 无 | 属流程参数问题，记证据按缺陷处理 |

**登录会话对象**（抄 `E:\小红书` 的 `login_session`，`LOGIN-STATE-MANAGEMENT.md` §5.3）：

```
loginSession = {
  id, accountKey, profileKey,
  status: 'pending' | 'scanned' | 'expired' | 'confirmed' | 'cancelled',
  openedAt, expiresAt, url,
  waiter: { runId, stage, resumeAction } | null,   // ← 我们的增量：恢复点
  evidence: { openedBy, confirmedAt }
}
```

三条硬约束：

1. **单飞闸**：同一 `accountKey` 同时只允许一个 `pending` 会话。否则运营连点两次会开出
   两个**同一个 profile** 的 Edge —— profile 被占用时第二个要么失败要么抢焦点，是「点击都成功、
   结果不是你要的」那一类故障。
2. **先落恢复点，再开窗**：`waiter.resumeAction` 必须在 `spawn` 可见窗口**之前**写进库。
   顺序反了的话，进程在「窗口已开、还没记」这个窗口期死掉，续跑依据就丢了。
3. **窗口不是自动关的**：确认成功后由系统关（避免运营以为还要手动关），
   但**关窗动作失败不许影响恢复流程**——先恢复运行，关窗失败只记日志。

### 3.5 三条不许破的规则

1. **不代填凭据、不绕验证码**（README 非目标 + `LOGIN-STATE-MANAGEMENT.md` §8）。页面只负责
   「把窗口摆到人面前」和「把人做完的事验证一遍」。灰豚明确需要扫码+拼图，自动化不可绕过
   （`runtime/daily-report-2026-09-13.md:94`）。
2. **检查失败不自动重试登录**。重试是风控的加速器。页面上「重新检查」是人工动作。
3. **恢复必须重新体检，不许信任「用户说登好了」**。只有 L1+L2+L3 全过才继续跑；
   否则留在暂停态并提示。这一步和「去重/恢复成对」是同一条资产：
   `persistAlert` 去重（`delivery.status=DEDUPED`）+ `resolveAlert` 补一条「已恢复」。

---

## 4. 启动 SOP 的交互规格

### 4.1 入口：路线 → 周期 → 预览 → 开始

四个控件，全部**取值来自代码里已有的真值**，页面不提供自由填写的输入框：

| 控件 | 取值来源 |
| --- | --- |
| 路线 | `ROUTES`（7 条，含 `label`）；`browser: null` 的路线要在界面上注明「不开浏览器」 |
| 周期/日期 | 该链自己的周期约定（周更＝`YYYY-MM-DD_YYYY-MM-DD`；日更＝单个日期） |
| 预览 | 只读探针 + dry-run，见 §4.2 |
| 开始 | 有活跃运行时按钮换形态，见 §4.3 |

**默认值即目标**（坑 35）：日期默认必须是「该链惯用的那个」（日更＝昨天、周更＝本周），
而且界面上要把**实际会用的日期明文显示出来**，不能让运营以为自己在选。

### 4.2 「开始」之前必须先探队列，三种结果三种脸

现成语义直接映射自 `capability-scheduler.mjs:37` 与 `:42-48`：

| 队列状态 | 页面 | 后端 outcome | 退出码 |
| --- | --- | --- | --- |
| `READY` 有活 | 「有 N 条待处理 → [开始]」 | `RAN` / `PROBED_ONLY` | 0 |
| `EMPTY` 没活 | 绿字「今天没有需要处理的，本轮跳过」，**按钮置灰但不算失败** | `SKIPPED_EMPTY_QUEUE` | 0 |
| `WAITING_HUMAN` 等你 | 黄字 + 进 ⑤ 区：「需要你先完成 XX」 | `PAUSED_FOR_HUMAN` | 3 |
| `UNAVAILABLE` / 探测失败 | 灰字「探测不出结论」+ [重试探测] | `PROCEEDED_WITHOUT_PROBE`（fail-open，见该文件 `:12-15`） | 2 |

**这一节是整套交互里最容易做错的地方**：把 `EMPTY` 渲染成失败，运营就会开始乱点；
把 `WAITING_HUMAN` 渲染成失败，运营就会去「重试」一个本来在等他扫码的流程。
预览还必须显示**副作用清单**（`manifest.sideEffects`，外部写集合的唯一清单在 `policy.mjs:27`），
让运营在点之前知道「这一步会写飞书」。

### 4.3 防重与幂等：按钮的第二形态

- 车道上限是硬事实：`policy.mjs:87 DEFAULT_LANE_LIMIT = 1` —— 同一条链同时只能有一个运行。
- 所以：**该链已有活跃运行时，[开始] 必须变成 [查看当前运行]**，并且
  「再次点击开始」在后端要被 `buildIdempotencyKey`（`task-admission.mjs:21`）判成同一次任务
  而不是第二次执行。页面不许自己判断「有没有在跑」，只渲染后端给的结论。
- 活跃 run 的判定不吃「进程还在不在」，吃 `run-liveness.mjs` 的结论：
  `LEASE_HELD`（活着）/ `LEASE_EXPIRED`（可能死了）/ `WAITING`（**合法等待，不是死了**，
  含 `PAUSED`）/ `ABANDONED_QUEUE`。这一点必须在页面上区分开，否则运营会把「等人扫码」
  当成卡死然后强杀。

### 4.4 两期接线

**一期（现在就能做）**：把 `run-faq-operator.mjs` 的范式推广成「每链一个 operator CLI」。
它的三条性质正好是界面需要的：`--status` 只读体检、`--advance` **一次只推进一个阶段**、
状态落 `runtime/faq-analysis/<period>/operator-status.json`（`:318-322`）。
推广到日报/周更/竞品 = 给每条链补一个 `inspectXxxState()` + `persistStatus()`，
界面统一读 `operator-status.json` 这一族文件。

**二期**：内核有了真实调用方后，界面改成调 `two-stage-runner --capability=…`，
直接拿到 `two-stage-receipt.json`（`:265-294`，含 `gate`/`collect`/`publish`/`publicationStatus`/
`nextAction`/`cursorAdvanced`）与调度收据的 `SCHEDULE_RECEIPT_FIELDS`（`capability-scheduler.mjs:52-66`）。
**一期不要为了二期提前抽象**：现在给页面加一层「统一运行适配器」是自找维护面。

---

## 5. 观察进度的交互规格

### 5.1 状态真相源表（**这是整份设计里最该被审查的一节**）

页面每个元素只能指向下面某一行，**不许有第二来源**：

| 界面元素 | 真相源 | 谁写 | 陈旧阈值 |
| --- | --- | --- | --- |
| 今天该做什么 / 下次什么时候 | `round-runner --show-plan`（`PLAN_REPORT_FIELDS`） | 排期器 | 计划本身就是未来时，不需阈值 |
| 本轮阶段与结论 | 各链 `operator-status.json`（FAQ 已在用） | 对应 operator CLI | 30 分钟（沿用 `ADMISSION_STALE_AFTER_MS`） |
| 商品级进度（FAQ） | `runtime/question-library-collection/<period>/<商品ID>/run-status.json` | 两个证据写入方，**各只覆盖自己那一路**（`record-faq-qa-evidence.mjs:82-84`） | 30 分钟 |
| 阶段收据 | `runtime/faq-analysis/<period>/*-receipt.json` 等 | 各阶段脚本 | 看该阶段耗时 |
| 是否还有活人 | `run-liveness.assessRunLiveness()` | Controller | 租约 5 分钟 |
| 已发生的不可逆副作用 | `side-effect-ledger`（复用 `supervisor_commit_records`） | 发布段 | `UNKNOWN` 永久有效直到对账 |
| 结果证据 | `evidence-store` manifest（`evidence-manifest-v1`，含 `sha256`/`rowCount`） | 采集段 | 不陈旧，但**必须校验摘要** |
| 卡住的原因与下一步 | `faq-operator-core` 的 `{status, nextAction, blocker}` | operator CLI | 同上 |

### 5.2 阶段清单，不是百分比

FAQ 链已经有 8 个有序阶段（`faq-operator-core.mjs:1-10`）：`LOCK_TOP5` → `COLLECT_EVIDENCE` →
`BUILD_LOCAL_SNAPSHOT` → `ANALYZE_LOCAL` → `RUN_AI_REVIEW` → `REVIEW_AI_HUMAN_QUEUE` →
`BUILD_LOCAL_SUMMARIES` → `PUBLISH_FEISHU_SUMMARIES`。

页面渲染规则：

- 每个阶段四种外观：**已完成 / 进行中 / 未开始 / 跳过**。「跳过」必须有理由
  （例如 `EMPTY` 队列、空发布豁免 `rawRecords === 0 && localSummariesBuilt === true`）。
- 当前阶段 = `nextAction` 对应的那个；`status: DONE` 时整条变绿。
- **顺序不变量不许在页面上重算**。`faq-operator-core` 里「前置未完成就抛错」是唯一判据
  （`:20`），页面只显示它给的结论。页面自己推断顺序 = 第二份真相。
- 其它链一期没有阶段清单：**不许编**。只显示「运行中 / 已结束 / 需要你动手」+ 证据链接，
  并在 §4.4 的一期补 `operator CLI` 时顺手补阶段表。

### 5.3 卡住的四种形态与各自的按钮

| 形态 | 判据 | 页面 | 按钮 |
| --- | --- | --- | --- |
| 等人 | `status: WAITING_HUMAN` / `PAUSED_FOR_HUMAN` / 队列 `WAITING_HUMAN` | 黄条 + 具体要做什么 | [打开登录窗口] / [我已完成，重新检查] |
| 受阻 | `blocker`（`{code, productId, message}`） | 红条：哪个商品、什么原因 | [去处理] + [导出诊断包发给服务商] |
| 可能死了 | `LEASE_EXPIRED` | 灰条 | [确认已停止并回收]（**必须人点**，见下） |
| 结果未知 | 账本 `UNKNOWN` | 黄条 + 大字「**不许重试**」 | [去对账]（`reconcileUnknown` 只回读、永不直接重写） |

「可能死了」为什么必须人点：`run-liveness.mjs` 把「死了吗」和「回收安全吗」拆成两个问题，
回收还要过 `assessReclaimSafety` 的 `PUBLICATION_IN_FLIGHT` / `COMMIT_STATE_UNKNOWN` 闸门
（`:90-109`）。界面**不许把 `PAUSED` 当死运行自动回收**（该文件 `:11` 明写）。

### 5.4 登录成功后的自动续跑（我们比 `E:\小红书` 多出来的那一步）

`E:\小红书` 没有这套东西：确认登录后只 upsert 账号，发布失败只落 `publish_error` 等人工重发。
我们要补的闭环：

```
① 体检出 AUTH_REQUIRED（该链正处于 PAUSED，waiter.resumeAction 已落库）
② 页面 [打开登录窗口] → 建 loginSession(pending) → 开可见窗口
③ 运营扫码 → 轮询同一套判据（不是轮询「有没有扫码」）
④ 判据全过 → loginSession=confirmed → 补一条「已恢复」通知
⑤ 执行 waiter.resumeAction（= 该链 operator CLI 的 --advance 那一步）
⑥ 重新体检并刷新整页；失败则回到 ① 并保留红灯（不静默重试）
```

第 ⑤ 步之所以要复用 `--advance`：它本身就是**幂等**的
（先体检 → `nextAction` → 只跑一个阶段 → 再体检，`run-faq-operator.mjs:324-345`），
所以「续跑被点了两次」不会重复执行。若把续跑实现成「重跑整条链」，就会重复采集、
重复写外部系统 —— 这是本设计里唯一会造成数据事故的地方。

超时（建议与二维码有效期一致，暂定 5 分钟）→ `loginSession=expired`，红灯不变，
通知「仍然没登录成功」，**不自动重开窗口**。

---

## 6. 缺口清单与最小可做切片

按「不做完它，这套交互就只能在 FAQ 一条链上跑通」排序：

| 序号 | 缺口 | 现状证据 | 做什么 |
| --- | --- | --- | --- |
| G1 | 体检状态词表只实现一半 | 代码只有 5 个状态（`xws-sku-auth-preflight.mjs:167-184`），`ACCOUNT_MISMATCH`/`AUTH_EXPIRING`/`AUTH_UNKNOWN` 只在文档 §4 | 扩 `classifyAuthSnapshot`，加身份判据与「无结论」路径 |
| G2 | 日报链无登录判定 | `skills/sycm-alimama-daily-report/scripts/` grep 0 命中 | 补生意参谋/阿里妈妈两段判据（否则灯绿着卡死） |
| G3 | 登录会话对象不存在 | 只有「体检快照」，没有「一次登录过程」 | 落表 + 单飞闸 + 恢复点字段（§3.4） |
| G4 | 运行内核无生产调用方 | 只有 tests/import | 一期不必解决；用 §4.4 一期的 operator CLI 顶上 |
| G5 | 除 FAQ 外没有阶段清单 | 没有统一运行清单，5 个 manifest 各自为政 | 随 G6 一起补 |
| G6 | 除 FAQ 外没有 `operator-status.json` | 只有 `runtime/faq-analysis/<period>/operator-status.json` | 每链补 `inspectXxxState()` + `persistStatus()` |
| G7 | L2 会话判据未实测 | `LOGIN-STATE-MANAGEMENT.md` §7 第 1 条：禁止照抄键名 | 真实环境采一次关键键名与到期语义 |

**最小可做切片（建议第一步，只做这一条链）**：
用 FAQ 链把 ②③④⑤ 四块跑通 —— 它是唯一同时具备「有序阶段 + `--status`/`--advance` + 落盘状态」
的链。做通之后，②③④⑤ 的交互与字段就都被真实验证过一次，
再把 G6 按链复制，而不是先抽象出一个「通用运行适配器」。

**验收判据（不是「页面能打开」）**：
1. 把甲列的会话人为登出 → 页面甲列变红且**乙列不受影响**（证明分组真的分开跑）；
2. 故意不登录运行 FAQ → 页面显示黄条「等你扫码」而不是「失败」，且 [开始] 变成 [查看当前运行]；
3. 完成扫码 → 无需人手再点一次「开始」，阶段自动从暂停处继续（§5.4 的闭环）；
4. 全程页面显示的每个状态，都能在 §5.1 表里找到它读的那个文件（**取不到就显示灰，不许显示绿**）。

### 实施状态（2026-09-16，别把这份设计读成「还没做」）

- **已做**：§2 五块 / §3.1 按 profile 分组 / §5.1 状态真相源表 / §5.2 阶段清单 /
  §6 的最小切片（FAQ 链）。G1 的 `ACCOUNT_MISMATCH` 与 `AUTH_UNKNOWN` 已进代码（`AUTH_EXPIRING` 还没）。
  §4.1 的「路线 → 周期 → 预览 → 开始」做成了 `preview-faq` / `advance-faq` 两个真动
  （见 `runtime/operator-console/README.md`），但**一次只推一格**，不是「一路跑到底」。
- **没做**：§3.4 的重新登录状态机、§4.2 的队列探针（`QUEUE_PROBE_NOT_WIRED`）、
  §4.3 的按钮第二形态、§5.4 的自动续跑、G2（日报链登录判定）、G6（其它链的 operator CLI）。
- 判「按钮能不能点」的规则变了：一期是「全部不可点」，现在是「只有登记过的动作可点，
  其余一律 disabled 并写明缺什么」。这条落地后，§4.4「两期接线」的说法以 README 为准。

---

## 7. 不做的事

- **不做云端后台**（交付计划 §2.1）：本地控制台 + 托盘。
- **不做账密代登、不绕验证码与风控**（`LOGIN-STATE-MANAGEMENT.md` §8）。
- **不把界面做成第二个配置入口**：路线、端口、表 id 一律从 `runtime/browser-ports.mjs` /
  `runtime/feishu-targets.mjs` 读，页面上不许出现可编辑的这类值（默认值即目标，坑 35）。
- **不为「未来可能的多店铺」提前抽象**：单机单店铺，车道恒 1。
- **暴露 `run-faq-operator.mjs --replace-current`** —— 它解析后没有任何下游读取，是死开关。
  要么先实现，要么从帮助文本里删掉，别让运营点一个没反应的键。
