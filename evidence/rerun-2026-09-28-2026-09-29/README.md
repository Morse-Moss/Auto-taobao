# 重跑 2026-09-28 日报链（2026-09-29 18:58，验证三层降级）

命令：`node scripts/run-daily-job.mjs --date 2026-09-28 --batches 5 --notify --auto-repair`
版本：sycm-automation 1.7.8（HEAD `74928ae`）｜耗时 15m50s｜**退出码 1**

## 底单判据（不看 summary.json）

| 时刻 | 底单 09-28 命中 | 页面模型 recordsNum | lowerBound |
|---|---|---|---|
| 写前基线 18:55 | **0** | 1929 | false |
| 写后回读 19:15 | **4** | 1933 | false |

写进去的四家（底单「店铺名称」→ 运营店名，映射见 `shop-identities.mjs:57/63/107-108/177-178`）：

| 底单「店铺名称」 | 运营店名 | recordId |
|---|---|---|
| 盖文全卫定制 | 盖文淘宝 | `reczz28HKhxyN2Pg` |
| 盖文旗舰店 | 盖文天猫 | `reczz28HKk2iJt1T` |
| 科塔全卫定制 | 科塔淘宝 | `reczz28HKmK3qX2h` |
| 网林家居旗舰店 | 网林天猫 | `reczz28HKffo1lUQ` |

**缺里可林淘宝**（死在 promotion-fetch，没走到 push）。

## 四件要验证的变化 —— 逐条结论

| # | 验证点 | 结果 | 证据 |
|---|---|---|---|
| ① | `--auto-repair` 真传到链 | ✅ 到了 | job.log `batch-chain:` 命令行含 `--auto-repair`；batches.log `chain:` 命令行含 `--auto-repair` |
| ② | 失败落 `98-failure-state.*` + `97-repair-request.json` | ✅ 5/5 家齐 | 五家目录各有 `98-failure-state.json` / `.txt` / `98-failure-page.png` / `97-repair-request.json` |
| ③ | `run-receipt.json` 从 PENDING 走到终态 | ✅ 到 FAILED | `evidence/daily-job-2026-09-28/run-receipt.json` status=FAILED exitCode=1（但 stages 仍全为 PENDING，见下） |
| ④ | `environment-preflight.json` 生成 | ✅ 生成、ok=true | `evidence/daily-job-2026-09-28/environment-preflight.json`，5 项全 PASS |

## 🔴 头号发现（**初版结论有误，2026-09-29 19:5x 已更正**）

**更正说明**：本 README 初版（与当时的口头汇报）写的是「backfill 写错了表」——
**那是错的**。`tableId = inquiryTable（各店铺数据日报 tblUnwn05vl8Wik9）从 5f1e9ed（2026-09-16）第一天起就是对的**，
`push` 写底单、`backfill` 回填询单表，本来就是各写各的表；而且 09-14 ~ 09-27 这条链**天天成功**
（最近一次成功收据 `evidence/daily-report-2026-09-27-盖文淘宝/inquiry-backfill-receipt.json`
`status=COMMITTED_AND_VERIFIED`，写的就是这张表、这个 `recordId` 家族 `recvtXf…`）。

### 真因：**09-28 那笔「北京时间零点」日期修复，只改了写入侧、没改匹配侧**

匹配条件是 `inquiry-core.mjs:52`：

```js
Number(record.fields?.['日期']) === reportDateEpoch(reportDate)
```

两边的口径在 09-28 之后**不再相等**（这是实测出来的，不是推理）：

| 量 | 值 | 出处 |
|---|---|---|
| `reportDateEpoch('2026-09-28')` | `1790524800000`（北京零点） | `daily-report-core.mjs:14`，`new Date('…T00:00:00+08:00')` |
| 表里 09-27 那行的 `日期` | `1790438400000`（**北京零点**） | OpenAPI 实读，`recvtXfc9GKpzA` |
| 表里 09-28 那行的 `日期` | **不存在** | OpenAPI 实读，见下 |

09-27 那行是 `1790438400000`＝北京零点，说明**写入侧的历史口径本来就是北京零点**，
`b74f611`（09-28）把那套口径在 `sycm-inquiry-data/inquiry-core` 里补成显式的 `toBeijingMidnight()`——
**这一改动的实质是把「商品数据链」的口径统一了，不是把日报链改坏了**。

真正让本轮回填失败的是**匹配公式本身**：`Number(fields['日期']) === epoch` 要求两边都是**同日北京零点**。
而 09-28 这一天在询单表里的行**根本不存在** —— 所以 `got 0`。

### 09-28 的行去哪了：**`店铺` 字段存的是选项 ID，不是店名**

OpenAPI 实读 `tblUnwn05vl8Wik9` 全表 2197 行后：

- 字段 `店铺` `type=3`（SingleSelect）。**OpenAPI 返回的是选项 id**（如 `optldTjNbD`），
  不是店名；而匹配用的 `cell(record.fields?.['店铺']) === shop` 拿店名（如 `盖文淘宝`）去比 ⇒ 永远不等。
- 表里 09-28 那 12 行的 `店铺` 全是 `optXXX` 形状（12 家：`optU1M49NJ`/`optd3cotzq`/`optMNT1l94`/`optldTjNbD`…），
  而 09-14~09-27 的历史行 `店铺` 都是**店名**（`盖文淘宝` 182 行）。
  ⇒ **09-28 那批行与我方写入的行不是同一批产物**，且 `日期` 也不等于我方 epoch。

**旁证（决定性）**：`盖文淘宝` 在询单表的日期序列是
`…09-24 → 09-25 → 09-26 → 09-27 → 09-29 → 09-30`，**独独缺 09-28**。
12 家店全部如此。⇒ 09-28 这天询单表**确实一行都没有我方该写的那一行**。

**后果**：本轮询单量写入 **0 行**。写后回读里那 2 行有值的（`optIYzOzu2` 16/34、`optFFaXJeh` 5/6）
是**别人/别的流程**写进去的（店铺是选项 id、不是我方店名），不是我方本轮写的。
初版 README 说「它们的 recordId 在写前基线里已存在」——这句是对的，但结论挂错了表。

### 结论与待办

- `tableId` **不要改**（初版说「要人拍板改哪张表」是错的，我撤回）。
- 要修的是**两处匹配**：① `店铺` 要按 **SingleSelect 选项 id ↔ 店名**映射比对
  （项目里已有类似 `resolvedBy: 'field-option-id'` 的解析先例，见独立回读快照）；
  ② 确认我方写入时 `日期` 落的是北京零点，与 `reportDateEpoch` 同日。
- 另需查清：09-28 那 12 行「选项 id + 无值」的行是谁写的（疑似看板/人工/另一条链），
  它与我方写入是**两套并存**的形态 —— 这正是 `got 0`（而不是 `got 2`）的直接原因。

## 修复回环：**计划了、执行路径整条是死的**（确认）

`summary.json` 五家 `autoRepair` 同形：

```json
{ "enabled": true, "maxRounds": 1,
  "rounds": [{ "round": 1,
    "action": {"action":"REAPPLY_DATES","mutating":true,"why":"…"},
    "applied": false,
    "retry": {"attempted": false, "why": "修复动作没落地，不重试阶段（避免原样再来一遍）"},
    "detail": "修复动作自己出错：Failed to parse URL from [object Object]/targets" }],
  "rescued": false,
  "gaveUp": "用完 1 轮（候选还剩 [object Object]）" }
```

根因：`executeRepairCandidate`（`run-multi-shop-day.mjs:1203`）`const action = list[0]`
取到的是**候选对象** `{action, mutating, why}`（契约见 `repair-actions.mjs:116`），
却把它当动作名字符串一路传给 `execRepair` → `applyRepairAction`。
后者的四路 `args.action === 'DISMISS_OVERLAYS' / 'RELOAD_PAGE' / 'RESET_PAGES' / 'REAPPLY_DATES'`
全部落空 ⇒ 抛 `没有实现的动作：[object Object]`；`readTargets` 那侧则先炸
`Failed to parse URL from [object Object]/targets`。

⇒ **`--auto-repair` 打开后，五家都「试了 1 轮、applied=false、不重试」，等于零修复动作真正执行过。**

测试为何漏掉：`run-multi-shop-day.test.mjs:1424` 传的是**字符串数组**
`candidates: ['DISMISS_OVERLAYS','RELOAD_PAGE']`，生产传的是**对象数组** —— 函数级用例全绿、接线是断的。

**而且就算修好这一处，也救不了本轮这 5 家**：4 家的 `backfill` 是表/行错配（修复动作碰不到飞书表结构）；
里可林是 R-D（下表），`REPAIR_TABLE` 给它的 `RELOAD_PAGE`/`REAPPLY_DATES` 对它无效。

## 告警（三层降级的第三层被提前触发）

链自己的告警在 `run-batches.mjs` 里**先发了**：`daily-round-20260928`，status=SENT，
收件人 `ou_e254f8d7d91a042b31fcd59299a1a4a9`，19:13 发送（fingerprint 五家 STAGE_FAILED）。
⇒ **「不先用飞书叫人」这条规则在当前脚本形态下不成立**：脚本层没有「先唤醒 agent」的概念，
它按老样子分诊→告警。会话侧的 `escalation-plan.mjs` 派单只能**事后**跑（本轮 needsAgent=true，5 家）。

## 各店停在哪儿 / 与 09-28 旧形态的对比

- 里可林淘宝：停在 `promotion-fetch`（第 6 步）。**本轮失败形态 ≠ 09-28 的 `action-row-hidden`** ——
  遮挡层被成功关掉、复选框点中（回读 checked=true）、入口定位成功、下载点击成功发出，
  但 **30s 内 `Downloads` 里没出现新 zip**（判据在文件系统上）。
  ⇒ 成因与页面无关，三个待查方向：平台侧丢导出 / Downloads 写入被拦 / 30s 不够。
  **注意**：`REPAIR_TABLE` 给这一成因的候选 `RELOAD_PAGE`/`REAPPLY_DATES` 对它**无效**
  （`RELOAD_PAGE` 反而会把「页面说生成成功」这个状态丢掉）。
- 网林天猫 / 盖文淘宝 / 盖文天猫 / 科塔淘宝：全部停在 `backfill`（第 10 步），但 **push 都成功**
  （底单各一行）。成因是上面的表/行错配。
  **网林比 09-28 前进了一大截**（09-28 它死在 `alimama-date`，本轮过了前 9 步）。

⇒ 本轮 5 家 **push 全过**（底单 4 行成行；里可林没走到 push），**`backfill` 成为新的集中失败点（4/5）**。

## 底单 vs 询单表 写入面小结

| 表 | 写前基线 | 写后回读 | 净增 |
|---|---|---|---|
| 底单（`tblkY3W8tnPWPcnh`）09-28 | 0 行 | 4 行 | **+4** |
| 询单表（`tblUnwn05vl8Wik9`）09-28 | 12 行（2 行有值） | 12 行（2 行有值） | **+0** |

## 释放

两遍独立回读（间隔 3s，结果一致）：19031~19035、19041~19045 **全 free**。
19022/19023 仍 LISTEN 是**预期**：共享商家浏览器不在本批 `--only <5店>` 范围内，
基线回读正是经它完成的，本轮未动它。

## 未修 / 挂账

1. **🔴 最高：`inquiry-core.mjs:52` 的 `店铺` 匹配改成「SingleSelect 选项 id ↔ 店名」映射** —— 这是 4/5 家失败的真因。
   `tableId` 不动；要动的只有匹配口径（先取字段 `property.options` 建 id→name 表，再同时接受两种形态）。
   另需查清 09-28 那 12 行「选项 id + 无值」骨架行的写入方（见 `evidence/inquiry-writeback-audit-2026-09-29/README.md`）。
2. **🔴 修复回环接线**（`list[0]` → 取 `.action`、`gaveUp` 文案别打 `[object Object]`）＋ 补**对象数组形状**的接线级用例。
   价值仅限「修复层不再是死的」，**不解决本轮这 5 家**。
3. **🔴 真机验证无现场**：五店代理端口（19041~19045）本轮结束已随批次释放，`repair-shop-stage.mjs --dry-run` 读不到目标页 ⇒ 未排练、未真跑。
4. **🟠 三层降级在脚本层缺位**：`run-batches.mjs` 的链级告警不问「有没有 agent 可派」就发飞书。
   要把「最后才叫人」做实，得让链知道「这一轮会有 agent 接管」，或给告警加抑制开关。
5. **🟠 别人未提交的补丁**：`collect-promotion-report.mjs` 的二次稳定判据、`readback-daily-report.mjs` 的退出码 4
   都已在工作区但未提交 —— **属别的会话在改的文件，未碰**；但它们一旦上线会改变失败形态。
6. **🟡 `run-receipt.json` 的 `stages[].status` 停在 PENDING**（顶层已 FAILED）—— 每步状态没回填。
7. **🟡 感知层拍错页**（09-29 上午已记录，本轮未复核）。
8. **🟡 `--auto-repair` 的 `applied=false` 把「动作自己炸了」与「动作做了但没成」混成一种** —— 建议单独喂 `error`。
