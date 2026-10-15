# 日报链「店铺报表」直下通道修复 —— 1.9.6 排练与验证记录（2026-10-15）

## 病根（当天已定死，探针原始产物在 tmp/rootcause-20261015/；归档版随轮提交在
evidence/rootcause-shop-report-stall-20261015/，其中 oss-full.xlsx 是真实店铺数据、未提交）

平台（生意参谋「自助分析·公共空间」）在 2026-10-14 中午之后把日报导出改成：
点「下载报表」→ `download.json` / `queryDownloadUrl.json`（都 200）→ OSS 生成文件 →
用 `target=_blank` 锚点打开 Microsoft Office Online Viewer 在新标签页**预览** ——
文件**永不落盘**。采集脚本的文件系统判据于是永远超时：目标日 2026-10-14 的日报链
8 家店 × 3 轮补跑全败在第 5 步（shop-report），飞书零写入。

- 探针实验 A（`/click`，JS 点击、不可信手势）：连新标签页都不弹，但页面**确实**走了
  两个 json 并自建了带 OSS 签名 URL 的锚点（`a.click()` 被调用）⇒ URL 在页面上拿得到，
  且不依赖可信手势。
- 探针实验 B（`/clickAt`，CDP 真实鼠标）：正常弹出 Viewer 标签页。
- OSS 签名 URL 可直下（curl 200，19732 字节，PK 头，单 `data` sheet、119 列，
  含 2026-10-14 / 网林天猫数据）。签名有时效（实测约 20 分钟量级）⇒ 必须随抓随下。
- 平台变更时间窗：10-14 11:07-11:50 还直接落盘（Downloads 有 5 份），今天 12:00 起全变。
- 对照组：同窗口商品链 8 个 xls（12:20-12:27）正常落盘 ⇒ 下载机制与文件系统判据都好，
   是这一条导出通道的行为变更。

## 修法（1.9.6，只动日报链自身）

新增 `skills/sycm-alimama-daily-report/scripts/shop-report-direct-download.mjs`：
`collect-shop-report.mjs` 点「下载报表」前装页面仪表（`anchor.click` / `window.open` /
`MutationObserver` 三渠道记 URL，href 一律拿全不许 slice；Viewer 地址从 `src` 取回 OSS URL）；
等待循环改**双通道并行**：老通道（下载目录新文件，平台若回滚仍有效）＋ 新通道
（Node 侧直取落盘）。直取前三道门：文件名得过店家 `reportPattern`、HTTP 200、
内容是 zip（PK 头）。两条通道都打同一句 `shopXlsxPath`（下游只认这一句）。
主机名一律不硬编码（平台换桶不该让链路瞎），文件名不认 ⇒ fail-closed 不收。

## 真机排练（网林天猫活窗口：浏览器 19032 / 代理 19042，用户留着看平台反应的那个）

命令（从仓库根）：

```
node skills/sycm-alimama-daily-report/scripts/collect-shop-report.mjs \
  --date 2026-10-14 --proxy http://127.0.0.1:19042 \
  --shop-key 网林天猫 --expect-shop 网林家居旗舰店 \
  --downloads D:/Retire/sycm-automation/tmp/direct-dl-rehearsal-20261015 \
  --log-dir D:/Retire/sycm-automation/tmp/direct-dl-rehearsal-20261015 \
  --timeout-ms 120000
```

实际输出（逐字）：

```
[0/4] 先回位到应用内页（上一次运行/排练可能把这一页留在日报预览页）
[身份] 生意参谋店铺名 = "网林家居旗舰店"（主店）｜期望 "网林家居旗舰店" ✓
      → 生意参谋页 0114DF27122EBA5C718B8AD070A719B1｜已有日报 xlsx 0 个｜下载目录 …tmp\direct-dl-rehearsal-20261015｜身份核对=已做
[1/4] 再进 自助分析 · 公共空间
[2/4] 2.5s：预览按钮 1 个，日报行 #0（命中复核=true，视口内=true）
[2/4] 点开「日报」预览（#0）→ {"clicked":true,"tag":"A","text":"预览"}
[3/4] 3s：统计区间=["2026-09-15","2026-10-14"]｜下载按钮=true
[3/4] 统计区间 2026-09-15 ~ 2026-10-14 含目标日 2026-10-14 ✓
[4/4] 装直下通道仪表（平台 10-15 起把日报导出改成在线预览，文件不落盘）
[4/4] 点「下载报表」
      → y=603（中心点命中） → {"clicked":true,"tag":"SPAN","text":"下载报表"}
      直下 URL 已捕获 → 新文件：日报_20261015_65141cc3c0fd0c526f65e7da28ff800b.xlsx（19731 bytes）
      shopXlsxPath = D:\Retire\sycm-automation\tmp\direct-dl-rehearsal-20261015\日报_20261015_65141cc3c0fd0c526f65e7da28ff800b.xlsx
```

产物内容校验（openpyxl 直读排练落盘的那份）：sheets=`['data']`；31 行 × 119 列；
含 `2026-10-14` 的行 = 第 1 行，该行首个非空单元格序列
`2026-10-14 / 网林家居旗舰店 / 102 / 0 / 1 / 0 / 7 / 0` ⇒ 是目标日、本店的工作簿。
文件头 `50 4b 03 04`（PK）。排练产物 xlsx 留在 tmp（未提交，可复现）。

## 测试与突变

- 定向：`node --test skills/sycm-alimama-daily-report/scripts/shop-report-direct-download.test.mjs
  collect-shop-report.test.mjs` ⇒ 25/25。
- 整个日报 skill 套件（仓库根跑）：**630/630、0 fail**（1.9.5 时 616，净增 14 条）。
- 突变验证（tmp/mutation-verify-direct-dl-20261015.mjs，5/5 点名抓红，还原后复跑全绿，
  sha256 逐字节自证）：
  ① 挑候选取首条（旧签名）→「多个候选取**最后一条**」红；
  ② 去 PK 校验 →「200 但不是 zip」红；
  ③ 不判文件名 →「形状不对的文件名一律拒」红；
  ④ 表达式 slice href（探针第一版的错）→「仪表表达式：三个渠道都装上」红；
  ⑤ 装仪表挪到点击后 →「接线守卫（四）」红。
- 用例fixture＝根因探针真机捕获的那条 OSS 签名 URL（tmp/rootcause-20261015/oss-url-full.txt），
  不是编造的短串；仪表表达式在**假 DOM 里真跑**（三渠道各自记到、去重、src 解出）。

## 已知边界（诚实清单）

- 只排练了网林天猫一家、一个统计日窗口。其余 7 家的文件名形状由 `reportPattern`
  按店放行（盖文天猫的登记名前缀也收），但**未经真机**——明早 11:00 定时轮即是检验。
- 直取走 Node 侧直连 OSS（不经过店铺代理）；老通道（若平台回滚）走浏览器下载管线。
  两路并行，哪路通都能用。
- 签名 URL 时效约 20 分钟量级：链路是「点击 → 秒级捕获 → 立即直下」，在时限内；
  但若平台把时效压到秒级，需要改成「捕获后立即 fetch 且失败重试一次」。
