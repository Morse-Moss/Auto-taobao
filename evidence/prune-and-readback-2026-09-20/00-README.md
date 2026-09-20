# 页签清理与回读的两处缺陷（2026-09-20 午后，写飞书那一轮的副产品）

这一轮的正事是**把 2026-09-19 的日报写进飞书**。写的过程里撞到两处工具缺陷，都在本目录留了原始输出。
两处的共同形状值得单独记一笔：**判据本身没错，错在「什么时候去读／读几遍」**。

## 一、`pruneTabsOn` 的回读读得太早 ⇒ 把成功的关闭报成失败

### 现场（这是发现它的原因）
补跑盖文天猫时，`node runtime/shop-window-label.mjs --prune --commit --only 盖文天猫` 报：

```
"pruneClosed": [],
"pruneFailed": [
  { "targetId": "7CA04D24BF867D3BDC8A5FE3598024FE", "url": ".../report_generation?...type=preview",
    "error": "关完回读它还在：/close 返回成功但页面没有真的关掉" },
  { "targetId": "8C0AFB7614419BBA3ACF550C7D4B8D03", "url": "about:blank",
    "error": "关完回读它还在：/close 返回成功但页面没有真的关掉" }
]
```

紧接着**同一个命令的只读模式**再查一次，两个页签**都已经不在了**（`01-prune-readback-before.txt`）。
⇒ 不是「关不掉」，是**回读做得太早**。

### 量出来的数（`02-close-latency.txt`，探针 `measure-close-latency.mjs`）
用里可林淘宝那台的一个 `about:blank` 残留（它本来就在关闭计划上，所以这次关闭也是该做的清理）：

```
/close HTTP 200 body={"success":true}
消失耗时 = 270ms
采样：8ms 还在 | 270ms 已消失
```

### 修法
`runtime/shop-window-label.mjs` 的 `pruneTabsOn` 改成**最多读 `readAttempts`（默认 3）次、每次间隔
`readIntervalMs`（默认 600ms）**，中途全部消失就收手（不等满预算）；错误信息里带上「读了几次」，
好把「真关不掉」与「读得太早」分开。

### 为什么这条和原有的那条不矛盾（这是关键）
2026-09-18 的注释写的是「**不信 `/close` 的返回码，关完回读一遍**」（当时 `edge://nurturing/` 返回 success
但 3 秒后仍在）。今天这条是它的**镜像**：返回码不可信 ⇒ 要回读；回读也不能只读一遍 ⇒ 要等一拍。
两个坑方向相反，合起来才是完整口径。

## 二、`readback-daily-report.mjs` 的截图失败会毁掉整份回读产物

### 现场
盖文天猫的 readback 两次复现同一个失败（`05-screenshot-degrade.txt`）：

```
Error: CDP 命令超时: Page.captureScreenshot
    at screenshot (readback-daily-report.mjs:279:27)
    at async main (readback-daily-report.mjs:365:41)
```

且 **stdout 完全为空** —— 因为它死在**第一张表读完之后的截图**上，而
`independent-readback.json` 写在 `try` 之后，**根本不会落盘**。两张表的独立回读当时已经读到手了。

### 不是「页面不可见」（探针 `probe-merchant-visibility.mjs`）
```
{"visibilityState":"visible","hidden":false,"hasFocus":true,"innerWidth":1528,"innerHeight":732,"bodyLen":591408}
截图 HTTP 500，耗时 30.0s
```
页面可见、有焦点、视口 1528×732；**是这张页面（正文 59 万字符）截图本身就超过代理里
`sendCDP` 的 30 秒固定超时**。同一时刻另一张表（询单表，小得多）截图成功 ⇒ 与「截图功能坏了」无关。

### 修法
新增 `captureScreenshotSafe`（导出、可注入 `shot`/`warn`）：截图失败**降级不抛**，
产物里写 `screenshots[key]=null` + `screenshotErrors`，stderr 大声报出来，主证据照常落盘；
退出码仍非零（否则 stage 报成功，而产物里明明缺图），措辞把「数据已核对」与「截图缺失」**分成两句**。

### 真机验证（`05-screenshot-degrade.txt`）
```
[screenshot] 截图失败：CDP 命令超时: Page.captureScreenshot（数据回读不受影响，照常继续；…）
readbackPath = …\daily-report-2026-09-19-盖文天猫\independent-readback.json
底单: recordsNum=1890 loaded=1890 命中 2026-09-19=5
询单表: recordsNum=2197 loaded=2197 命中 2026-09-19=12
  screenshot(source) → 缺失（见上面 [screenshot] 警告；数据回读不受影响）
  screenshot(inquiry) → …\feishu-inquiry-table-after-backfill.png
[不完整] 数据回读已核对并落盘：…
[不完整] 但有 1 张截图没取到：底单（CDP 命令超时: Page.captureScreenshot）
```
⇒ 主证据保住了，缺的证据如实说出来。

## 三、还没修的那一处（本节只记录，未动手）

`runtime/shop-pages.mjs --open` 在「某页缺、但同主机有一页漂移到别的 URL」时会**新建**一页，
而不是把那页**领回来**（`planPageActions` 只看「期望页面的匹配数」，看不见漂移页）。

后果链（这一轮就是这样被绊住的）：上一轮在第 5 步失败 ⇒ 工作页被留在报表预览 URL ⇒ 体检报缺页 ⇒
`--open` 新建一个 ⇒ 同主机两个 sycm 页签 ⇒ 第 5 步把新的那个也留在预览页 ⇒
`run-multi-shop-day.mjs` 的 `resetSycmPage` 看到 2 个漂移页、按 fail-closed 停手（它宁可报错也不乱导航，这是对的）。

当场的处置是人工两步：`shop-window-label.mjs --prune --commit` 关掉重复的那个，
再把剩下的那个导航回工作页（探针 `reclaim-sycm-19045.mjs`，逐字照 `resetSycmPage` 的判据）。
**正确修法在 `shop-pages.mjs` 的规划器里**：缺页时先找「同主机、不属于任何期望页面」的那一页，
恰好一个就 `reclaim`（导航回去），0 个才 `create`。

## 四、这一轮的写飞书结果（背景，证据在别处）

`evidence/multi-shop-2026-09-19/`（逐店日志 + `summary.json`）与五家逐店证据目录。
独立回读（不采信自报）：底单 1890 行、当日 **5 行**（五家齐）；询单表当日 12 行里**我们五家全部已填**
（盖文天猫 10/35、网林天猫 2/13、科塔淘宝 6/6、里可林淘宝 6/6、盖文淘宝 4/6），
其余 7 行是别家、仍为空 —— 与写前基线逐项吻合。

## 五、验证

- 突变验证：`04-mutation-prune.txt` **3/3**、`06-mutation-screenshot.txt` **4/4**，各自点名到期望用例，还原后 sha256 逐字节一致。
- 离线套件：`skills` **746/746**（`probe-live/suite-skills-2026-09-20b.txt`）、
  `runtime` 见 `probe-live/suite-runtime-2026-09-20b.txt`。
- 真机：`--prune --commit` 把 3 个 `about:blank` 记进 `pruneClosed`、`pruneFailed` 为空、exit 0（`03-prune-readback-after.txt`）。

## 六、文件索引

| 文件 | 是什么 |
|---|---|
| `01-prune-readback-before.txt` | 修复前：`pruneClosed` 空、两条进 `pruneFailed`（而它们其实已经关掉了） |
| `02-close-latency.txt` | 实测「关闭 → 从 `/targets` 消失」= **270ms**（8ms 还在） |
| `03-prune-readback-after.txt` | 修复后同一条命令：3 个 `about:blank` 进 `pruneClosed`、`pruneFailed` 空、exit 0 |
| `04-mutation-prune.txt` | 页签清理修复的突变验证 **3/3**（含还原后 sha256 逐字节一致） |
| `05-screenshot-degrade.txt` | 修复后真机回读：主证据落盘、缺 1 张截图、如实报出 |
| `06-mutation-screenshot.txt` | 回读截图修复的突变验证 **4/4** |
| `07-merchant-visibility.txt` | 证伪「页面不可见」：`visible`/`focused`/1528×732，截图仍 30.0s 超时 |
| `08-commit-run3.txt` | 补跑两家：科塔淘宝 11/11 全绿；盖文天猫倒在 `sycm-reset`（同主机 2 个漂移页） |
| `09-commit-run4.txt` | 补跑盖文天猫剩余四步：前三步过，`readback` 倒在截图 |
| `10-reclaim-sycm-page.txt` | 把漂移的生意参谋页导航回工作页（逐字照 `resetSycmPage` 的判据） |
