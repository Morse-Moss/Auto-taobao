# 科塔淘宝跑不通的根因：账号级「店铺绩效」功能权限缺失（2026-09-21 现场取证）

## 结论（一句话）

科塔淘宝（科塔全卫定制）这个**生意参谋账号没有「店铺绩效」所属的付费模块授权**（对照账号有），
平台对那个页面直接判定 `code=5903 No Buy Func Permission`，把浏览器送回首页。
我们的脚本每一轮都必须重新加载这一页 ⇒ 每轮都读不到「统计时间 / 询单到付款」⇒ 停在第 4 步。

**这与「导航方式」「代理端口」「profile」「进程」都无关**，因此不是我们这一侧能改好的。

## 决定性证据（一条命令的口径：同一个请求，发给五家账号）

`sycm-noPermission-all-shops.txt`（脚本 `sycm-noPermission-all-shops.mjs`）——
在每个账号自己的生意参谋页签里，对 `/qos/service/frame/shop/performance` 发一次 GET：

| 账号 | 结果 |
| --- | --- |
| 商家浏览器（19023） | 放行 |
| 里可林淘宝（19041） | 放行 |
| 网林天猫（19042） | 放行 |
| 盖文淘宝（19043） | 放行 |
| **科塔淘宝（19044）** | **被拒：`no_permission?code=5903 No Buy Func Permission.`** |
| 盖文天猫（19045） | 放行 |

五个账号放行、一个被拒 ⇒ 不是登录态、不是网络、不是这一台机器。

## 排除法（把「会不会是我们发起的方式不对」逐条否掉）

`sycm-account-scope-confirm.txt`（脚本 `sycm-account-scope-confirm.mjs`）——
同一个 `p_url`，只换「谁发的 / 带不带 Referer / http 还是 https」：

| 变体 | 科塔 | 盖文（对照） |
| --- | --- | --- |
| A 默认（带 Referer，页在 `portal/home.htm`） | 5903 | `code:0 accessLevel:1` |
| B 不带 Referer（`referrerPolicy:'no-referrer'`） | 5903 | `code:0 accessLevel:1` |
| C 把 host 写成 `https://` | 5903 | `code:0 accessLevel:1` |
| D **阳性对照**：`…/performance/new`（两边都该放行） | `code:0` | `code:0` |

D 那一行是关键：同一次会话里，**同一个账号**问另一条路径是放行的 ⇒ 会话、cookie、跨域、Referer
全部正常，被拒的**只有这一个功能**。

## 缺的是哪一项（账号台账 diff，不是猜的）

`sycm-module-diff2.txt` —— 两家的完整模块台账逐条 diff（各 84 / 79 条）：

- 【盖文有、科塔没有】里唯一一项**订购**（非灰度/人群包）：
  **`id=88 单店版-服务洞察专业版`，有效期 `2024-02-20 → 2027-05-22`**
- 【科塔有、盖文没有】有 11 条，全是灰度人群包或无关订购（流量纵横、品类罗盘…），**没有等价替代品**。

对应地，页面级权限查询 `sycm-pUrl-permission-compare.txt` 显示：

```
p_url=…/qos/service/frame/shop/performance     科塔 → {code:5903}   盖文 → {code:0, code:sycm_v2_qos_shop_performance, id:11536}
p_url=…/qos/service/frame/shop/performance/new 两边 → {code:0, id:12816}
p_url=…/portal/home.htm                        两边 → {code:0}   ← 阳性对照
```

即：**科塔有「/new 那层壳」（所以它的菜单里也看得见「店铺绩效」这一项），却没有壳里面那个真模块。**

## 为什么你去看「一切正常」

- 你看的是生意参谋**首页/数据概览**，那部分对这个账号完全正常（`portal/home.htm` 权限查询两边都放行）。
- 缺的是「服务 → 客服 → 店铺绩效」这一页。`sycm-menu-breadcrumb.txt` 显示两家的这一项**指向同一个
  URL、都被标 `visible=y`** —— 所以菜单里看着也在，点进去才会被平台弹走。
- 也就是说：**「首页正常」与「工作页不可用」可以同时成立**，这两件事不矛盾。

## 时间线（用产物时间戳定的，不是回忆）

| 时间（本地） | 事实 | 出处 |
| --- | --- | --- |
| 09-17 / 09-18 / 09-19 | 科塔**完整跑完 11 步**并写入飞书 | `evidence/multi-shop-2026-09-1{7,8-commit,9}/科塔淘宝/` |
| 09-20 16:37–16:40 | 科塔**最后一次完整成功**：店铺名核对 ✓、日报 xlsx 20324B、1885 行、**询单量=6 / 同层同行=6** | `multi-shop-2026-09-19-rerun4/科塔淘宝/{05,07,10}.txt` |
| 09-21 11:42 | 跨店只读快照里，科塔这一页**仍在工作页上**、还能读到 `统计时间 2026-09-19` —— 但这是**上一次加载留下的渲染**，不是重新加载 | `probe-all-shops-sycm-state.txt` |
| 09-21 14:53 | `sycm-date` 因「页面显示的不是目标日」触发**真重载**；重载后读数变 null（连读 16 次失败），页面落到 `/mc/free/sycm` | `multi-shop-2026-09-20-rehearsal2/科塔淘宝/{01,04,99}.txt` |
| 09-21 15:00 / 15:37 / 15:57 | 「领回」两次失败、`TARGET_PAGE_MISSING` | `tmp/reclaim-19044.txt`、`keta-targets.json`、`keta-run.log` |

⇒ 权限是在 **09-20 16:40 之后、09-21 14:53 之前**消失的；在那之前页面一直是「上一次加载的遗留状态」，
所以**第一次真正重载才暴露**。准确时刻浏览器里看不出来，要看平台的订购/到期记录。

## 我没能从这个入口查到的（如实列出）

- **是「到期」还是「从未订购」**：`all_modules` 里 `hasPermission!==true` 的条目为 0，
  失效的订购会**整条消失**，所以只能看出「现在没有」，看不出原因。
- **权限消失的确切时刻**：窗口是 (09-20 16:40, 09-21 14:53)，浏览器侧无法再收窄。

## 建议的下一步（按代价从低到高）

1. **人去点一下**（10 秒，最直接）：在科塔浏览器里打开 生意参谋 → 服务 → 客服 → 店铺绩效。
   若平台给「未订购 / 已到期 / 去开通」这类提示，就直接印证了；顺便看首页有没有「一键领取」里含服务洞察。
2. **看订购记录**：用科塔的账号查 服务洞察 / 服务绩效 的订购与到期时间，与上面那个时间窗对照。
3. **决定这家店怎么办**：若确认这个功能对该店不可用，那「科塔也有生意参谋工作页」这个前提对它不成立，
   要么补订购，要么给科塔单独走另一条取数路径（本仓库当前只有这一条）。

## 这个目录里有什么

- `cross-shop-sycm-probe.*` —— 六台浏览器当前页签快照（哪台工作页在位）
- `sycm-tab-state-compare.*` —— 各店生意参谋页签的客户端状态对照（URL / 存储 / 导航条目）
- `sycm-entry-http-compare.*` —— 页面内对四个候选入口发 GET，看服务端应答（第一次看到 5903 的地方）
- `sycm-noPermission-all-shops.*` —— **决定性对照**：同一个请求发给五家账号
- `sycm-pUrl-permission-compare.*` —— 页面级权限查询（含阳性对照 `portal/home.htm`）
- `sycm-account-scope-confirm.*` —— 排除 Referer / http-https 变量
- `sycm-module-grants.*`、`sycm-modules-dump.mjs`、`modules-{keta,gaiwen}.json`、`sycm-module-diff.mjs`、`sycm-module-diff2.txt` —— 账号模块台账与 diff
- `sycm-menu-breadcrumb.*` —— 「店铺绩效」在两家菜单里的面包屑
- `sycm-noPermission-page-and-menu.*` —— 平台的 no_permission 页面与菜单节点原文
- `keta-nav-inspect.*` —— 科塔当前页的导航项清单

全部探针**只发 GET / 只读 DOM**，不点击、不导航、不新建页签、不改任何状态。

## 姊妹目录（同一个结论的另一批取证）

`evidence/keta-workpage-2026-09-21/` 是同一晚、同一个结论的另一批探针，两者**互为独立复核**：

- 它多出来的：`sycm-service-analyze-5shops.*` 与 `sycm-service-window.*` ——
  **五家店的订购窗口并排表**（里可林 / 网林 `2026-06-17 → 2027-06-16`；
  盖文淘宝 `2024-02-20 → 2027-05-22`；盖文天猫 `2026-08-03 → 2027-08-02`；科塔**无此行**），
  以及 `sycm-menu-node.*`（菜单节点逐字比对）。
- 本目录多出来的：**六账号**同请求对照（多一个商家浏览器账号）、
  **排除法矩阵**（Referer / http-https / 阳性对照）、**页面级权限查询**（把「`/new` 壳」与
  「真模块 `id=11536`」分开）、**账号模块台账 diff**、菜单面包屑、以及「浏览器侧分不出
  到期还是从未订购」这条边界。
- 两边共有的 `cross-shop-sycm-probe.*` / `sycm-entry-http-compare.*` / `sycm-tab-state-compare.*`
  是同一批输出的两份拷贝（本目录的是原始产物，字节一致）。

文档侧结论已合并进 `docs/ops/FULL-AUTOMATION-STATE-CONTRACT-2026-09-21.md` 的 §十二（单节，不重复编号）。
