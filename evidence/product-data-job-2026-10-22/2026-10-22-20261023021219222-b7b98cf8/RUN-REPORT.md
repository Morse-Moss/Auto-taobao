# 商品数据链运行报告 · 目标日 2026-10-22

- **退出码：1（本轮失败）**
- 命令：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5`（原样，未加 `--skip-promotion`）
- runId：`2026-10-22-20261023021219222-b7b98cf8`
- 执行窗口：2026-10-23 10:12:22 → 10:30:57（+08），18m35s
- 开工前 `runtime/.workflow-locks/merchant-automation.json` 不存在；HEAD `0856df8e`（1.12.15）
- 8 家 2 批（5+3），口径＝`productDataCollectingShopKeys()`；销售2部 5 家未参与

## 结论

| 段 | 成/总 | 行数 |
|---|---|---|
| 商品底单 | 3/8 | 77（46+29+2） |
| 询单 | 0/8 | 0 |
| 推广 | 0/8 | 0（未尝试） |

**两个互相独立的根因**，链把它们压成了一条 `TRANSIENT_EXTERNAL`：

1. **批 1 五家底单连片 CDP 超时**（`/eval HTTP 500 CDP 命令超时: Runtime.evaluate`）＝宿主资源压力，与 2026-10-20 同形。
2. **询单 100% 硬失败**＝`1.12.14`（`5733fffd`，今晨 09:14）引入的**代码缺陷**，确定性失败、重试无用。

## 根因一：批 1 五家（商品底单）

- 五家全部 `stoppedAt=product-collect`，错误一致：`采集失败：/eval HTTP 500 {"error":"CDP 命令超时: Runtime.evaluate"}`（02:18:28–02:22:57）。
- 视口回读 02:12:40 时五家全过（1506x642）＝同一批代理当时 `/eval` 是通的；导航到商品排行页后 eval 才开始超时。
- 宿主当场实测：**可用内存 1.37GB / 31.06GB、CPU 100%**（WorkBuddy 6.2GB、Memory Compression 4.2GB、vmmemWSL 2.8GB）。
- 对照组：批 2 只有 3 个实例，同一份代码、同一个导航 URL（含 `dateRange` ），三家底单**一次成功**。
- ⇒ 归类 **TRANSIENT_EXTERNAL（宿主资源压力）**，不是登录、不是权限、不是页面改版。重试前应先降并发/等内存。
- 注意：本次跑使用的是工作区中**另一会话 09:38 未提交**的 `collect-product-core.mjs`（`itemRankUrlFor` 把目标日写进 URL）。批 2 用同一份代码成功 ⇒ 该改动与批 1 失败无关。

## 根因二：询单 0/8（代码缺陷，确定性）

批 2 三家均在**第一次读取**就抛：

```
Error: 400 {"error":"SyntaxError: Unexpected token '{'"}
  at evalOn (collect-inquiry-report.mjs:13:67)
  at read  (collect-inquiry-report.mjs:98:209)   ← pollInquiryLink 的 read
```

`skills/sycm-inquiry-data/scripts/collect-inquiry-report.mjs:90`：

```js
const READ_PAGE_STATE="(()=>{ ... ($ {PAGE_MARKER_EXPR}) ... })()"
```

该行是**双引号**字符串，`${PAGE_MARKER_EXPR}` **不会插值**，原样发到页面后 `$` 被当成标识符、紧接 `{` ⇒ 页面解析 `SyntaxError: Unexpected token '{'` ⇒ 代理返 400 ⇒ 抛。

- 同文件 `READ_ENTRY_STATE`（第 44 行）用的是反引号模板，所以入口那步能跑；只有页面读取这步是坏的。
- 复现（只读）：取出该字面量后 `new Function("return "+expr)` 即报同一个 `SyntaxError: Unexpected token '{'`。
- **守卫为什么没拦住**：`inquiry-core.test.mjs:142` 断言的是
  `COLLECT_SOURCE.includes('${PAGE_MARKER_EXPR}')` —— 恰恰因为**没有插值**，这段字面量才存在，守卫把 bug 当成合规证据。
  这正是「用例钉了字面量、没钉调用侧真传了什么」的第四次发作。
- 影响面：8 家全中（批 1 五家因底单先失败没走到这一步，但只要走到必然同错）。

## 推广 0/8

- 批 2 三家 `stoppedAt=inquiry-collect` ⇒ **推广段根本没尝试**。
- 但 `run-receipt.json` 的 gaps 把询单的报错原文复读成「<店>/推广 未采集」 ⇒ 11 处缺口里有 3 处是把同一件事数了两遍。
  读缺口清单时不要把它当"推广也失败了"。

## 独立回读（不采信链自报）

`tmp/readback-product-baseline-1020.mjs`，跑前/跑后各一次，base `10月商品监控表-销售1部`（rcnb 凭据）：

| 表 | 日期字段 | 跑前 total/onDate | 跑后 total/onDate | 真实新增 |
|---|---|---|---|---|
| 商品底单 | 统计日期 | 4707 / 0 | 4784 / **77** | **+77** |
| 询单底单 | 数据日期 | 976 / 1 | 976 / **1** | **+0** |
| 推广底单 | 日期 | 2537 / 0 | 2537 / **0** | **+0** |

- 77 = 收据 `plannedRows` 46+29+2，**逐值一致**；收据 `existingRows` 4707→4753→4782→afterRows 4784 自洽。
- 询单目标日那 1 行是**开工前已存在**（基线就是 1），不是本轮写入；且 `店铺` 字段为空，非本链产物。

## 前置闸门 / 释放

- 飞书目标预检：1 base × 3 表凭据全认（OK）。
- 登录预检：b1/b2 均 `ALL_IN`，8/8 `needHuman=[]`；无人工闸门。
- 视口：8/8 家 1506x642 过闸。
- 释放：链自报 b1 `released:false`（`taskkill` 报 pid 39088 子进程未终止、盘点到 `unconfirmed`）、b2 `released:true`；
  **独立两次回读 28 个登记端口全 free**，店铺 profile 的 `msedge` = 0 ⇒ 实际已释放，b1 的 `false` 是它自己判据的问题。

## 恢复动作（未执行，需授权）

1. 先修 `READ_PAGE_STATE` 的双引号→反引号（并把 `inquiry-core.test.mjs:142` 的断言改成钉"调用侧真的展开成词表"），否则询单永远 0。
2. 内存压力缓解后重跑 8 家（或先只补批 1 那 5 家）。
3. 本报告只做取证与归类，**未改任何代码/配置、未重跑、未起停任何进程、未删锁**。
