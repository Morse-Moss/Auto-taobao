# 修复报告：里可林天猫 / 2026-10-09 / 第 10 步 backfill

- **目标日**：2026-10-09
- **店**：里可林天猫（页头店名＝里可林旗舰店）
- **失败阶段**：`backfill`（第 10 步「回填询单数据」）
- **成因（请求单）**：`STAGE_FAILED`
- **修复 agent**：repair-agent-1009
- **结论**：**救回 ✅**（询单表 reczz28LcsYkOqGU 已写入 询单量=7 / 同层同行询单量=14，双通路独立回读确认）
- **是否改仓库代码**：**否**（纯操作型救援；`git diff` 里的改动全部来自别的会话，本 agent 一个字未碰）

---

## 一、现场事实（第 1~2 步，只读）

### 请求单 `97-repair-request.json`

- `cause=STAGE_FAILED`，`stage=backfill`，`retryStage=backfill`，`stageHint=sycm`
- `candidates`（闭集内，两个）：
  1. `REAPPLY_DATES`（mutating）
  2. `RELOAD_PAGE`（mutating）
- `instancePrecondition.checkCommand` = `curl -s -m 5 http://127.0.0.1:19061/targets`
- `execHint` = `node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 里可林天猫 --proxy http://127.0.0.1:19061 --stage backfill --cause STAGE_FAILED --action <动作> --log-dir evidence\batches-2026-10-09\b2\里可林天猫`

### 感知层 `98-failure-state.json` / `.txt` / `.png`

感知层拍到的页面是 **`下载任务管理_万相台无界版`（URL `https://one.alimama.com/index.html#!/report/download-list`）**。
按 HANDOFF 第 2 步的已知缺陷（感知层有时拍错页），**以请求单的 cause/stage 为准**，截图只当辅助。
本例即为此类：这张截图与 backfill（生意参谋页）无关，**不作判据**。

### 两次失败的真实成因（读 `10-backfill.txt` / `11-backfill.txt`）——**两者完全不同，分开取证**

**第一次**（`10-backfill.txt`，08:08:57，`exit=1`）：

```
[身份] 生意参谋页头 = "里可林旗舰店"（原始 "里可林旗舰店 主店"）｜期望 "里可林旗舰店" ✓
TypeError: fetch failed
    at async FeishuClient.listRecords (.../feishu-client.mjs:161:20)
    at async Promise.all (index 2)
    at async main (.../run-inquiry-backfill.mjs:184:43)
```

⇒ **飞书 OpenAPI 网络层传输失败**（`Promise.all` 第 3 项＝`listRecords`）。
读生意参谋表**已经成功**（身份核对通过 ✓），失败发生在**读飞书之前/相邻**，与页面无关。
这是**可重试的传输层意外**（`fetch failed` 是 undici 对 ECONNREFUSED/ECONNRESET/socket hang up 的统一外衣）。

**第二次**（`11-backfill.txt`，08:10:05，`exit=1`）：

```
Error: expected one 当日询单人数 table, got 0
    at async readSycmTable (.../run-inquiry-backfill.mjs:93:19)
    at async main (.../run-inquiry-backfill.mjs:135:18)
```

⇒ **生意参谋页面上找不到「当日询单人数」表**。
这是**脚本自修回环自己造成的**：round2 的 `RELOAD_PAGE`（applied=true）对生意参谋页发了一次**真重载**，
而重载会**重置页签与日期**（本仓代码原话，见 `run-multi-shop-day.mjs:1263`：
「回位会重置页签与日期 ⇒ 必须重跑落位，否则回填报 `expected one 当日询单人数 table, got 0`」）。
自修回环只重试了 `backfill`，**没有先重跑 `sycm-date-again`**，于是页面还没落位就读表 ⇒ `got 0`。

⚠️ 结论：**第二次失败不是新问题，是第一次修复动作的副作用**。原始问题只有第一次那个（飞书传输层意外）。

### 链的前 9 步全绿

`07-push.txt`：`status=COMMITTED_AND_VERIFIED`，`recordId=reczz28LdR44eV9k`，
`recordCountBefore=2244 → recordCountAfter=2245`，`verifiedFields=245`。
⇒ 底单行 2026-10-09 已成功写入。唯一缺口＝第 10 步询单回填。

---

## 二、第 0 步：确认实例（**别跳，本单是分批形态**）

`--batches` 每批跑完即释放，失败店也在释放名单里 ⇒ 先回读代理是否在听。

```
$ curl -s -m 5 http://127.0.0.1:19061/targets
EXIT=7            # 连接被拒 ⇒ 实例已不在
```

⇒ 拉起（后台托住）：

```
$ node scripts/start-all-hold.mjs --only 里可林天猫        # 后台运行
```

回读两遍端口确认在听：

```
$ Get-NetTCPConnection -LocalPort 19061 -State Listen
LocalAddress LocalPort  State OwningProcess
127.0.0.1        19061 Listen          1576
# （19051 也在听，PID 149372）
```

再回读代理：

```
$ curl -s -m 5 http://127.0.0.1:19061/targets     # 返回一个 JSON 数组
[ { "targetId":"1B4D…", "title":"里可林天猫 · 日报采集窗口", "url":"file:///…/shop-window-label.html?…" } ]
```

⇒ 实例在位（**但只有标识页** —— 见下）。

---

## 三、第 3~4 步：试候选动作（结果：两个都 `applied:false`，因目标页不在）

先读当前窗口页签：**只有标识页 `shop-window-label.html`，没有 sycm 页、也没有 alimama 页。**
这是**冷启动**的结果：`start-all` 起的浏览器只开标识页，业务页（生意参谋/阿里妈妈）需另行补；
而分批跑完释放后，原来那两个业务页随实例一起没了。

> 注：`runtime/launch-plan.mjs` 的启动参数只设 `PROJECT_BROWSER_URL = labelPageUrlFor(...)`，
> 业务页由链的第 0 步体检（`normalizePages`，非 dry）负责**领回或新建**。

### `REAPPLY_DATES`

```
# --dry-run
$ node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 里可林天猫 \
    --proxy http://127.0.0.1:19061 --stage backfill --cause STAGE_FAILED --action REAPPLY_DATES \
    --log-dir evidence/batches-2026-10-09/b2/里可林天猫 --dry-run
[修复] ❌ 未应用：找不到要修的那一页：窗口里找不到 sycm.taobao.com 的页
EXIT=3

# 真跑
…（同上，去掉 --dry-run）
[修复] ❌ 未应用：找不到要修的那一页：窗口里找不到 sycm.taobao.com 的页
EXIT=3
```

证据：`97-repair-REAPPLY_DATES.json`（`applied=false`，`exitCode=3`，`targetId=null`）。

### `RELOAD_PAGE`

```
# --dry-run
[修复] ❌ 未应用：找不到要修的那一页：窗口里找不到 sycm.taobao.com 的页
EXIT=3
# 真跑
[修复] ❌ 未应用：找不到要修的那一页：窗口里找不到 sycm.taobao.com 的页
EXIT=3
```

证据：`97-repair-RELOAD_PAGE.json`（`applied=false`，`exitCode=3`，`targetId=null`）。

### 判读

两个候选都 `applied:false`，原因**同一个且是机械的**：`--proxy` 是唯一实例选择器，实例在位，
但**窗口里没有 sycm 目标页**，所以两个页面动作都没有可作用的目标。`locateStagePage` 如实报
`找不到 sycm.taobao.com 的页`（exit 3 = INCONCLUSIVE，不是「动作试过没用」）。

⇒ **这不是「候选试完仍失败 ⇒ 转人」的形态**（那正是 HANDOFF 文件头点名的、历史 27 份报告里 20 份犯过的错：
「动作还没试就判转人」）。这里是**页面缺失**这一可机械修复的现场，而**链自己的第 0 步体检就会补页**。

---

## 四、第 5 步：重试（补页 ＋ 落位 ＋ 回填）

依据：`normalizePages`（非 dry）会**领回或新建**缺失的期望页（`planPageActions` → `sendRequests`，含 `create`）；
链的第 0 步体检（`runHealthCheck`）在这个模式下跑，`runtime/browser-ports.mjs` 里该店期望页＝
「生意参谋工作页 `sycm.taobao.com/qos/service/frame/shop/performance`」＋「阿里妈妈报表页 `one.alimama.com`」。
新建的生意参谋页落在 `…/performance/new#/shop`，正是 `readSycmTable.discoverSycmTarget` 要的 URL。

### 4.1 排练（不写飞书）——先确认补页 + 落位 + 取数都通

```
$ node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs \
    --date 2026-10-09 --shops 里可林天猫 \
    --only health-check,sycm-date-again,backfill \
    --logs evidence/batches-2026-10-09/b2
[里可林天猫]   归位：已归位（生意参谋工作页=0  阿里妈妈报表页=0 → 生意参谋工作页=1  阿里妈妈报表页=1）
[里可林天猫]     [归位] 生意参谋工作页：create
[里可林天猫]     [归位] 阿里妈妈报表页：create
[里可林天猫]   体检通过：阻断 0 项，告警 1 项
[里可林天猫] 9. sycm-date-again —— 回位会重置页签与日期 ⇒ 必须重跑落位…
[里可林天猫] 10. backfill —— 询单回填干跑（取数 + 判处置，不写）
[驱动] 汇总： 里可林天猫：ok     （EXIT=0）
```

⇒ 两个缺失页被 `create` 补回；落位、取数全部通过（干跑不写飞书）。

### 4.2 真跑（写飞书）

```
$ node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs \
    --date 2026-10-09 --shops 里可林天猫 \
    --only health-check,sycm-date-again,backfill --commit \
    --logs evidence/batches-2026-10-09/b2
[里可林天猫] 10. backfill —— 询单回填（写两个字段）
[驱动] 汇总： 里可林天猫：ok     （EXIT=0）
```

`10-backfill.txt`（08:22:48）：

```
$ run-inquiry-backfill.mjs --date 2026-10-09 --proxy http://127.0.0.1:19061 \
    --source-shop 里可林旗舰店 --shop 里可林天猫 --shop-key 里可林天猫 --commit
exit=0
[身份] 生意参谋页头 = "里可林旗舰店"（原始 "里可林旗舰店 主店"）｜期望 "里可林旗舰店" ✓
[店铺] "里可林天猫" → 选项 id "optUI2OU6r"
{
  "status": "COMMITTED_AND_VERIFIED",
  "recordId": "reczz28LcsYkOqGU",
  "values": { "询单量": 7, "同层同行询单量": 14 },
  "unchangedOtherFields": true
}
```

> ⚠️ 说明：`--only` 里**不含 push**，因此不会重复写底单（push 在首跑已 `COMMITTED_AND_VERIFIED`）。
> 只跑「补页 + 落位 + 回填」，正是「重试失败那一步」。

### 4.3 独立回读（**两条通路**，不采信自证）

**通路 A —— 直接读飞书 OpenAPI**：

```
$ node -e "…client.listRecords()…findDailyStoreRow(recs, epoch, '里可林天猫')…"
candidateCount 1  matchedBy shop-name
recordId reczz28LcsYkOqGU
询单量= "7"  同层同行询单量= "14"
```

**通路 B —— 链自己的 `readback` 阶段**（换一条通路读同一事实）：

```
$ node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs \
    --date 2026-10-09 --shops 里可林天猫 --only readback --commit --logs …   （EXIT=0）
询单表: recordsNum=2301 loaded=2301 命中 2026-10-09=8
  2026-10-09 | 里可林天猫 | reczz28LcsYkOqGU | 询单量=7 | 同层同行=14
screenshot(inquiry) → evidence/daily-report-2026-10-09-里可林天猫/feishu-inquiry-table-after-backfill.png
```

收据 `evidence/daily-report-2026-10-09-里可林天猫/inquiry-backfill-receipt.json`：
`peerBenchmark=PEER_AVAILABLE`（源表 7 行，含同行同层均值行）、
`prewrite.disposition=WRITE_REQUIRED`（写前两格均为 null）、`status=COMMITTED_AND_VERIFIED`。

⇒ **写入为真**（非「我修好了」的自证）：飞书表被两条独立通路读到 `询单量=7 / 同层同行询单量=14`，
且 recordId 与写前回读一致（`reczz28LcsYkOqGU`）。

---

## 五、结论

- **救回 ✅**。第 10 步 `backfill` 已对 2026-10-09 / 里可林天猫 写入 `询单量=7`、`同层同行询单量=14`，
  双通路独立回读确认。
- **试过的候选**：`REAPPLY_DATES`、`RELOAD_PAGE` —— 两者均 `applied:false`（exit 3），
  共同原因＝**窗口里没有 sycm 目标页**（分批释放后冷启动，业务页随实例消失）。
- **真正的修法**：重跑链的第 0 步体检（其 `normalizePages` 会 `create` 缺失页）＋ `sycm-date-again`（落位）
  ＋ `backfill`（写）。这只用到链自己的阶段，**未绕过 `repair-shop-stage.mjs` 去直接操作浏览器**。
- **是否改仓库代码**：**否**。`git diff` 中的改动全部来自其它会话（动代码前 `git log -1` ＝
  `db686e8 fix(login): 滑块判据认同源 iframe ＋ 提交后回读验证码（1.7.17）`，工作区在本次作业前就已是脏的）。
  因此**没有** `97-repair-agent-code-diff.patch`（无 diff 可存）。

## 六、给链/会话侧的观察（非本次修法，供参考）

1. **自修回环的动作顺序有个结构性副作用**：`STAGE_FAILED` 的候选是 `[REAPPLY_DATES, RELOAD_PAGE]`，
   而 `REAPPLY_DATES` 按实现恒返回 `applied:false`（它是「报告者」），于是第 2 轮必然落到 `RELOAD_PAGE`；
   `RELOAD_PAGE` 一旦对生意参谋页生效，就会重置页签与日期，**紧接着只重试 `backfill` 必然 `got 0`**
   —— 即「修完反而不如不修」。本单的第二次失败正是这个形态。
   若要根治，可考虑：`backfill` 的重试串里带上 `sycm-date-again`（或在 `RELOAD_PAGE` 作用于 sycm 页后
   自动补一次落位）。**本次未改代码**（属口径决定，留给链侧/人判断）。
2. **分批释放 ⇒ 修复 agent 必须自补页**：`--batches` 释放后冷启动只有标识页，
   修复 agent 仅「拉起实例」还不够，还需让链的体检 `create` 业务页。第 0 步的检查命令
   (代理在不在听) 不能区分「实例在、但页不在」这两种现场 —— 建议后续在请求单里补一条
   「期望页是否在位」的可回读判据。

## 附：本次落盘文件

- `97-repair-agent-report.md`（本文件）
- `97-repair-REAPPLY_DATES.json` / `.txt`（候选 1 证据，`applied=false`）
- `97-repair-RELOAD_PAGE.json` / `.txt`（候选 2 证据，`applied=false`）
- `01-health-check.txt`（补页：两个 `create`）
- `09-sycm-date-again.txt`、`10-backfill.txt`（真跑）、`11-readback.txt`（独立回读）
- `evidence/daily-report-2026-10-09-里可林天猫/inquiry-backfill-receipt.json`（收据）
- `evidence/daily-report-2026-10-09-里可林天猫/independent-readback.json` +
  `feishu-inquiry-table-after-backfill.png`（独立回读与截图）
