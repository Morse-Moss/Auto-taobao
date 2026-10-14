# 修复 agent 报告 —— 网林淘宝（目标日 2026-10-13）

- 角色：第二层「后台修复 agent」（repair-agent-1013）
- 店：**网林淘宝**｜代理：`http://127.0.0.1:19060`（登记表 `shopInstance('网林淘宝').proxyPort`，与请求单 `execHint` 一致）
- 阶段：`readback`（第 11 步）｜成因：`STAGE_FAILED`｜候选：`REAPPLY_DATES` / `RELOAD_PAGE`
- 证据目录：`evidence/batches-2026-10-13/b2/网林淘宝/`
- 仓库基线提交：`13009d4660dcb1821f69af266fc0c166f3f49f22`（1.8.14，2026-10-13 21:09 +0800）
- 是否改仓库代码：**没有**（因此无 `97-repair-agent-code-diff.patch`）
- 最终结论：**救回**（readback 重试退出码 0；底单该行 `reczz28N92FCBVnE` 经两条独立通路确认仍在）

---

## 0. 一句话结论与因果声明（先读这一段）

**结论＝救回**：只重试第 11 步 `readback` → **exit 0**；底单 2026-10-13 共 8 行，`reczz28N92FCBVnE（网林全卫定制）` 仍在（CDP 页面模型 + OpenAPI 各确认一遍）。

**因果声明（不许含糊）**：本次救回**不能归因于**我执行的修复动作。理由是本报告第 3 节的实测——
本店候选动作 `RELOAD_PAGE` 只能定位到**店铺实例 19060 里的店铺标识页**，
而失败那一步 `readback` 用的是**共享日报浏览器 19023 上的飞书底单页**（`--proxy` 是唯一的实例选择器，
两者对不上时脚本自己会停手）。即：**框架能对我执行的这个动作，动不到真正出问题的那一页**。
真正的恢复原因是：失败是**共享飞书页在那一刻不在目标 base 上**这一瞬时状态，
重试时该页已恢复（第 5 节只读回读为证）。这属于「重试即恢复的瞬时故障」，不是「某动作修好了它」。
详见第 6 节的根因分析与建议。

---

## 1. 原始失败现场（以请求单 `cause`/`stage` 为准）

`evidence/batches-2026-10-13/b2/网林淘宝/11-readback.txt`：

```
$ node .../readback-daily-report.mjs --date 2026-10-13 --proxy http://127.0.0.1:19023 --shop-key 网林淘宝
exit=1
Error: expected one Feishu page for target base, got 0
    at discoverFeishuPage (.../readback-daily-report.mjs:104:35)
    at async main (.../readback-daily-report.mjs:338:16)
```

- 请求单：`cause=STAGE_FAILED`、`stage=readback`、`retryStage=readback`、`candidates=[REAPPLY_DATES, RELOAD_PAGE]`、`stageHint=null`。
- `readback-daily-report.mjs:338` 是 `main()` 的第一件事：`const page = await discoverFeishuPage(args);`
  （`:101-106`）。它要求**该浏览器里恰好有一个 URL 含 `/base/<appToken>` 的页面**，否则抛错。
  ⇒ 失败含义＝「回读那一步在浏览器里找不到飞书底单那个页签」，**不是日期问题、也不是这家店没写进去**。
- ⚠️ 感知层已知缺陷：`98-failure-state.json` / `.txt` / `.png` 拍的是**生意参谋页**
  （`sycm.taobao.com/.../performance/new#/shop`，那是**店铺实例 19060** 的页面），
  不是失败那一步真正用的飞书页。按指导书口径：**一律以请求单的 `cause`/`stage` 为准**，截图只当辅助。
- 旁证（数据已写入，不用重推）：
  - 本批 `07-push.txt` = `exit=0`，`recordId=reczz28N92FCBVnE`，`status=COMMITTED_AND_VERIFIED`；
  - 驻留自动重跑 `b1/网林淘宝/07-push.txt` 撞的 `duplicate daily report row exists: reczz28N92FCBVnE`
    是**去重闸门在正确工作**，不是故障；本报告**未删除、未改动**这一行。

---

## 2. 时间线（每步命令 + 每步回读）

时间为 UTC（`Z`），本机本地时间 = UTC+8。所有 `curl` 均为**只读**。

### 2.0 第 0 步：实例不在 ⇒ 先只为这一家拉起（硬要求，未跳）

- 回读 1（判据命令，来自请求单 `instancePrecondition.checkCommand`）：
  ```
  curl -s -m 5 http://127.0.0.1:19060/targets   → EXIT=7（连接失败）
  ```
  ⇒ **实例不在**（与本派单事实 3 一致：`--batches` 每批释放，失败那家也在释放名单里）。
- 起（**幂等**、只拉起一个**已经不在**的实例；不碰任何存活进程）：
  ```
  node scripts/start-all-hold.mjs --only 网林淘宝
  ```
  回读（start-all-hold 自报）：
  ```
  · 网林淘宝  起前:missing  两样都没有，起一整套
      已起 browser pid=143104  ...
      已起 proxy   pid=119208  ...
      起后:ready
  [hold] start-all 已就位，开始托住
  ```
- 端口在听（`Get-NetTCPConnection`，**读两遍**，两遍一致）：
  ```
  read 1: 127.0.0.1:19050 Listen pid=147272 | 127.0.0.1:19060 Listen pid=119208
  read 2: 127.0.0.1:19050 Listen pid=147272 | 127.0.0.1:19060 Listen pid=119208
  ```
- 只读回读实例现状 `curl -s -m 5 http://127.0.0.1:19060/targets`：
  窗口里**只有标识页** `file:///.../runtime/shop-window-label.html?...port=19050`（1 个页签）。
  ⇒ 冷启动没恢复上一轮的 sycm/alimama 页（与 10-07 网林家居那次同形）。

### 2.1 第 1-2 步：读请求单与失败现场

- `97-repair-request.json`：`cause=STAGE_FAILED` / `stage=readback` / `retryStage=readback` / 候选＝`REAPPLY_DATES`、`RELOAD_PAGE`。
- `98-failure-state.*` 与 `.png`：内容为生意参谋页（感知层拍错页的已知缺陷）⇒ 只当辅助，不作判据。
- 关键旁证（`b2/summary.json` 里 `autoRepair` 字段，**脚本自己**已经跑过一遍修复回环）：
  | 轮 | 动作 | applied | detail |
  |---|---|---|---|
  | 1 | `REAPPLY_DATES` | `false` | 找不到要修的那一页：没有阶段页提示、且窗口里有 4 个页签 ⇒ 不猜要修哪一页 |
  | 2 | `RELOAD_PAGE` | `false` | 同上 |
  ⇒ 脚本侧「自修没救回来」＝`gaveUp: 候选动作已全部试过`，这才转到我这一层。**注意当时的判据是「4 个页签」**。

### 2.2 只读核对：失败那一步真正用的是哪台浏览器

- `run-multi-shop-day.mjs:1295-1297`（`buildShopStages`）：
  `add('readback', 'readback-daily-report.mjs', ['--date', date, '--proxy', dailyProxy, '--shop-key', shopKey], dailyEnv, ...)`
  其中 `dailyProxy = http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}` = **19023**（`:1214`）。
- ⇒ `readback`（第 11 步）与 `push`（第 7 步）跑在**共享日报浏览器 19023**；
  采集类阶段（alimama-date/shop-report/backfill/…）才跑在**店铺实例 19060**。
- `readback-daily-report.mjs:101-106` 的 `discoverFeishuPage` 只从 `--proxy` 那台浏览器找页；
  **它不像 push 那样自己落位**（对比 `run-daily-report.mjs:149 ensureTargetPage`，push 会主动把共享页导航回源表）。
- 只读回读 19023 现状（**重试前置条件的第一次读数**）：
  ```
  page | https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop
  page | https://kcne618basvj.feishu.cn/base/RjKcb3isDaVn1GsoVJfc7Ykknyg?table=tblIuAX4nPc1zDOO&view=vewwg0rhjo
  ```
  `RjKcb3isDaVn1GsoVJfc7Ykknyg` 正是 `runtime/feishu-targets.mjs:83` 登记给 kcne 日报链的 `baseToken`
  ⇒ **目标 base 上恰好一个页**，`discoverFeishuPage` 的前置条件此刻成立。

### 2.3 第 3 步：挑动作（依据，不猜）

候选闭集只有 `REAPPLY_DATES` 与 `RELOAD_PAGE`（`repair-actions.mjs:81`：`STAGE_FAILED → [REAPPLY_DATES, RELOAD_PAGE]`）。

- 我**不**挑 `REAPPLY_DATES`：本店故障是「**回读时找不到飞书底单页签**」，与日期筛选无关；
  且 `runReapplyDates`（`repair-shop-stage.mjs:259-271`）按实现**永远返回 `applied:false`**（它只是「请你重试落位阶段」的信号动作）。
- ⇒ 我挑 **`RELOAD_PAGE`**：它的语义是「**换个新现场**」（`REPAIR_WHY`：这一份渲染上元素不理会点击…真重载换个新现场再试），
  与「现场状态不对」这一类事实最贴。

### 2.4 第 4 步：先排练、再真跑（`repair-shop-stage.mjs`）

排练（`--dry-run`，一个写请求都不发）：
```
node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 网林淘宝 \
  --proxy http://127.0.0.1:19060 --stage readback --cause STAGE_FAILED \
  --action RELOAD_PAGE --log-dir evidence/batches-2026-10-13/b2/网林淘宝 --dry-run
```
回读：
```
[修复] 目标页 = file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=%E7%BD%91%E6%9E%97%E6%B7%98%E5%AE%9D&port=19050
[修复] ❌ 未应用：排练（--dry-run）：会执行 RELOAD_PAGE 于 <店铺标识页>，一个写请求都不发
```
⚠️ **排练当场暴露了问题**：`RELOAD_PAGE` 定位到的「目标页」是**店铺标识页**，**不是**失败那一步用的飞书底单页。
原因链（两条都是硬事实）：
1. `--proxy http://127.0.0.1:19060` 指店铺实例，而失败页在 19023（见 2.2）；
2. `STAGE_PAGE_HINT`（`repair-actions.mjs:90-99`）**没有 `readback` 这一条** ⇒ `planRepair` 给的 `stageHint=null`
   ⇒ `locateStagePage`（`repair-shop-stage.mjs:129-147`）在「没有阶段提示」时只接受「窗口里恰好一个非 `about:` 页」，
   而店铺实例此刻恰好只有标识页 ⇒ 它就返回了标识页。

真跑（去掉 `--dry-run`）：
```
[修复] RELOAD_PAGE｜网林淘宝@http://127.0.0.1:19060｜阶段 readback
[修复] 目标页 = file:///.../shop-window-label.html?...port=19050
[遮挡] 已重载页面（网林淘宝 · 日报采集窗口）—— 在新现场上再走一遍
[修复] ✅ 已应用：页面已重载并就绪      EXIT=0
```
证据：`97-repair.json` / `97-repair.txt`（脚本自己写，`applied:true`、`targetUrl=<店铺标识页>`、`before.readyState=complete`）。
⇒ **动作落地了（`applied:true`），但它作用的是店铺标识页，动不到飞书底单页** ⇒ 见第 0 节的因果声明。

### 2.5 第 5 步：只重试 `readback` 这一步（与原始失败同形，便于对照）

重试前再只读回读一次前置条件 `curl -s -m 5 http://127.0.0.1:19023/targets`：
```
page | https://sycm.taobao.com/.../performance/new#/shop
page | https://kcne618basvj.feishu.cn/base/RjKcb3isDaVn1GsoVJfc7Ykknyg?table=tblIuAX4nPc1zDOO&view=vewwg0rhjo
```
⇒ 与 2.2 一致：目标 base 上恰好一个页（**前置条件成立**）。

重试（**只重试 readback，不整链重跑**；同形命令）：
```
node skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs \
  --date 2026-10-13 --proxy http://127.0.0.1:19023 --shop-key 网林淘宝
```
回读（**exit 0**）：
```
readbackPath = evidence\daily-report-2026-10-13-网林淘宝\independent-readback.json
底单: recordsNum=2279  loaded=2279  命中 2026-10-13=8
询单表: recordsNum=2333  loaded=2333  命中 2026-10-13=8
  ...（8 家店逐行）
页面已留在：https://kcne618basvj.feishu.cn/base/RjKcb3isDaVn1GsoVJfc7Ykknyg?table=tblIuAX4nPc1zDOO&view=vewwg0rhjo
EXIT=0
```

### 2.6 独立回读底单，确认该行仍在（两条通路，各一次）

通路 A —— CDP 页面内存模型（readback 自己落的 `independent-readback.json`，`tables.source`）：
```
at=2026-10-14T04:01:36.590Z  recordsNum=2279 loaded=2279 rowsComplete=true onDateCount=8
reczz28N92FCBVnE | {"统计日期":"2026-10-13","店铺名称":"网林全卫定制","reportDate":"2026-10-13"}
（另有 里可林家居 / 网林家居旗舰店 / 盖文全卫定制 / 盖文旗舰店 / 科塔全卫定制 / 里可林旗舰店 / 网林定制家居，共 8 行）
```
通路 B —— 飞书 OpenAPI 直读（不经浏览器；只读）：
```
OpenAPI 底单总数 = 2279 | 2026-10-13 命中行数 = 8
  reczz28N92FCBVnE | 网林全卫定制
  ...（其余 7 家）
reczz28N92FCBVnE 存在 = true
```
⇒ 两条通路一致：**底单该行仍在**，且 2026-10-13 的 8 家店一行不少。

---

## 3. 试过的候选：applied 与回读结果一览

| 来源 | 动作 | applied | 目标页 / detail | 回读结果 |
|---|---|---|---|---|
| 脚本 autoRepair 轮1（03:40，4 页签） | `REAPPLY_DATES` | `false` | 找不到要修的那一页：没有阶段页提示、且窗口里有 4 个页签 | 未重试阶段 |
| 脚本 autoRepair 轮2（03:40，4 页签） | `RELOAD_PAGE` | `false` | 同上 | 未重试阶段 |
| 本 agent 排练（12:01，1 页签） | `RELOAD_PAGE`（`--dry-run`） | — | 目标页＝**店铺标识页**（非飞书页） | 不发写请求 |
| 本 agent 真跑（12:01，1 页签） | `RELOAD_PAGE` | **true** | 目标页＝**店铺标识页**；`页面已重载并就绪` | 见 2.5 |
| 本 agent 重试阶段 | `readback`（只这一步） | — | proxy 19023 | **exit 0**；底单 8 行、该行仍在 |

- `REAPPLY_DATES` 按设计**永久 `applied:false`**（`runReapplyDates` 只给信号，不自己落位）；本店是页签缺失、不是日期不对，故未在本轮再跑一遍。
- 「动作没落地就不重试阶段」这条纪律**被遵守**：只有 `RELOAD_PAGE` 真跑 `applied:true` 之后才重试了 `readback`。

---

## 4. 最终结论

**救回。**
- 判据 1：只重试第 11 步 `readback` → **exit 0**（2.5）。
- 判据 2：底单 2026-10-13 该行 **`reczz28N92FCBVnE（网林全卫定制）` 仍在**，8 家店齐全；CDP 页面模型与 OpenAPI 两条通路各确认一遍（2.6）。
- 判据 3：数据本来就已写入（`b2/07-push.txt exit=0`），本报告**未对飞书做任何写入**、未删未改那一行。

**但请连同第 0 节的因果声明一起读**：救回的真实原因是「该失败为瞬时、重试即恢复」，
而不是我执行的 `RELOAD_PAGE` 修好了它——`RELOAD_PAGE` 作用在店铺标识页上。

---

## 5. 根因 / 缺口分析（供后续决定要不要改代码；本轮**未改**）

失败的直接成因：**共享日报浏览器 19023 上的飞书底单页，在 03:40 那一刻不在目标 base 上**
（`discoverFeishuPage` 找到 0 个匹配页）。旁证与时间线：

- 03:33:51 第 2 批开始；`03:35:40.952Z` 链启动，`batches.log:1388`
  `[一轮] 归位：本来就在位（生意参谋工作页=1  飞书底单页=1）` ⇒ **那时该页在**。
- `03:36:43Z` 本店 `push` 成功（`run-daily-report.mjs:382` 的 `ensureTargetPage` 会把共享页导航回源表）⇒ 之后该页**在目标 base 上**。
- `03:40:18Z` 本店 `readback` 报 `got 0`。
- 紧随其后的 `里可林天猫`（03:41 起）、`网林家居`（03:45 起）在同一台 19023 上 **readback 全部 exit 0**
  ⇒ 该页在 03:41 之后又**在**了。
⇒ 该页只在**一个很窄的窗口**里「不在」，属**瞬时状态**；保留的证据不足以确定触发者（无 19023 的进程/页签事件留痕）。

暴露出的**框架缺口**（本轮实测，非推测）：

1. **`STAGE_PAGE_HINT` 缺 `readback` 条目**（`repair-actions.mjs:90-99`）⇒ `planRepair` 对 readback 给 `stageHint:null`
   ⇒ 修复动作几乎必然落到「不猜要修哪一页」（4 页签时）或「退化成只有一个页签时的那个页」（1 页签时，如本轮）。
2. **修复动作的实例选择对共享阶段是错的**：`buildRepairRequest` 的 `execHint`（`run-multi-shop-day.mjs:476-478`）、
   `buildInstancePrecondition`（`:383`）与 `execRepair`（`:2227`）一律取 `shopInstance(shopKey).proxyPort`（19060），
   而 `readback`/`push` 跑在 19023（`:1214`、`:1295`）。而且 `resolveProxy`（`repair-shop-stage.mjs:186-197`）
   会**禁止**「`--shop 网林淘宝` + `--proxy 19023`」这一组，于是修复根本**无法指向真正出问题的那台浏览器**。
3. **`readback` 不自愈**：`push` 有 `ensureTargetPage` 主动落位（`run-daily-report.mjs:149`），
   而 `readback` 的 `discoverFeishuPage` 只「找页」不「造页/导航页」，找不到就抛裸错
   `expected one Feishu page for target base, got 0`（`readback-daily-report.mjs:104`）。
   仓库里其实已有更会说话的 `describePageSearchFailure`（`feishu-shared-page.mjs:100`，push 在用），
   但 **readback 这一侧没接上**。
   - 注：`ensureTargetPage` 也要求「目标 base 上已有页」，两边都**没有**「从零开一个飞书页」的能力 ⇒
     若该页真的整只消失，连 push 也会挂 —— 这才是根治点所在。

**建议（不阻塞本次救回）**：① 给 `STAGE_PAGE_HINT` 补 `readback`（乃至 `push`）→ `feishu`，
并让 `locateStagePage` 认识 feishu 主机；② 让「按阶段选代理」这条能力被共享阶段尊重（readback/push → `dailyReportProxy`），
`buildRepairRequest`/`execRepair`/`resolveProxy` 三处同源；③ 把 `readback` 的 `discoverFeishuPage` 接上
`describePageSearchFailure`，并考虑与 push 一样做「落位自愈」。三条都属可独立评审的小改，**本轮为控制影响面未动**。

---

## 6. 边界与偏离交代

- **未改任何仓库代码**（`git status` 无源码改动；仅 `evidence/` 下新增/更新），故无 `96*/97*code-diff.patch`。
- **未改 `.workbuddy/` 下任何东西**。
- **未发飞书告警**（链此前已发过一条 `daily-hold-resume-failed-20261013`；是否再发由主会话决定）。
- **未整链重跑**：未用 `run-daily-job.mjs`（它会从第 0 步起跑、多起实例，且必然在 push 撞预期的
  `duplicate daily report row exists`）；只重试了 `readback` 这一步。
- **实例边界**：第 0 步只拉起了「已经不在」的 网林淘宝（19050/19060）。
  **未碰**任何存活实例：里可林天猫（19051/19061）、网林家居（19052/19062）、共用商家浏览器 19022/19023
  （对 19023 只有只读 `/targets`，无写动作）。**修完未停我起的实例**（按派单：留给主会话/用户决定）。
- **未对飞书做任何写入**：`readback` 是只读＋截图；OpenAPI 那次也是只读 `listRecords`。
