# 修复 agent 报告 —— 网林家居（目标日 2026-10-07）

- 角色：第二层「后台修复 agent」（repair-agent-1007）
- 店：网林家居｜代理：http://127.0.0.1:19062（登记表 proxyPort，与请求单一致）
- 阶段：sycm-date-again（第 9 步）｜成因：STAGE_FAILED｜候选：`REAPPLY_DATES` / `RELOAD_PAGE`
- 仓库基线提交：`3268a6f`
- 是否改仓库代码：**没有**（因此无 97-repair-agent-code-diff.patch）

---

## 1. 原始失败现场（来自 97-repair-request.json / 10-backfill 前的 stderr）

`09-sycm-date-again.txt` 的 stderr：

```
Error: proxy http://127.0.0.1:19062/eval?target=... failed: HTTP 400 Error:
sycm tab 询单到付款: point (492,277) is covered by TD.
    at aim (...date-picker.mjs:275...)
```

即：生意参谋「询单到付款」页签的切换点上（492,277）被一个 `TD` 元素盖住 —— 属「渲染上元素不理会点击」的现场形态，**是页面现场问题，不是平台数据问题**。

（请求单里的 `stateSummary.url` 是阿里妈妈下载页 —— 感知层拍错页的已知缺陷；本报告一律以请求单的 `cause`/`stage` 与阶段 stderr 为准。）

## 2. 执行时间线（每步命令 + 回读）

### 2.0 前置：实例已被上一轮 `--batches` 释放，先只为这一家拉起
- 回读（两遍）：`Get-NetTCPConnection -LocalPort 19052,19062 -State Listen` → 两遍都 **空**（free）。
- 起：`node scripts/start-all-hold.mjs --only 网林家居`（后台托住）
  - 回读：`起前:missing（两样都没有，起一整套）→ 已起 browser pid=138468 / proxy pid=132200 → 起后:ready`
- 回读（两遍）：`19052` 与 `19062` 均 `Listen`。

### 2.1 关键事实：冷启动**没有**恢复上一轮的 sycm 页
- 只读 `GET http://127.0.0.1:19062/targets`：窗口里**只有标识页**（`shop-window-label.html?...port=19052`），
  **没有** sycm 页、也没有 alimama 页。
- ⇒ 直接跑修复动作会因「窗口里找不到 sycm.taobao.com 的页」而 `TARGET_PAGE_MISSING`（INCONCLUSIVE）。
  所以先借**链自身的归位机制**把页签现场建出来。

### 2.2 只跑 health-check（把 sycm/alimama 页签建出来）
```
node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs \
  --date 2026-10-07 --commit --shops 网林家居 --only health-check \
  --logs evidence/batches-2026-10-07/b2/_repair
```
- 回读：`[网林家居] 归位：已归位（生意参谋工作页=0 阿里妈妈报表页=0 → 生意参谋工作页=1 阿里妈妈报表页=1）`，体检通过。
- 整轮级体检：`[一轮] 归位：本来就在位（生意参谋工作页=1 飞书底单页=1）`（共用实例 19022/19023 **空操作**，未改变它）。
- 只读回读 `19062/targets`：出现「生意参谋工作页 / 阿里妈妈报表页」两个页签。

### 2.3 候选 1：RELOAD_PAGE —— **已应用**
```
# 排练
node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs \
  --shop 网林家居 --proxy http://127.0.0.1:19062 --stage sycm-date-again \
  --cause STAGE_FAILED --action RELOAD_PAGE --log-dir evidence/batches-2026-10-07/b2/网林家居 --dry-run
# 真跑（去掉 --dry-run）
```
- dry-run 回读：`目标页 = https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop`，排练通过。
- 真跑回读：`[遮挡] 已重载页面（生意参谋 - 零售电商大数据产品平台）—— 在新现场上再走一遍` / `✅ 已应用：页面已重载并就绪`（exit 0）。
- 证据：`97-repair-RELOAD_PAGE.json` / `97-repair-RELOAD_PAGE.txt`（`applied:true`）。

### 2.4 重试失败起点之后的阶段（sycm-date-again + backfill + readback）
```
node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs \
  --date 2026-10-07 --commit --shops 网林家居 \
  --only sycm-date-again,backfill,readback \
  --logs evidence/batches-2026-10-07/b2/_repair
```
- 第 9 步 `sycm-date-again`：**通过**（exit 0）。回读 `09-sycm-date-again.txt`：
  - `status: APPLIED`｜`observedAfter: "统计时间 2026-10-07"`｜`trace` 里 tab 激活点 `[492,277]`
    **这次点到了**（原来正是这个点报 `covered by TD`）｜`settled applied 2026-10-07`。
  - ⇒ **原始失败（TD 遮挡）被 RELOAD_PAGE 修复**。
- 第 10 步 `backfill`：**失败**（exit 1），但换成了**另一个成因**：
  ```
  Error: SOURCE_NO_ROW_FOR_DATE ... ｜日期列原值=["暂无数据","汇总值","平均值","全店汇总值","全店平均値","同行同层优秀","同行同层均值"]｜日期行数=0｜期望=2026-10-07
  ```
  `[身份] 生意参谋页头 = "网林定制家居"（原始 "网林定制家居 主店"）｜期望 "网林定制家居" ✓`
- 分诊：`需人 0 处；不需要人 1 处（网林家居@SOURCE_NO_ROW_FOR_DATE）`，未发提醒。

### 2.5 旁证：同轮其余 6 家 backfill 全部成功
逐店回读 `10-backfill.txt`：
`盖文天猫 exit=0 / 盖文淘宝 exit=0 / 科塔淘宝 exit=0 / 里可林淘宝 exit=0 / 网林淘宝 exit=0 / 里可林天猫 exit=0`，
只有 `网林天猫 exit=1`（同一 `SOURCE_NO_ROW_FOR_DATE`）。
⇒ **平台对那 6 家有 2026-10-07 的「询单到付款」行**；对本店（与网林天猫）该日返回**空态**。

### 2.6 候选 2：REAPPLY_DATES —— **未应用（设计如此）**
```
node .../repair-shop-stage.mjs --shop 网林家居 --proxy http://127.0.0.1:19062 \
  --stage sycm-date-again --cause STAGE_FAILED --action REAPPLY_DATES --log-dir evidence/batches-2026-10-07/b2/网林家居
```
- 回读：`❌ 未应用：日期需要重新落位（sycm）—— 请重试该站点的落位阶段来完成，本动作不重复实现落位`（exit 1）。
- 说明：该动作按实现**永远是 `applied:false`** 的「信号」动作（它不自己落位，只叫你重试落位阶段）。
  ⇒ 按纪律「`applied !== true` ⇒ 不重试阶段、换下一个候选」，候选已试完。
- 证据：`97-repair.json` / `97-repair.txt`（`applied:false`）。

### 2.7 释放实例
- 停：`node scripts/stop-all.mjs --yes --only 网林家居`
- 回读（两遍）：`19052` / `19062` 均 **free**。（见文末「端口回读」）

---

## 3. 最终结论

**（a）agent 可修的那一半：救回。**
本店原始失败是**页面现场问题**（`covered by TD`）。候选 `RELOAD_PAGE` 真跑 `applied:true`，
重试时第 9 步 `sycm-date-again` **通过**（日期确为 2026-10-07，原遮挡点 [492,277] 这次点到）。
⇒ 该成因已消除，且**可复现地**复核过（阶段日志逐字为证）。

**（b）残留的不是 agent 能修的：平台空态缺口。**
重试推进到第 10 步 `backfill` 时失败，成因换成了 `SOURCE_NO_ROW_FOR_DATE` ——
生意参谋「询单到付款」对本店 2026-10-07 返回空态（`日期行数=0`，日期列只有汇总类标签）。
旁证：同轮其余 6 家该日 backfill 全部成功（平台对它们有行），只有本店与网林天猫为「暂无数据」。
按项目硬规则**平台空态 ≠ 0，绝不填 0**；这一支没有任何「修复动作」能造出平台侧的数据。
链自己的分诊也把 `SOURCE_NO_ROW_FOR_DATE` 归为「已知、不需要人」。

**一句话：** 本店的 agent 可修失败（TD 遮挡）已救回；该店 2026-10-07 的日报缺口 = 平台未产出，
与网林天猫同因，交给修复动作无用、也不是「需人」事件。

## 4. 偏离与边界交代
- **没有**用 `node scripts/run-daily-job.mjs --date 2026-10-07 --shops 网林家居` 做重试：
  该入口第 ① 步 `start-all.mjs`（无 `--only`）会**把全部登记实例起齐**（13 家店 + 竞品链），
  与本次「只碰这两家各自那一套实例、不许起别的店」的硬边界冲突。
  改用**等价的链驱动直跑**（`run-multi-shop-day.mjs --shops 网林家居 --only <失败起点之后的阶段>`），
  足迹最小且不写别的店。
- 全程**只**碰 19052/19062（本店实例）。
  链的整轮级体检会读共用实例 19022/19023；已先只读核对它「本来就在位（生意参谋工作页=1 飞书底单页=1）」，
  那一趟是**空操作**，未起/停/重启它、未改它的页面。
- 未做任何额外飞书写入：重试未点名 `push`；`backfill` 在写之前就失败。
