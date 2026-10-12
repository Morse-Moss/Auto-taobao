# 修复 agent 报告 —— 网林天猫（目标统计日 2026-10-06）

- 批次/证据目录：`evidence/batches-2026-10-06/b1/网林天猫`（第 1 批）
- 失败阶段：`backfill`　成因（请求单）：`STAGE_FAILED`
- 该店实例：浏览器调试端口 + 代理 `http://127.0.0.1:19042`（登记表 runtime/browser-ports.mjs）
- 源店（生意参谋页头）：`网林家居旗舰店`；询单表「店铺」选项 id：`optUKhpHUN`
- 该店 backfill 阶段身份核对通过后，卡在飞书行查找。
- 报告人：repair-agent-1006　生成时间：2026-10-07T16:06:36+08:00

## 1. 现场读到了什么（只读）

读取文件：`97-repair-request.json`、`98-failure-state.json/.txt`、`98-failure-page.png`、各阶段日志（`10-backfill.txt` 等）。

- 请求单给的候选闭集：`REAPPLY_DATES`、`RELOAD_PAGE`（两者 `mutating:true`）。
- 失败瞬间截图：见 `98-failure-page.png`。**已知感知层有时拍错页**，本次部分店截图落在 `edge://downloads-hub/`（「下载」页），与真正失败无关；按指导书**以请求单的 cause/stage 为准**，截图只当辅助。
- backfill 阶段日志（逐字摘要）：
  - `10-backfill.txt` stdout 结尾：`[身份] 生意参谋页头 = "网林家居旗舰店" … ✓` 与 `[店铺] "网林天猫" → 选项 id "…"`（身份核对已通过）；stderr：`Error: expected one Feishu row for 网林天猫 / 1791216000000, got 0`（抛自 run-inquiry-backfill.mjs:200 `findDailyStoreRow`）。

## 2. 独立复核的根因（不是页面问题）

用只读探针（`_agent-readonly-feishu-probe.mjs`，只调 `listRecords`/`listFields`，GET，无写请求）
查新日报 base「各店铺日报 副本」(`RjKcb3isDaVn1GsoVJfc7Ykknyg`)，输出见 `evidence/batches-2026-10-06/_agent-readonly-feishu-probe-output.txt`：

- 目标表「各店铺数据日报」(`tblqF2YD2VfmKP4C`)：**2026-10-06 行数 = 0**；日期范围 2026-04-01 … **2026-10-05**；最近每日固定 13 行。
- 源表「总数据来源底单」(`tblIuAX4nPc1zDOO`)：2026-10-06 有 **7 行**（即 7 家已 push，不含科塔淘宝）。

⇒ 结论：7 家 backfill 的失败点**不在浏览器页面**，而在**飞书目标表「各店铺数据日报」没有 2026-10-06 的行骨架**。
回填脚本（`run-inquiry-backfill.mjs`）只**更新既有行字段**（询单量/同层同行询单量），
从不建行；仓库内也没有任何脚本在「各店铺数据日报」建行（`grep batchCreateRecords` 只命中底单/商品/竞品等表）。
预建行在 base 里只铺到 10-05（docs/ops/PROJECT-BROWSER-AND-PORTS.md 第 62 行：「09-29…10-05 预建行也按 13 家铺好」），
**10-06 这一天的骨架没有人/没有脚本去补**。

## 3. 试过的候选动作（逐条命令 + 回读）

命令形状（先 dry-run 排练、再去掉真跑）：
`node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 网林天猫 --proxy http://127.0.0.1:19042 --stage backfill --cause STAGE_FAILED --action <动作> --log-dir evidence/batches-2026-10-06/b1/网林天猫 [--dry-run]`

逐次输出（完整落盘在同目录 `97-repair-agent-actions.log`；每次动作的 `97-repair.json` 已另存为 `97-repair-<动作>[-dryrun].json`）：

| # | 动作 | 是否 dry-run | 退出码 | applied | detail（回读结论） |
|---|------|--------------|--------|---------|--------------------|
| 1 | REAPPLY_DATES | 是 | 3 | false | 读不到页签（代理连不上）：fetch failed |
| 2 | REAPPLY_DATES | 否 | 3 | false | 读不到页签（代理连不上）：fetch failed |
| 3 | RELOAD_PAGE | 是 | 3 | false | 读不到页签（代理连不上）：fetch failed |
| 4 | RELOAD_PAGE | 否 | 3 | false | 读不到页签（代理连不上）：fetch failed |

- **两个候选都试完了，无一 `applied===true`** ⇒ 按指导书**不重试阶段**（原样重放不算修复），进「转人」。
- 附带事实：**派单前该店实例已停**。只读端口探测：`127.0.0.1:19042` = closed；本轮 8 家店铺实例（19031-19035 / 19041-19045 / 19050-19052 / 19060-19062）全部 closed，只有日报主浏览器 19022/19023 存活。这是 `--batches` 形态「跑完即释放」的已知编排缺口。
- 即便实例还活着、`RELOAD_PAGE` 能 `applied`，页面类动作也**修不到本题根因**：重试 backfill 仍会在 `findDailyStoreRow` 处因「0 行」抛同一个错。所以页面临场动作对这家是**无效菜单**。

## 4. 最终结论：**agent 修不动 ⇒ 转人**

修不动的原因不是「页面现场坏了」，而是**飞书目标表缺目标日的行骨架**。
按本次授权边界，**往飞书写入新行不在授权闭集内、且属生产数据写入 ⇒ 修复 agent 不做**。

### 建议怎么做（交给人/编排侧，均**未执行**）
1. 在「各店铺数据日报」(`tblqF2YD2VfmKP4C`) 为 **2026-10-06** 建 13 行骨架（店铺 = 13 家的「店铺」单选选项，日期 = 2026-10-06 00:00 +08:00），再重跑这 7 家的 backfill 阶段。
   —— 这是**生产数据写入**，需人确认后执行；agent 不代做。
2. 根因收口（防复发）：目前**没有**任何自动化在跨日时补「各店铺数据日报」当天的预建行，行骨架实际上停在 10-05。建议把「按运行日为 base 预建当天 13 行」做成链上的一个显式、幂等的步骤（或开工前置检查：缺当天骨架就 fail-closed 并点名人），而不是靠人记得手动铺。
3. 代码层盲点（建议，非本次改动）：`run-multi-shop-day.mjs` 的 `shopFailureCause` 未把「`expected one Feishu row … got 0`」这一类**目标表缺行**归成独立成因，
   于是落到兜底 `STAGE_FAILED`，而 `repair-actions.mjs` 给 `STAGE_FAILED` 的候选是页面动作（`REAPPLY_DATES`/`RELOAD_PAGE`）⇒ **菜单是假线索**（与 2026-10-06 已单列的 `SOURCE_NO_ROW_FOR_DATE` 同族，但方向相反：那是平台源表缺行，这是飞书目标表缺行）。
   建议新增一个成因（如 `TARGET_ROW_MISSING`）+ 确定性标记，并置「需人处理/不派页面动作」。

## 5. 代码改动

**本次未改任何仓库代码**（`git diff` 无本 agent 引入的改动）⇒ 无 `97-repair-agent-code-diff.patch`。
理由：根因是生产数据（飞书行骨架）缺失，修法是写入，不在授权闭集；第 4.3 条是**建议**，未落地。

## 6. 证据清单（本店目录）
- `97-repair-request.json`（脚本写的请求单，只读引用）
- `97-repair-agent-report.md`（本文件）
- `97-repair-agent-actions.log`（4 次动作的逐字 stdout/stderr + exit）
- `97-repair-REAPPLY_DATES-dryrun.json` / `97-repair-REAPPLY_DATES.json` / `97-repair-RELOAD_PAGE-dryrun.json` / `97-repair-RELOAD_PAGE.json`（每次动作脚本自己写的 97-repair.json 快照）
- `98-failure-state.json/.txt`、`98-failure-page.png`（失败瞬间现场，脚本写的）
- 批次级：`evidence/batches-2026-10-06/_agent-readonly-feishu-probe.mjs`、`_agent-readonly-feishu-probe-output.txt`
