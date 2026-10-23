# 商品数据链 2026-10-19 运行报告

- 命令（原样）：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5`
- 目标日：2026-10-19（Asia/Shanghai，yesterday）
- runId：`2026-10-19-20261020020912175-0dafaf3f`
- **退出码 1（本轮失败）**；run-receipt `FAILED`，链自报 `HUMAN_REQUIRED / PLATFORM_OR_HUMAN_GATE / failedStage=login`
- 告警：`product-round-20261019` → SENT（exit 0）
- 版本 1.12.10，HEAD `a1ff92f`；耗时 27m48s
- 开工前锁：`merchant-automation` 被 daily-report（pid 101228）占用但该 pid 已不在 ⇒ 链第 0 步自动回收（日志首行），未人工删锁

## 结果：8 家里只有 1 家出数据

| 店 | 商品底单 | 询单 | 推广 |
|---|---|---|---|
| 里可林淘宝 | 失败 product-collect（CDP /eval 超时） | — | — |
| 网林天猫 | **成功 27 行** | 源 0 行（剔除 2 行汇总行） | 失败 promotion-collect（CDP /eval 超时） |
| 盖文淘宝 | 失败 product-collect（日按钮 30s 未渲染） | — | — |
| 盖文天猫 | 失败 product-collect（页面只剩导航壳） | — | — |
| 科塔淘宝 | 失败 product-collect（日按钮 30s 未渲染） | — | — |
| 网林淘宝 | 失败 product-collect（CDP /eval 超时） | — | — |
| 里可林天猫 | 未开始（登录预检 UNREADABLE） | — | — |
| 网林家居 | 未开始（登录预检 UNREADABLE） | — | — |

## 独立回读（rcnb 凭据，跑前/跑后各一次）

| 表 | 表 id | 日期字段 | 总量 前→后 | 目标日 前→后 | 真实新增 |
|---|---|---|---|---|---|
| 商品底单 | tblvmGJfOL4OBYek | 统计日期 | 4194 → 4221 | 0 → 27 | **+27** |
| 询单底单 | tblb1uK5zQYd8yOq | 数据日期 | 891 → 891 | 1 → 1 | **+0** |
| 推广底单 | tblDxXenp3vSg2SM | 日期 | 2327 → 2327 | 0 → 0 | **+0** |

与收据逐值一致：商品 `sourceRows=27 / plannedRows=27 / afterRows=4221`（重复 0）；询单 `sourceRows=0 / excludedSummaryRows=2 / plannedRows=0`。

## 失败分类不成立的地方（判据）

链把整轮判成 `HUMAN_REQUIRED / PLATFORM_OR_HUMAN_GATE`，`failedStage=login`。取证不支持这个结论：

1. **没有一家店真的被踢到登录页**。batch1 补页后 `login-preflight-b1.json` = `ALL_IN`，5/5 `sycm/alimama=LOGGED_IN`；batch2 网林淘宝 `LOGGED_IN`。盖文天猫失败时 URL 是正常的 `sycm.taobao.com/cc/item_rank`，不是登录路由。
2. **里可林天猫 / 网林家居 的 UNREADABLE 来自 CDP 超时**，不是登录态：`detail = "http://127.0.0.1:19061/eval?target=… → HTTP 500 {CDP 命令超时: Runtime.evaluate}"`。登录模块自己也判 `verdict=UNKNOWN`、`needHuman=[]`、`roundNotify` 原因写「读不到不算要人」——链的总账把 UNREADABLE 升格成了 HUMAN_REQUIRED，与自家判据矛盾。
3. **同形失败横跨 6 家 3 段**：`/eval HTTP 500 CDP 命令超时`（里可林淘宝、网林淘宝、网林天猫推广）+ 页面只渲染出导航壳（盖文天猫 text 仅为「生意参谋 盖文旗舰店 主店 惠商 我的 帮助 退出」）+ 日按钮 30s 未渲染（盖文淘宝、科塔淘宝）。这是客户端读不到，不是平台闸门，也不是风控页。

### 真实成因：宿主资源枯竭（本轮实测）

- 开跑前：**可用内存 0.3 GB / 31.1 GB**，CPU 100%。
- 跑完：可用 0.42 GB，CPU 仍 100%。
- CPU 采样（5s 窗口）：WorkBuddy 72%、Memory Compression 66%、vmmemWSL 61%、ChatGPT 56%、两个 python 各 33-35%、System 27%。
- 旁证：泄漏的 19051 浏览器端口在听，但 `/json/version` 与 `/json/list` 全部无响应 ⇒ 浏览器主进程还活着、DevTools 已经僵死，和链里收到的 `Runtime.evaluate` 超时是同一形态。

结论口径：本轮应归 `TRANSIENT_EXTERNAL / HOST_RESOURCE_EXHAUSTION`，不是登录闸门。除 `--notify` 外未做任何重试（按要求只跑这一条命令）。

## 释放：未确认（按标准算失败）

- `release-b1.json`：`stopExitCode=0` 但两次探测 listening 5 → 3，`released=false`。
- `release-b2.json`：两次探测均 listening 3，`released=false`。
- 本人 PowerShell 两次回读（间隔 4s，两次一致）：`19022(pid=68368), 19023(pid=69204), 19051(pid=135144)`。
  - 19022/19023 = 日报链共享（开工前即在，非本链）。
  - **19051 = 里可林天猫 调试端口，仍在监听**，pid 135144 为 `msedge.exe`（`--user-data-dir=D:/Retire/edge-profiles/likelin-tmall --remote-debugging-port=19051 --window-size=1528,732`），父进程 85692 已被杀但子进程存活（release 日志里有 `could not be terminated`）。
- 网林家居早上遗留实例（19052/19062）已随 b2 释放，当前不再监听。
- 未擅自 kill 19051（按纪律：不动任何存活进程，等授权）。

## 其它已过闸门

- `feishu-target-preflight`：1 base / 3 表，凭据都被认（OK），未复现 10-17 凭据地雷。
- 视口：b1 5/5 = 1506x642；b2 网林淘宝 / 里可林天猫 1506x642、网林家居 1528x732（复用早上实例）——全部过 1200x600 闸。
- 商品 `--commit` 真写；询单 0 行属「源里只有汇总行」的已知形态（历史「恒 7/8」同族），不是写入失败。

## 未做

未改任何代码/配置；未重跑；未起停任何非本链进程；未删锁；未清理 19051。
