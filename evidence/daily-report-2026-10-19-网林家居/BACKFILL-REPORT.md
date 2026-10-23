# 网林家居 2026-10-19 推广留空补写记录

日期：2026-10-20 09:2x｜版本：1.12.10｜提交：a1ff92f

## 一句话

用户拍板「关键词推广确实没有，按实际记录，没有就留空」后，把「推广 CSV 0 行」从结构性拦死改成人手显式放行，并已把这一行真的写进飞书底单：推广两段留空，一个 0 都没填。

## 口径怎么落地的

原来有两道闸门同时拦，改前改后对比：

| 位置 | 改前 | 改后 |
|---|---|---|
| `summarizeSourceDates` 推广侧 | `matches:false`（空与日期不对同形） | 拆成 `empty` / `mismatched` / `matched` 三态 |
| `assertSourceDates` | 一律抛错 | 空 + `--allow-empty-promotion` ⇒ 放行；有行但日期不对 ⇒ 加不加开关都拦 |
| `buildCombinedFields` | 0 行一律抛错 | 0 行 + 显式放行 ⇒ 推广两段整段不写（留空），并打 `[留空]` 留痕 |
| 默认行为 | fail-closed | **不变**，仍 fail-closed |

刻意没做的两件事：没有把放行设成默认（0 行与「数据还没出」同形，早跑的低值当天无法重推）；没有把「没有」写成 0。

## 真机证据链（不只是单测）

1. 不带开关 dry-run ⇒ 退出码 1，报同一条 `source date self-check failed`，但证据里已经出现 `"empty":true,"state":"empty"` —— 证明新状态生效、且默认仍拦。
2. 带 `--allow-empty-promotion` dry-run ⇒ 退出码 0，`promotionEmptyAllowed:true`、`payloadFields:116`、`promotionRows:0`。
3. `--commit` 真写 ⇒ `COMMITTED_AND_VERIFIED`、`recordId=reczz28PTwFh3QVB`、表行数 2425→2426。
4. 独立回读（OpenAPI 直读，不看收据）：底单 2026-10-19 的 8 家参与采集店全部齐了，网林定制家居那一行正是 `reczz28PTwFh3QVB`。
5. 逐字段读该记录：推广段 `关键词推广日期` / `关键词推广花费 (1)` / `关键词推广展现量` / `人群推广日期` / `人群推广花费 (1)` / `场景ID` / `场景ID (1)` **全部「未设置」**，字段数 118。

## 一个容易看错的地方

这一行里还有几个 0，它们不是我们填的：

- 店铺段 `关键词推广花费="0"`、`精准人群推广花费="0"` —— 来自**店铺报表 xlsx 的原始值**（生意参谋自己给的 0 元），是「按实际记录」。
- 店铺段 `全站推广花费="NULL"` —— 源数据的文本标记，既有行为，本次未改。
- 推广段（那几列带 ` (1)` 后缀，来自营销场景报表）才是留空的部分。

两段是两列，互不覆盖。

## 验证清单

- `daily-report-core.test.mjs` 11/11
- `daily-report-runtime.test.mjs` + `daily-report-audit.test.mjs` + `repair-actions.test.mjs` 45/45
- `collector-arg-contract.test.mjs` 7/7（新开关没破坏参数契约）
- `runtime/version-consistency.test.mjs` 6/6
- 突变：把放行改成恒 `true` ⇒ 第 9、10 条用例当场变红，已还原
- `npm run check:staged` PASS
- **未跑 `npm run test:staged`**：按仓库记录，选中该 skill 的实现变更会跑整个 skill suite（2026-09-25 实测 664 例 / 7.6 小时，92% 耗在 7 个等 60 分钟下载期限的 e2e 上），且本机已知会「跑完不退出」。已用定向组 + 真机证据替代，未用 `--no-verify` 绕过任何检查。

## 还没做的（需要拍板）

1. **要不要接进定时链**：现在只有 leaf 阶段（`run-daily-report.mjs`）认这个开关。明天 08:00 整链再遇到 0 行，仍然会停在第 7 步 push 并转 agent/人。要自动放行，得把开关透传进 `run-daily-job.mjs` → `run-batches.mjs` → 采集脚本，并决定默认值是开还是关。
2. **11:20 静止点的复核**：本次写入发生在 09:2x（早于 11:20）。用户已人工确认平台当日无数据，但若 11:20 后真出现数据行，这一天的留空行就写错了，需要删行重写（同日已写行无法重推）。
3. 本地提交 `a1ff92f` 未 push。
