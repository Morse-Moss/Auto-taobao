# 商品数据入口修复与重跑结论（2026-09-27）

## 结论

修掉 **2 类、6 处**缺陷后重跑成功：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify`
**退出码 0**，五家店三类数据全部采集并写入飞书，重跑新增 0 行，五店浏览器与代理已释放（独立两次回读）。
修复前同一命令连跑 4 轮、飞书**零写入**。

## 本轮结果（目标日 2026-09-26）

- runId：`2026-09-26-20260927145927861-03ec0bd9`（11m53s）
- 收据：`run-receipt.json` → `status: COMPLETED`、`failure: null`、`failedStage: null`、三段全 `COMPLETED`

| 店铺 | 底单源行/计划 | 底单后行数 | 询单源行/计划 | 询单后行数 | 推广（批量） |
|---|---|---|---|---|---|
| 里可林淘宝 | 24 / 24 | 4581→4605 | 0 / 0 | 1005 | 计入批量 |
| 网林天猫 | 14 / 14 | 4605→4619 | 4 / 4 | 1005→1009 | 计入批量 |
| 盖文淘宝 | 52 / 52 | 4619→4671 | 7 / 7 | 1009→1016 | 计入批量 |
| 盖文天猫 | 43 / 43 | 4671→4714 | 9 / 9 | 1016→1025 | 计入批量 |
| 科塔淘宝 | 32 / 32 | 4714→4746 | 3 / 3 | 1025→1028 | 计入批量 |

- 推广：五家一次批量写入，`sourceRows 92 / plannedRows 92 / duplicateRows 0`，表行 2472→2564。
- 幂等（用刚写完的同一批产物重算，dry-run，不写飞书）：五家三段 `plannedRows` **全部 0**，
  推广 `duplicateRows == sourceRows` ⇒ 「重跑新增 0 行」成立。
- 释放：`release.json` 逐条带证据（代理命令行匹配 `start-shop-proxy.mjs <店名>`、浏览器 CDP 自证 profile 一致）
  真执行 taskkill 并「停后盘点到 missing」；`checks[].listening` 两次均为 0、`error: null`、`released: true`。
- 独立回读（`Get-NetTCPConnection -LocalPort <p> -State Listen`，两次，脚本外执行）：
  19031~19035、19041~19045 **全 free**。

## 修了什么

### A. 宿主沙箱 `EBUSY`（同一病根，三处不同症状）

本机沙箱对「给了子进程 stdin 管道的同步 spawn」直接回 `EBUSY`（`errno=-4082`），此时
`status=null`、`stdout=null`、`stderr=''`。取证脚本 `probe-spawn-stdio.mjs`：

```
default(no stdio):      {"status":null,"errno":"EBUSY","err":"spawnSync py EBUSY","stderr":""}
stdio ignore/pipe/pipe: {"status":0,"stdoutLen":5289}
```

1. **导入全灭（本轮主因）**：`skills/sycm-{product,inquiry,promotion}-data/scripts/import-*.mjs`
   的 `spawnSync(py, ['-3', …])` 没写 `stdio` ⇒ 被读成 `XLS parser failed` / `ZIP parse failed`
   （文案里没有 traceback，因为压根没起进程）。python 本身正常（`py -3` = Python 3.12.9）。
   **这是修复前 4 轮飞书零写入的直接原因**；修法＝补 `stdio: ['ignore','pipe','pipe']` + 报错带上真因。
2. **释放回读是恒真断言**：`scripts/release-product-data-browsers.mjs` 的 `listening()` 同样没写 `stdio`
   ⇒ `Number('')||0` **恒等于 0** ⇒ `released` 恒 `true`。取证：
   `listen-asIs {"status":null,"errno":"EBUSY"}` vs `listen-fixed {"status":0,"stdout":"2"}`。
   修法＝补 `stdio`，并把「读不出来」返回 `null`（＝没有证据），只有读到 0 才算释放。
3. **`stop-all.mjs` 假绿**：`listenTableNow()` 读 `netstat` 失败后返回空表 ⇒ 每个 pid 都是 null ⇒
   断言「没有在跑，无需处理」并退 0；`taskkill` 那处用 `stdio:'pipe'`（含 stdin 管道）也会 `EBUSY`。
   修法＝两处补 `stdio`；监听表读不出来时**不再下「已释放」结论**，`--yes` 下非 0 收场，报告里多 `listenTableError`。
4. **连带修**：`runtime/browser-inventory.mjs` 的 `readProcessTable`（`:275`）与监听表（`:336`）同样缺 `stdio`
   ⇒ 拿不到进程命令行 ⇒ **代理永远被判「认不出启动脚本」而拒停**。不留这处，修完 1~3 会从「假绿」变「假红」。

### B. 询单表头契约与真实文件不符（被 A 掩盖的第二层缺陷）

- 症状：五家店 `询单报表缺少 12 列标准表头`。
- 定性：**不是平台改版**。仓库里 2026-09-23 存档的原始导出
  （`evidence/product-inquiry-2026-09-23/gaiwen-*.xls`，契约就是照它写的）真实列名是
  `最终付款人数/最终付款金额/最终付款件数`，**没有「延」**；2026-09-26 新导出的五份同样无「延」。
- 那契约里的「延」从哪来：当初走 xlrd 读、中文 BIFF 标签变乱码，命中的是「第 6 个使用行 + 12 列形状」
  那个兜底分支（形状对得上、真列名从没被读出来）。这台机器上 COM（pywin32）可用、中文被正确解出后，
  逐字匹配与乱码兜底同时失效 ⇒ 五家全灭。旧用例把 `INQUIRY_HEADERS` 自己当夹具，等于从未验过「契约 vs 真实文件」。
- 修法：`inquiry-core.mjs` 引入 `HEADER_ALIASES`（三个无「延」写法视为同一列，写回目标字段不变），
  失败时把**实际表头**写进报错；补 3 条回归用例（真实文件形状 / 乱码兜底 / 报错带实际表头）。

### C. 新增守卫

`runtime/product-data-path-sync-spawn-guard.test.mjs`：钉住这条链 13 个文件里「同步 spawn 必须显式写
`stdio` 且 stdin 不是管道」。突变验证 `mutation-verify-guard.mjs` 结果：4 种突变**全红且点名正确**
（导入点去掉 stdio / stop-all 去掉 stdio / stop-all 改回 `stdio:'pipe'` / release 去掉 stdio），
还原 sha256 一致、还原后回绿。**范围故意不是全仓**：全仓版会因为别的会话正在改的文件立刻变红。

## 未做 / 需知

- **架构守卫 `runtime/arch-boundary.test.mjs` 仍红**（2/3 pass）：`skills/xws-export-market-analysis/scripts/supervise-adaptive-export.mjs`
  未在 `SKILLS_TO_RUNTIME` 登记。**不是本次改动造成**，该技能组今天由别的会话在改（git status 全组 ` M`），未触碰。
- **里可林淘宝 09-26 询单为 0 行**：平台导出文件里只有表头 + 平均值/汇总值，没有商品行。
  这是平台真实返回（09-25 同店为 5 行），按事实记录，不当作失败。
- **19022 / 19023 仍在监听**（pid 29664 msedge、71260 node）：日报链 18:36 起的商家浏览器与代理，
  不由本入口启动、不在其释放范围，**未触碰**。
- **改动尚未提交**：工作区同时存在别的会话在改的文件（xws 技能组、`run-daily-job.mjs`、`runtime/*` 等），
  混成一个提交不安全；本次未跑 `check:staged` / `test:staged`（未提交），提交时按显式路径分批走。

## 复现与验证命令

```bash
# 主命令（本轮）
node scripts/run-product-data-job.mjs --date yesterday --commit --notify

# EBUSY 取证（同一台机器、同一会话形态）
node evidence/import-ebusy-fix-2026-09-27/probe-spawn-stdio.mjs "<任意 09-26 导出的 xls>"
node evidence/import-ebusy-fix-2026-09-27/probe-release-reads.mjs

# 解析层与幂等（dry-run，不写飞书）
node evidence/import-ebusy-fix-2026-09-27/dryrun-imports.mjs                # 修复前那一轮产物
node evidence/import-ebusy-fix-2026-09-27/dryrun-imports.mjs evidence/product-data-job-2026-09-26/<runId>

# 守卫与突变验证
node --test runtime/product-data-path-sync-spawn-guard.test.mjs
node evidence/import-ebusy-fix-2026-09-27/mutation-verify-guard.mjs

# 独立端口回读（两次，脚本外）
Get-NetTCPConnection -LocalPort 19031 -State Listen
```
