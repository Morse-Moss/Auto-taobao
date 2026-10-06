# 2026-10-06 三件事的取证

1. `escalation-plan.mjs` 的 `--date` 口径统一（本轮唯一的代码改动）
2. 「今天的数据收集完了吗」的答案与三层判据
3. 顺带发现的一处同类缺陷（商品数据告警仍然对业务人员讲术语）

---

## 一、`--date` 口径统一（修「第 ② 层降级静默空转」）

### 缺陷

定时任务 prompt 第 1 步写的是：

```
node runtime/escalation-plan.mjs --date yesterday --json
```

而 `runtime/escalation-plan.mjs` 的 `parseArgs` 只收 `YYYY-MM-DD`：

```js
if (args.date && !/^\d{4}-\d{2}-\d{2}$/u.test(args.date)) return { error: `--date 要 YYYY-MM-DD（收到 ${args.date}）` };
```

⇒ 那条命令**每次都落进「`--date` 要 YYYY-MM-DD」** ⇒ 读不到结论（exit 1）⇒ 三层降级里的
**第 ② 层（唤醒修复 agent）静默空转**。同一处已复现 **4 次**（09-25、09-28、09-29、10-05）。

原始输出：`before-after.txt`（含修前那句报错的原样留档）。

### 修法：口径复用，不新写一份

把 `TARGET_DATE_LITERALS` / `resolveTargetDate` 从驱动 `run-multi-shop-day.mjs`
**搬进叶子** `skills/sycm-alimama-daily-report/scripts/date-picker.mjs`，然后：

- `run-multi-shop-day.mjs`：改成「从叶子里 import 之后**原样转出**」，对外名字逐字不变（原有用例一个字没改）；
- `runtime/escalation-plan.mjs`：import 同一个 `resolveTargetDate`，`--date` 走它解析。

**为什么不能直接 import 驱动**：驱动第 110 行 import 了本模块的 `classifyShopEscalation`
⇒ `run-multi-shop-day.mjs → escalation-plan.mjs → run-multi-shop-day.mjs` **成环**。
成环之后两边都加不进新东西 —— 这正是 `expected-pages.mjs` 当初被抽出驱动的原因，同一套理由。

顺带清掉驱动里已经没人用的 `shiftIso`/`shanghaiToday` import（口径搬走之后它成了死引用）。

### 判据（新增 7 条）

| 文件 | 钉住什么 |
| --- | --- |
| `runtime/escalation-plan.test.mjs` | `--date yesterday` 必须被接受且解析成上海昨日；非法取值给 error；`--summary` 一档不凭空造日期 |
| 同上（源码级） | 必须 import 叶子那个 `resolveTargetDate`；`args.date = resolveTargetDate(args.dateInput, now)` 真的接在解析路径上；**不许出现从驱动 import 的语句**（成环） |
| `date-picker.test.mjs` | 口径确实住在这儿（跨零点不漂、非法取值抛错、闭集只有 `yesterday`） |
| 同上（源码级） | 驱动只转出、不再自己定义（`export function resolveTargetDate` 再长出来就红） |
| `runtime/arch-boundary.test.mjs` | 新的 runtime → skills 依赖要在 `RUNTIME_TO_SKILLS` 里登记并写理由 |

### 修后实测（`before-after.txt`）

```
$ node runtime/escalation-plan.mjs --date yesterday
[派单] 目标日 2026-10-05（--date yesterday）（合并了 2 批结论）｜失败 0 家｜需要修复 agent：否
EXIT=0                       ← 修前是 exit 1 + 「--date 要 YYYY-MM-DD」

$ node runtime/escalation-plan.mjs --date yestoday
[派单] invalid --date "yestoday"：要给 YYYY-MM-DD 或 yesterday
EXIT=1                       ← 写错仍然当场停（不放宽）

$ node runtime/escalation-plan.mjs --date 2026-10-05
[派单] 目标日 2026-10-05（合并了 2 批结论）…   EXIT=0   ← 老用法不回归
```

**定时任务 prompt 不需要改**：它原本写的就是 `--date yesterday`，脚本现在认得它了 ——
这就是「对齐」。（`docs`：无需改 `automations/a11daa89`。）

### 测试

定向 165/165（`escalation-plan` + `arch-boundary` + `date-picker` + `run-multi-shop-day`）。
`check:staged` / `test:staged` 结果见提交说明。

---

## 二、「今天的数据收集完了吗」

**口径**：今天（10-06）15:30 那一轮按 `--date yesterday` 收的是**报表日 2026-10-05**。
（`evidence/batches-2026-10-05/` 的 mtime 是今天 15:34–15:37 ⇒ 那一轮确实跑了。）

### 答案：没收成。底单 2026-10-05 = **0 行**。

### 第 2 层（产物）

`evidence/batches-2026-10-05/b1` 与 `b2` 里**只有** `00-health-check-daily.txt` 与 `summary.json`，
**没有任何逐店产物** —— 说明链在第 0 步就断了，一家都没开跑：

```
b1 & b2 同因：chainStatus=1、shops={}、round.healthCheckDaily.status=2
  blocking: TARGET_PAGE_MISSING
  归位记录 from = https://sycm.taobao.com/custom/login.htm?_target=…/shop/performance/new#/shop
```

`from` 停在 `custom/login.htm?_target=` ⇒ 按已归档判据，这是**商家浏览器（19022/19023）掉登录**，
**不是缺页**。两批同因（挡整轮的是共用实例的登录，与批次无关）。只能人登。

### 第 4 层（飞书 OpenAPI 全表，不碰库也不碰浏览器）

> 第 1 层（`daily_report_push_audit`）这次**拿不到**：容器 `xws-adaptive-postgres` 状态是
> `Exited (0) 8 days ago`。**我没有去启它**（未经许可不动任何进程/容器）。

底单（`各店铺日报`）逐日行数，最后 9 天：

| 报表日 | 底单行数 | 说明 |
| --- | --- | --- |
| 2026-09-27 | 12 | |
| 2026-09-28 | 12 | |
| 2026-09-29 | 12 | |
| 2026-09-30 | 3 | **缺口** |
| 2026-10-01 | 3 | **缺口** |
| 2026-10-02 | 4 | **缺口** |
| 2026-10-03 | 4 | **缺口** |
| 2026-10-04 | 8 | 齐（＝销售1部 8 家） |
| **2026-10-05** | **0** | **今天那一轮，没收成** |

询单表：10-05 有 13 行，但**两个字段全空**（那 13 行是预建行，值要靠 chain 回填）
⇒ 与「底单 0 行」互相印证：10-05 完全没收到。
对照 10-04：询单表那 8 家在采店铺**都有值**（盖文天猫 5/30、里可林淘宝 3/5、…、网林家居 1/5），
另外 5 家（保拉淘宝/保拉天猫/安比龙头店/科塔龙头店/安比淘宝）按「销售2部停采」的设计留空 —— 正常。

**读法坑（已踩）**：飞书日期字段是**上海 0 点**的 epoch，`toISOString()`（UTC）会把它读成**前一天**。
第一版探针因此整表错位一天（把 10-04 的 8 行读成 10-03）。必须按 `Asia/Shanghai` 换算。

### 要人做的一件事

现场还在：19022/19023 仍 LISTEN，`edge-daily-report-profile` 的 msedge 仍在。
**人在那台共用窗口上登一次**，然后补跑 2026-10-05（底单 0 行 ⇒ 不会撞同日去重闸门；现在已过 11:20）。

补充：**10-04 之后底单缺 4 天**（09-30 3 行 / 10-01 3 行 / 10-02 4 行 / 10-03 4 行）。
本轮只报数，**未归因** —— 那几天是「跑失败」还是「当时口径只收这几家」需要另外查。

---

## 三、顺带发现：商品数据告警仍然在对业务人员讲术语

今天 12:24 发出的那条告警，**已投递**（`job.log`: `告警投递：SENT（exit 0）`）。
用真渲染器还原出来是这样（`render-product-alert.mjs`）：

```
【需要处理】商品数据采集未完成（2026-10-05）
原因：FAILED/UNCLASSIFIED：本轮不完整（1 处）：盖文淘宝/底单 导入失败
下一步：打开 D:\Retire\sycm-automation\evidence\product-data-job-2026-10-05\2026-10-05-20261006041350559-1c48d3c8
        看 job.log 与 collection.json，确认停在哪家店哪一段；证据齐了再决定是否重跑该日
证据：D:\Retire\...\run-receipt.json、D:\Retire\...\collection.json、D:\Retire\...\job.log
```

这正是用户 10-06 抱怨的那一类（「一堆专业术语，你让业务人员怎么处理」）—— 但**是另一条链**：
C 项只修了 `login-merchant-core.mjs` 的**登录告警**，商品数据这条走的是自己的告警构造 + 渲染路径，
`下一歩` 还在让人去开 Windows 路径读 `job.log`。**本轮未改**（属新范围，先报不擅动）。

同一条告警里的技术事实（供技术同学）：`product` 阶段 FAILED、`inquiry` COMPLETED、
`promotion` SKIPPED、失败点 `盖文淘宝/底单 导入失败`。

---

## 复现

```bash
node runtime/escalation-plan.mjs --date yesterday        # 修后应 exit 0 并解析成上海昨日
node --test runtime/escalation-plan.test.mjs runtime/arch-boundary.test.mjs \
  "skills/sycm-alimama-daily-report/scripts/date-picker.test.mjs" \
  "skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs"

# 只读探针（仓库外，避免污染工作区）
node D:/Retire/probe-live/day-completeness-1006b.mjs     # 底单/询单表逐日行数（按 Asia/Shanghai）
node D:/Retire/probe-live/render-product-alert.mjs       # 商品数据告警的真渲染文本
```

⚠️ 探针里如果用 `execFileSync` 调 docker/psql，stdio **必须显式写 `['ignore','pipe','pipe']`**
—— 默认的 `'pipe'` 会让 stdin 也成为管道，本机沙箱下必抛 `EBUSY`（症状是「探针没跑就说自己错了」）。
