# 修复 agent 报告 —— 网林天猫（目标日 2026-10-07）

- 角色：第二层「后台修复 agent」（repair-agent-1007）
- 店：网林天猫｜代理：http://127.0.0.1:19042（登记表 proxyPort，与请求单一致）
- 阶段：backfill（第 10 步）｜成因：STAGE_FAILED｜候选：`REAPPLY_DATES` / `RELOAD_PAGE`
- 仓库基线提交：`3268a6f`
- 是否改仓库代码：**没有**（因此无 97-repair-agent-code-diff.patch）

---

## 1. 原始失败现场（10-backfill.txt 的 stderr）

```
Error: SOURCE_NO_ROW_FOR_DATE 这一天的源表里没有日期行（生意参谋「询单到付款」对该店该日返回的是空态，不是读不到）
｜日期列原值=["暂无数据","汇总值","平均值","全店汇总值","全店平均值","同行同层优秀","同行同层均值"]｜日期行数=0｜期望=2026-10-07
$ ... --source-shop 网林家居旗舰店 --shop 网林天猫 --shop-key 网林天猫 --commit
[身份] 生意参谋页头 = "网林家居旗舰店"（原始 "网林家居旗舰店 主店"）｜期望 "网林家居旗舰店" ✓
```

即：本店在第 10 步读生意参谋「询单到付款」表时，该店该日**没有日期行**（返回空态 `暂无数据`）。
这不是「读不到」、也不是「页面点不动 / 被遮挡」——是数据源本身对该日返回空。

（请求单里的 `stateSummary.url` 是阿里妈妈下载页 —— 感知层拍错页的已知缺陷；本报告一律以请求单的 `cause`/`stage` 与阶段 stderr 为准。）

## 2. 执行时间线（每步命令 + 回读）

### 2.0 前置：实例已被上一轮 `--batches` 释放，先只为这一家拉起
- 回读（两遍）：`Get-NetTCPConnection -LocalPort 19032,19042 -State Listen` → 两遍都空（free）。
- 起：`node scripts/start-all-hold.mjs --only 网林天猫`（后台托住）
  - 回读：`起前:missing → 已起 browser pid=139176 / proxy pid=2908 → 起后:ready`
- 回读（两遍）：`19032` 与 `19042` 均 `Listen`。

### 2.1 冷启动**没有**恢复 sycm 页（同网林家居）
- 只读 `GET http://127.0.0.1:19042/targets`：窗口里只有标识页，没有 sycm/alimama 页。
- ⇒ 直接跑修复动作会 `TARGET_PAGE_MISSING`；先借链自身的归位机制建页。

### 2.2 只跑 health-check（建出 sycm/alimama 页签）
```
node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs \
  --date 2026-10-07 --commit --shops 网林天猫 --only health-check \
  --logs evidence/batches-2026-10-07/b1/_repair
```
- 回读：`[网林天猫] 归位：已归位（生意参谋工作页=0 阿里妈妈报表页=0 → 生意参谋工作页=1 阿里妈妈报表页=1）`，体检通过。
- 整轮级体检：`[一轮] 归位：本来就在位（生意参谋工作页=1 飞书底单页=1）`（共用实例 19022/19023 **空操作**）。

### 2.3 候选 1：REAPPLY_DATES —— **未应用（设计如此）**
```
node .../repair-shop-stage.mjs --shop 网林天猫 --proxy http://127.0.0.1:19042 \
  --stage backfill --cause STAGE_FAILED --action REAPPLY_DATES --log-dir evidence/batches-2026-10-07/b1/网林天猫
```
- dry-run：`目标页 = https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop`，排练通过。
- 真跑回读：`❌ 未应用：日期需要重新落位（sycm）—— 请重试该站点的落位阶段来完成，本动作不重复实现落位`（exit 1）。
- 说明：该动作按实现**永远是 `applied:false`** 的「信号」动作。证据：`97-repair-REAPPLY_DATES.json/.txt`。

### 2.4 候选 2：RELOAD_PAGE —— **已应用**
- dry-run：目标页同上，排练通过。
- 真跑回读：`[遮挡] 已重载页面（生意参谋 - 零售电商大数据产品平台）—— 在新现场上再走一遍` / `✅ 已应用：页面已重载并就绪`（exit 0）。
- 证据：`97-repair-RELOAD_PAGE.json/.txt`（`applied:true`）。

### 2.5 重试失败起点之后的阶段（sycm-date-again + backfill + readback）
```
node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs \
  --date 2026-10-07 --commit --shops 网林天猫 \
  --only sycm-date-again,backfill,readback \
  --logs evidence/batches-2026-10-07/b1/_repair
```
- 第 9 步 `sycm-date-again`：**通过**（exit 0）。回读 `09-sycm-date-again.txt`：
  `status: APPLIED`｜`observedBefore/After = "统计时间 2026-10-07"`｜
  `trace` 里 tab「询单到付款」激活点 `[492,277]`｜`click-preset "1天"`｜`settled applied 2026-10-07`。
- 第 10 步 `backfill`：**仍失败**（exit 1），成因与首跑**逐字相同**：
  `SOURCE_NO_ROW_FOR_DATE ... 日期行数=0 ...`
- ⇒ 结论：**不是页面现场问题**。日期确已落到 2026-10-07（有落位日志为证），
  平台对该店该日「询单到付款」返回的就是空态；`RELOAD_PAGE`（换新现场）不能造出平台侧的数据。
- 分诊：`需人 0 处；不需要人 1 处（网林天猫@SOURCE_NO_ROW_FOR_DATE）`，未发提醒。

### 2.6 旁证（同因、跨店）
- 同轮其余 6 家 `10-backfill.txt` 全部 `exit=0`（盖文天猫/盖文淘宝/科塔淘宝/里可林淘宝/网林淘宝/里可林天猫）。
- 本 agent 修复的另一家 网林家居：把它的 TD 遮挡修好后，backfill 撞上**同一个** `SOURCE_NO_ROW_FOR_DATE`。
⇒ 平台对那 6 家有 2026-10-07 的行；对网林天猫、网林家居返回空态。

### 2.7 释放实例
- 停：`node scripts/stop-all.mjs --yes --only 网林天猫`
- 回读（两遍）：`19032` / `19042` 均 **free**。

---

## 3. 最终结论

**修不动（平台未产出）—— 但这不是「agent 没试」：两个候选都试过，且复核到了页面层。**

- `REAPPLY_DATES`：`applied:false`（设计如此，只报「需重落位」信号）。
- `RELOAD_PAGE`：`applied:true`（真换了一个新现场），重试时落位阶段 `sycm-date-again` **通过**、
  日期确为 **2026-10-07**（落位日志逐字为证），可 backfill 仍报 `SOURCE_NO_ROW_FOR_DATE`。
- ⇒ 该缺口是**平台侧数据缺口**（该店该日「询单到付款」= 空态），页面现场类修复对它无效。
- 依据项目硬规则：**平台空态 ≠ 0，绝不填 0**。链的分诊也把它归为「已知、不需要人」。
- 因此**不转人**、**不硬凑**；如实记为「平台未产出，等平台产出后重跑 backfill 即可」。

## 4. 偏离与边界交代
- **没有**用 `node scripts/run-daily-job.mjs --date 2026-10-07 --shops 网林天猫` 做重试：
  该入口第 ① 步 `start-all.mjs`（无 `--only`）会**把全部登记实例起齐**（13 家店 + 竞品链），
  与本次「只碰这两家各自那一套实例、不许起别的店」的硬边界冲突。
  改用**等价的链驱动直跑**（`run-multi-shop-day.mjs --shops 网林天猫 --only <失败起点之后的阶段>`）。
- 全程**只**碰 19032/19042（本店实例）。链的整轮级体检会读共用实例 19022/19023；
  已先只读核对它「本来就在位」，那一趟是空操作，未起/停/重启它、未改它的页面。
- 未做任何额外飞书写入：重试未点名 `push`；`backfill` 在写之前就失败。
