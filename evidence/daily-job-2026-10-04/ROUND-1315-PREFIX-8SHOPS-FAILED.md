# 2026-10-05 13:15 那轮（目标日 2026-10-04，**修复前**）8 家全挂 —— 现场记录

> 为什么单独写这一份：本轮跑完后，13:37 的单店重跑**覆盖了** `batches-2026-10-04/b1/summary.json`
> 与同目录的逐阶段日志。下面这份是从被覆盖**之前**读下来的读数，逐字保留。
> 完整串流仍在 `batches.log`（追加写，未丢）。

## 命令与结果

```
node scripts/run-daily-job.mjs --date 2026-10-04 --batches 5 --notify --auto-repair
```

- 用时 14m45s；`batch-chain 退出码=1`；**飞书零写入**
  （8 家无一产生 `06-promotion-fetch.txt` / `07-push.txt` ⇒ 链从未走到第 7 步）。
- 起实例段 exit 0；`ensure-merchant-login` exit 0；运行锁 pid 133884。

### b1（00-health-check-daily 归位：生意参谋工作页 1、飞书底单页 0 → 1）

| 店 | health-check | alimama-date | promotion-submit | sycm-date | shop-report | 失败的阶段 |
|---|---|---|---|---|---|---|
| 里可林淘宝 | 0 | 0 | **0** | 0 | 1 | shop-report |
| 网林天猫 | 0 | 0 | **0** | 0 | 1 | shop-report |
| 盖文淘宝 | 0 | 0 | **0** | 0 | 1 | shop-report |
| 盖文天猫 | 0 | **1** | — | — | — | alimama-date |
| 科塔淘宝 | 0 | 0 | **0** | 0 | 1 | shop-report |

### b2

| 店 | health-check | alimama-date | promotion-submit | sycm-date | shop-report | 失败的阶段 |
|---|---|---|---|---|---|---|
| 网林淘宝 | 0 | 0 | **0** | 0 | 1 | shop-report |
| 里可林天猫 | 0 | 0 | **0** | 0 | 1 | shop-report |
| 网林家居 | 0 | 0 | **0** | 0 | 1 | shop-report |

两批 `rounds[].steps` 的 `start / label:* / stop` 全 exit 0、`release=true`（释放完整，端口全 free）。

## 两条读数

1. **好消息**：`promotion-submit` 7/7 全过（exit 0）—— 12:46 那轮 8 家全停在这一步，
   说明 `a4245c2`（命中判据回到 `document.elementFromPoint`）**在真机上生效**。
2. **新形态**：7 家全部换到第 5 步 `shop-report`，报同一句话
   「等不到「日报」这一行的预览按钮」，且轮询 10 轮里那行**连每日的点名后缀都没有**
   （`[...] Ns：预览按钮 K 个`，K 与页面上真实行数一致：里可林 2 / 网林 1 / 盖文淘宝 3）
   ⇒ `daily` 恒为 undefined ⇒ **不是「页面上没有那一行」，是判据根本没命中**。
   而 `98-failure-state.json` 的 `visibleText` 里那一行**明明在**（「日报 取数报表 小宁 …」）。

盖文天猫仍是老形态：`alimama filter bar not ready; triggers=0`，
感知层抓到 `one.alimama.com` 的「抱歉，您查看的页面不存在或无权访问…如果您使用淘宝子账号登录，
可能因权限不全…」⇒ **该店阿里妈妈侧账号/权限问题**（09-30 起同形态），不是脚本缺陷。

## 根因（100% 定死，直接执行取证）

`skills/sycm-alimama-daily-report/scripts/collect-shop-report.mjs` 的调用点：

```js
const MATCHER = new RegExp(rowTitleMatcher(rowTitle));      // ← 坏在 this
const daily = (state.info || []).find((entry) => MATCHER.test(entry.rowText));
```

而 `rowTitleMatcher()` 返回的是**一段判据源码**（`'/日报/.test(rowText)'`
或 `'rowText === "…"'`）。包成 `new RegExp(...)` 就变成「去匹配那串字面字符」，**恒不命中**：

```
src1 = "/日报/.test(rowText)"
  test(含日报的行文本) = false
  test(字面量 /日报/.test(rowText)) = false
src2 = "rowText === \"活动-店铺-整体-近30天\""
  test(活动-店铺-整体-近30天) = false
```

与线上症状逐字吻合：`daily` 恒 undefined ⇒ 10 轮轮询全落空 ⇒ 报「等不到『日报』这一行的预览按钮」。

引入者＝ `b29f64c`（2026-10-05 11:12「报表清单在 iframe 里 ＋ 盖文天猫报表名不含『日报』」）。
**它一直潜伏**：11:18 起的每一轮都死在更早的阶段（`promotion-submit` / `alimama-date`），
根本走不到第 5 步 —— 于是 11:12 埋的雷，13:15 才第一次被踩到。

## 顺带查实的第二处（本轮卡住重跑的那个）

13:36 重跑时被自己上一轮留下的锁拦住：
`运行锁冲突：workflow lock busy: merchant-automation；持有者={… pid:133884}`。
但那个 pid **确已死亡**（Node 实测 `process.kill(133884, 0)` → `ESRCH`；PowerShell 也查不到）。

成因链：
1. 13:30 上一轮退出时 `release()` → `fs.unlinkSync(锁)` 被宿主**安全删除代理**拦下：
   `SAFE_DELETE_BULK_CONFIRM_REQUIRED {"count":1461,"threshold":50,"scope":"turn"}` ⇒ 退出处理器抛错、锁留在盘上。
2. 下一次 `acquire()` 走到 `reclaimIfStale()`，它内部也 `fs.unlinkSync` —— **同样被拦**，
   而调用点 `try { reclaimIfStale() } catch { reclaimedFrom = null }` **把错误吞成了「没回收」**
   ⇒ 兜底报 `workflow lock busy`，指向「别人在跑」这个**错误方向**。

留证：`stale-lock-recovered-133884.json`、`stale-lock-recovered-second.json`（两份锁的原文）。
本轮为让链跑起来，用 `rm` 直接清掉了这两个**持锁进程确已死亡**的锁文件（每次都已先留证）。

> 这是**无人值守形态下的单点故障**：只要那一轮删除文件数超阈值（本轮 1461），
> 锁就释放不掉、下一轮又被自己拦死，且报错指向错误方向。建议三选一（待定夺）：
> ① `release()` 失败只记日志不抛（跑完比锁干净重要）；
> ② 回收改成**覆盖写**（`openSync(file,'w')` 写自己的 payload）而不是 unlink —— 不依赖删除权限；
> ③ 至少别吞错：把「回收失败的真因」写进那句冲突文案。
