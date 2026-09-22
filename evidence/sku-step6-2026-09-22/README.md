# evidence/sku-step6-2026-09-22 —— 竞品第 6 步（SKU 富化）真跑

本机时间 2026-09-22 上午。这一轮不是只读复核，是**真跑**：开了商品页、点了复制、读了剪贴板。
目的：验证「第 6 步被买家号登录态卡住」这个阻塞判断是否还成立。

## 结论先行

1. **阻塞已解除。** 预检 `AUTH_READY`，采集/拓扑/dry-run 四段全绿。
2. **本期没有待采的行。** 队列 `ab 1 / ready 1 / pending 0`，唯一那个 A/B 商品的 96 行 09-16 就写进去了。
   ⇒ `toCreate=0` 是**正确结果**，不是失败；apply 没跑也不需要跑。
3. **幂等被现场证明了**：96 个唯一键全部 `alreadyPresent`，0 重复、0 冲突。

## 逐段留证

| 文件 | 是什么 |
| --- | --- |
| `01-preflight.txt` | 第 1 段 `xws-sku-auth-preflight.mjs`：**exit 0 / AUTH_READY** |
| `xws-sku-auth-status-20260922T030538119Z-75ed3011-434.json` | 登录态工件：`pluginPresent=true`、`skuControlPresent=true`、`page.productId` 与来源一致 |
| `02-copybar-probe.json` | 点击前只读探测 `#xws-copy`：11 个候选项，其中文本恰为 `SKU` 的 `DIV.xws-copy-item.xws-copy-link` 可见、中心命中点是那个 `SKU` 的 `SPAN` |
| `03-click-sku.txt` | 真实鼠标点击（`/clickPoint`，先 `activateTarget`）+ 等到的可见反馈：**「已复制」** |
| `04-capture.txt` | 第 2 段剪贴板采集：sha256 `1ada52ee…`、1331 字节 / 553 字符（**不回显 payload 内容**） |
| `xws-sku-capture-2026-09-22T03-06-34-481Z-1ada52eeb0d9.json` | 采集收据（含来源身份与 `copyFeedback`） |
| `05-topology.txt` + `xws-sku-topology-921092099640.json` + `…-receipt-…json` | 第 3 段拓扑：2 个属性 / **96 个有效组合** |
| `06-dry-run.txt` + `xws-sku-dry-run-manifest-20260922T030736177Z-….json` + `…-receipt-…json` | 第 4 段 dry-run：`DRY_RUN_READY`，`toCreate 0 / alreadyPresent 96 / conflict 0 / duplicateExistingKeys 0` |
| `07-queue-weekly.txt` | 队列周表口径：本期 09-13~09-19 `ab 1 / ready 1 / pending 0`；SKU 明细 830 行 / 14 个商品带尺寸 |
| `08-schedule-plan.txt` | `round-runner.mjs --show-plan` 只读输出：排期只有一条、`enabled:false` |
| `batch-index.json` | 这一批产物的规范索引（脚本自己维护） |

**没有 apply 收据**，因为 `toCreate=0` —— 没有新行可写，所以不存在「写了什么」这一节。

## 动过什么、没动什么

**动过的**（都可逆、都在调试浏览器内）：

- 在买家浏览器（9222 / 代理 3457 / profile `edge-debug-profile`）**新开了一个后台标签页**，
  地址 `https://item.taobao.com/item.htm?id=921092099640`，标签 `sku-collect-921092099640`。
  原来那个「我的淘宝」页没动。该页未 pin，代理的闲置回收会自己处理；要立刻关就
  `GET /close?target=8B3305A115DCFB72E28D520444F326C8`。
- 在商品页上**点了一次**小旺神复制条的 `SKU` 项（那正是这条链要做的动作）。
- 写入了本目录下的本地证据文件。

**没动的**：飞书任何表（dry-run 只发 GET）、任何进程/容器（未启停）、`.env` 凭据、
其它商品的 payload/topology。

## 这份证据证不了什么

- **证不了写段真的能写**。`toCreate=0` 让 apply 无从发生；今天只证明了「判定为无需写」和幂等。
  要证明写入，得找一个真有缺口的商品（例如 09-06 期那个 `678598686014`，属历史期，需要单独授权）。
- **证不了 SKU 周表快照那一段**。09-13 期仍没有 `SKU周` 表，本周快照没建。
- **证不了换一个商品还能跑通**。今天只跑了一个商品；标题不同、属性数不同的页面没覆盖。
- 不构成「以后登录态一直在」的证据。登录态是 Edge 的，每次采集前仍必须重新预检。
