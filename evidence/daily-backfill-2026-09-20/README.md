# 2026-09-20 日报补跑（四家店真写飞书 + 科塔留证）

这一轮做的事：把 **09-20（昨日）**的日报补写进飞书「各店铺日报」底单，并把科塔那家店
「为什么补不了」的现场留成可核证据。运行时刻：2026-09-21 15:42–15:58（Asia/Shanghai）。

## 结果

底单（`各店铺日报`）**命中 2026-09-20 = 4 行**，四家各一行、无重复，`onDateCountIsLowerBound=false`（计数可信）：

| 店铺（底单「店铺名称」） | 对应窗口 |
|---|---|
| 里可林家居 | 里可林淘宝 |
| 网林家居旗舰店 | 网林天猫 |
| 盖文全卫定制 | 盖文淘宝 |
| 盖文旗舰店 | 盖文天猫 |

询单表同日两个字段也回填了：里可林淘宝 10/6、盖文淘宝 4/6、网林天猫 3/14、盖文天猫 10/35
（格式＝询单量/同层同行询单量）。**科塔淘宝 0 写入**（它停在第 4 步，早于第 7 步 push）。

补跑前基线：底单命中 09-20 = **0 行**（今早 11:41 那次定时真跑在里可林第 4 步就停了，飞书一个字没写）。

## 证据清单

- `baseline-before-count.txt` —— 写之前量的基线（底单 0 行）。`onDateCountIsLowerBound=false`。
- `count-after-first-run.txt` / `count-after-gw-tmall-resume.txt` / `final-readback.txt` —— 三次回读，
  分别对上「写了 3 行」「补完盖文天猫变 4 行」「最终仍是 4 行」。三次同口径、可交叉核对。
- `final-rows-named.txt` —— 那 4 行**指名提取**（同表「店铺名称」字段；「店铺」是 Lookup，
  页面模型里根本不带值，回读自己已明确报出这一点，所以不能用它当判据）。
- `resume-gw-tmall.log` —— 盖文天猫的断点续跑（只跑第 1/7/8/9/10/11 步，第 7 步的输入用**本轮已下载**的
  `--shop-xlsx`/`--promotion-zip`，不再向 alimama 多提交一次）。
- `kill-forensics.txt` —— 第一次整轮为什么停在盖文天猫第 7 步：`job.log` 的 mtime = 命令超时被 SIGTERM
  的那一刻。前三家已走完 11 步，记录在案。
- `keta-fresh-tab-probe.json` —— 科塔页面被平台弹回的决定性试验：**新建**一个 pinned 页签也一样，
  5/15/25/35/45 秒五次采样全落在 `https://sycm.taobao.com/mc/free/sycm`。
- `keta-targets-after-refresh.json` / `refresh-shop-pages-open.txt` —— 领回（reclaim）那条路同样被弹回；
  刷新工具自报「工作页=1」而原始页签列表里匹配性能页片段的页签是 **0** 个。
- `keta-close-probe-tab.json` —— 探针自己新建的那一页已关掉，科塔浏览器恢复成动手前的两个页签。
- `keta-run.log` —— 把科塔过一遍链留下的权威记录与**收信人看到的告警文案**（`--notify-print`，只打印未投递）。
- `shop-pages-before.txt` / `instances-before.txt` —— 起跑前的页面与实例盘点（7 个实例全部就位）。
- `final-rows-named.txt` 的原始来源：`evidence/daily-report-2026-09-20/independent-readback.json`（2.9 MB，
  页面模型原始 dump，未复制进这里）。

## 两次「被打断」的说明（不是链的故障）

1. **第一次整轮被掐断**：`run-daily-job.mjs` 在前台跑了 10 分钟后被 SIGTERM（`kill-forensics.txt`），
   当时正好轮到盖文天猫第 7 步 push。前三家 11 步已全部走完并写入；盖文天猫第 7 步**没有**写
   （底单从 +3 行到 +4 行之间只差它一行，且它的询单量当时仍是空）。
2. **科塔那条告警文案与现场对不上**：它的体检**通过了**——领回那一刻性能页确实在位（归位读的是
   约 2 秒的窗口），而弹回发生在约 5 秒后，所以失败拖到第 4 步才暴露，收信人拿到的是
   「这一轮不需要你在浏览器里做什么」。这是「体检假绿 + 文案结论判错」的组合，见
   `docs/ops/FULL-AUTOMATION-STATE-CONTRACT-2026-09-21.md` §十一 11.3，**尚未修**。
