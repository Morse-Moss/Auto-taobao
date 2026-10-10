# ㊵ 根因（2026-10-10 真机复现，单店 里可林淘宝 / 19041 / 19031）

## 结论一句话
**链路把「导航到报表页」这一步做成了 `Page.navigate(首页URL#!报表路由)`，
而这个 SPA 在整页导航下会把 hash 冲掉、弹回首页 ⇒ 页面永远停在首页的筛选栏，
`triggers` 恒 4（判据要 ≥6）⇒ 第 2 步 `alimama-date` 必然失败。**

## 实测（可复算）
1. 冷启动的阿里妈妈页签创建自 `login-merchant-core.mjs:89` 的 `probeUrl = https://one.alimama.com/index.html`
   （**首页**，不是报表页）。页签标题 `首页_万相台无界版`。
2. 对首页页签发 `/navigate` 到报表 URL（`…/index.html#!/report/account?…`）：
   - 返回 HTTP 200（看着成功）
   - 但**逐秒读 40 次**：`href` 恒为 `https://one.alimama.com/index.html`、`hash` 恒空、
     `title` 恒 `首页_万相台无界版`、`.mx-trigger` 恒 4、`resCount` 只在一次两三位地涨
     （全是首页自己的 `alimama_bp` / `report.json` 打点）。
   - ⇒ **hash 被 SPA 冲掉，整页导航根本没进报表路由。**
3. 对照：在页内直接 `location.hash = "#!/report/account?…"`：
   - 5 秒后 `title = 营销场景报表_万相台无界版`、`href` 带上 hash **且稳定**、
     `.mx-trigger` = **11**（远超 ≥6）
   - ⇒ **同一条路由，用「页内改 hash」就进得去，用 `Page.navigate` 就进不去。**

## 第二半（同一根因的另一面）
报表页日期触发器的显示文本是 **`过去 7 天`**（默认区间 2026-10-03 至 2026-10-09），
而 `READ_EXPRESSIONS.alimama`（date-picker.mjs:218）要求**恰好 1 个**触发器匹配
`/\d{4}-\d{2}-\d{2}|昨日|今日/`：
- 停在首页 ⇒ 匹配到 2 个（`今日` + `昨日`）⇒ `alimama date trigger ambiguous: [...]`
- 进了报表页但区间回显成预设名 `过去 7 天` ⇒ 匹配 0 个 ⇒ 同样抛错

## 与历史对照（为什么 10-09 能过、10-10 挂）
10-09 的 `01-health-check.txt` 显示阿里妈妈页签**本来就在**（`already-one`、`changed:false`），
是上一轮跑完留下的、**已经进过报表路由**的页签；
10-10 的页签是这一轮 `:create` 出来的、从首页起 ⇒ 撞上「导航进不去」这条缝。
10-06 是 `triggers=0`（整页没渲染），与本次 `triggers=3/4`（首页筛选栏）**不是同一个形态**。

## 排除项（有证据）
- 登录：`login-preflight-b1.json` verdict=ALL_IN，每店 alimama=LOGGED_IN
- 实例：`start:0`、浏览器 READY、代理「已连接浏览器」
- 视口：1528×732 → inner 1506×642，与 10-09 成功轮一致
- 导航后被弹出：`read-before-skipped` 的读数发生在 navigate **之前**，已经是 4
- 载入慢/预算不够：40 秒恒 4，不是「在涨但没涨到 6」
