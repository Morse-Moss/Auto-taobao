# 小旺神全能力反向报告（2026-10-26）

对象：小旺神扩展 `kmbagmjnoooeiindcnfgebkekiimbnee` 2.1.0.6（MV3，49 个 JS，12 组 content_scripts，224 条 host 权限）
方法：REA 静态分析产物 + 扩展源码直读 + `chrome.storage.local` 的 LevelDB 离线解包
取证：`evidence/xws-reverse-2026-10-26/`（7 份远端清单 + 本报告 + `capability-map.json`）

---

## 0. 结论先行

1. **停摆不是服务端停服。** 远端清单仍在、仍可 200 读到，但客户端 `normalize()` 在展开服务端策略之后，**再次硬写入 `search:false, detail:false`**，把账号权限覆盖掉。付费号、管理员号一样被关。
2. **模块文件已从 CDN 删除。** `/modules/tb-detail.*.js`、`/modules/tb-list.*.js` 等全部 404。现存的完整模块源码只在浏览器 `chrome.storage.local` 缓存里，本次已离线解包取出（详情 3.0MB、列表 2.76MB）。
3. **小旺神的能力不是"一个搜索页功能"，是 7 个远端模块族、约 50 个前端组件。** 我们已吸收其中 3 项（搜索页市场分析 → 16 列周报；详情页 SKU 与评价 → `runtime/collect-taobao-detail.mjs`，2026-10-26）。
4. **SKU 与评价的取数路径已完全拿到并跑通**，见第 4 节：SKU 走 `mtop.taobao.pcdetail.data.get`，评价走 `mtop.taobao.rate.detaillist.get v6.0`，买家秀走 `mtop.taobao.ugc.itemshow.list`。三条都是**淘宝原生接口 + 页面现算签名**，不需要逆向风控。
5. **「问大家（FAQ）」要单独说明：小旺神本身没有这个能力**，全模块无接口、无组件，只有一处读页面数字的代码和一个从未接线的埋点标签（见 4.1）。它不占"未吸收"的额度——想做得按新建立项。

---

## 1. 架构：三层，壳只是壳

```
第 1 层 扩展壳 2.1.0.6
  manifest.json          12 组 content_scripts，覆盖淘宝/天猫/千牛/阿里妈妈/创意中心/京东/抖音等
  js/modules-page.js     页面内代理：读页面 React 数据 + 转发 mtop
  js/full-background.js  远端模块加载器：校验清单、落缓存、注入
  js/remote-detail-content.js  远程模块宿主（内嵌 JSZip），只做桥接不实现业务

第 2 层 远端模块（按内容寻址，sha256 作文件名）
  GET {BASE}/manifest.json
  GET https://xcj3.tqdn.cn{file}          → /modules/<name>.<sha256>.js
  GET https://xcj3.tqdn.cn/shared/vendor.<sha256>.js
  BASE = https://xcj3.tqdn.cn/modules/v1(+ /list /seller /wujie /creative /jd /dy)

第 3 层 桥接协议（window.postMessage）
```

### 桥接协议一览

| 消息 | 用途 | 关键约束 |
|---|---|---|
| `xws-exec-getTbSearchData` | 读列表页已渲染数据 | 角色仅 `itemsArray` / `goodArrRight` / `goodArrBottom` |
| `xws-exec-getAdapterData` | 读详情页已渲染数据 | 角色仅 `itemDetail` / `comments` |
| `xws-exec-getPageData` | 按 `selectors + dataPath` 读任意 React 节点 | 选择器 ≤8 条、路径 ≤16 段、禁 `__proto__` |
| `xws-exec-getReviewDownload` | 按 token 取单条评论（正文/图/视频/追评） | token 需匹配 `^[a-z0-9-]{1,80}$` |
| `xws-exec-getWindowAttr` | 读 `window.__INITIAL_STATE__` | 仅飞猪 |
| `XWS_PAGE_REQUEST` | **通用 mtop 代理** | `api` 必须匹配 `/^mtop\.[a-z0-9_.]+$/i`，`apiKey` ∈ `request`/`H5Request` |
| `XWS_ORIGINAL_INSTALL` | 注册页面全局 JSONP 回调 | `xwsGoodCollections_marketanalysis` / `xwsSocialFeedTags` / `xwsTagQuestList` / `xwsitembuyshow` |

> `XWS_PAGE_REQUEST` 是关键：它接受任意 `mtop.*` 接口名，借页面自己的 `window.lib.mtop` 现算签名。**我们不需要复刻签名算法，只要借页面 SDK。**

---

## 2. 七个模块族现状（2026-10-26 实测）

| module id | version | 字节 | CDN 文件 | 本地缓存 |
|---|---|---|---|---|
| `tb-detail-original` | `retired-20261024` | 3,009,007 | 404 | **有（已解包）** |
| `tb-list-original` | `retired-20261024` | 2,756,087 | 404 | **有（已解包）** |
| `tb-seller-original` | `seller-shortcuts-retired-20261025` | 2,304,207 | 404 | 无 |
| `wj-main-original` | `display-close-20261024` | 7,069,968 | 404 | 无 |
| `wj-creative-original` | `2.1.0.6` | 214,722 | 404 | 无 |
| `jd-detail-original` | `account-center-20261023` | 2,199,894 | 404 | 无 |
| `dy-detail-original` | `account-center-20261023` | 756,513 | 404 | 无 |

**七个族全部带停摆标记**，连创意中心（version 正常）的文件也已删除。停摆是分族、分期执行的：seller 比 detail/list 晚一天（10-25 vs 10-24）。

---

## 3. 停摆机制：代码级定位

在 `tb-detail.js` 与 `tb-list.js` 里各有一份，逻辑一致：

```js
// 策略来源
GET https://xiaowangshen.com/crx/xws/new/user/info/
    ?visibility=1&n_rt=json&_cb=<now>
// code===1401 时，先取 shop_nick 再带 shop_nick 重试一次

// 关键：normalize 在展开服务端 data 之后，再次硬写 false
function normalize(t){
  const w = t && 200===t.code && t.data;
  return w && 1===w.version && Array.isArray(w.functions)
    ? { version:1, paid:false, admin:false, support_rate:false, wujie:false,
        search:false, detail:false, seller:false, functions:[],
        ...w,
        search:false, detail:false,                       // ← 覆盖服务端下发
        seller: w.admin===true || (w.seller===true && (w.paid===true || w.support_rate===true)),
        wujie:  w.admin===true || (w.wujie===true && (w.paid===true || w.shop_authorized===true)) }
    : { version:1, paid:false, admin:false, support_rate:false, wujie:false,
        search:false, detail:false, seller:false, functions:[] };
}

// 三道闸
allowed(k)            = policy.admin===true || policy[k]===true
hasFunction(k)        = policy.admin===true || (k==='v29' && policy.support_rate===true)
                        || policy.functions.includes(k)
runWhenAllowed(k, fn) = k==='search' || k==='detail' ? Promise.resolve() : (allowed(k) ? fn() : <等待策略变化>)
gate(component)       = !allowed(k) ? 渲染 display:none 的空 <span> : 正常渲染
xwsCan(k)             = !(isSearch() || isDetail()) || hasFunction(k)
```

**结论**：
- `search` 与 `detail` 被**双重**强制为 false：对象字面量初值 + 展开后再写一次。服务端下发的 `true` 永远不生效。
- `runWhenAllowed` 对这两个键**直接短路返回**，连"等策略变化后重试"的机会都没有。
- 受影响的正是我们关心的两类页面：`isSearch()`（s.taobao.com / list.tmall.com）与 `isDetail()`（`/item.htm`）。
- 唯一还有门的键是 `seller` / `wujie`（要 paid 或 support_rate 或 shop_authorized）。

---

## 4. 详情页能力 → 淘宝接口映射（本次核心产出）

`tb-detail.js` 共 25 个 Vue 组件，去重后对应 12 项对外功能：

| 能力 | 组件 | 接口 | 参数 | 取到的字段 | 我们是否已有 |
|---|---|---|---|---|---|
| **SKU 明细** | `SkuPreview`（内部用 `XwsMonitorTable` 渲染） | 先读详情页 React 的 `itemDetail`；**缺 `skuBase` 时**才回退 `mtop.taobao.pcdetail.data.get` v1.0 | `{id}`，`type:get dataType:jsonp` | `data.skuBase.props[]`、`data.skuBase.skus[]`（见下方解析） | ❌ |
| **宝贝信息（聚合卡）** | `XwsItemInfoFunc` | `pcdetail` + DOM 计数 | 同上 | SKU数 / 收藏 / 评价数 / 问大家数 / 月销 / 店铺商品数 / 店铺粉丝 | ❌ |
| **评价下载 / 评价分析** | `XwsRatesDownload` | `mtop.taobao.rate.detaillist.get` **v6.0** | `{showTrueCount:false, auctionNumId:<id>, pageNo, pageSize:40, rateType:"", searchImpr:-8, orderType:"", expression:"", rateSrc:"pc_rate_list"}`<br>附加 `{ecode:"1", needLogin:false, sessionOption:"AutoLoginOnly", jsonpIncPrefix:"haloMtop", ext_querys:{jsv:"2.7.5"}}` | 见下方单条评论结构 | ❌ |
| **全部买家秀下载** | `XwsItemBuyShow` | `mtop.taobao.ugc.itemshow.list` v1.0 | `{itemId:"<str>", params:'{"pagination":{"offset":"<cursor>","pageSize":50}}'}` | `pics[]`、`videoUrl[]` | ❌ |
| **洋淘买家秀** | `XwsItemBuyShow` | `mtop.taobao.ugc.tql.facade` v1.0 | `{sceneName:"query_item_buyer_show", paramMap:'{"itemId":N,"tab":"main","pagination":{"hasMore":true,"pageNum":N,"pageSize":12}}'}` | 同上报文 | ❌ |
| **店铺上新** | `XwsShopNew` | `mtop.taobao.shop.simple.fetch` v1.0 → `mtop.taobao.shop.simple.item.fetch` v1.0 | `{shopId, sellerId}` | `data.categoryInfoDTOList[].{categoryId,categoryName,customDecorate,subCategoryInfoList}` | ❌ |
| **车图下载** | `XwsZtcImgDownload` | appId `34385` 搜索 + 创意中心 | 见第 5 节 | 车图 URL 列表 | ❌ |
| **违禁词检测** | `XwsBannedWord` | 无淘宝接口（本地词库；图片走 OCR，按旺豆计费） | — | 标题/属性/详情/文案/SKU/描述分区命中 | ❌ |
| **店铺信誉** | 详情页模块内**无对应组件**（仅出现在埋点标签表），入口不在 `tb-detail` | — | — | — | ❌ |
| **采集问大家** | **模块内不存在实现**（见 4.1） | 无接口，只有 DOM 计数：`[class*="askAnswerWrap--"] [class*="askAnswerTitle--"]` 文本「问大家 · N」 | — | 仅有数量 | 不适用 |

### 4.1 问大家（FAQ）：小旺神也没有明细能力，不在吸收范围

2026-10-26 在离线解包的 `tb-detail.js`（3,009,034 B）与 `tb-list.js`（2,756,114 B）上逐项核对，
结论是**源头就没有可吸收的东西**，不是「入口随锁失效」：

1. **没有任何问大家相关接口。** 全模块 15 个 mtop 接口（`pcdetail` / `ugc` / `rate` / `shop` / `wsearch` /
   `detail` / `hexa.search` / `alimama.union` / `alibaba.fc` / `relationrecommend`）里，
   匹配 `\.(ask|wenda|faq)` 的结果为 **0**。
2. **没有对应组件。** 25 个 `Xws*` 组件全量列出后，没有一个与问答有关
   （`XwsBannedWord`/`XwsDetailImgSimilar`/`XwsItemBuyShow`/`XwsItemInfoFunc`/`XwsRatesDownload`/
   `XwsShopNew`/`XwsZtcImgDownload`/`XwsMonitorTable`/… 无一命中）。
3. **`采集问大家` 只是一个从未接线的埋点标签。** 标签表声明 14 个，
   `bindClickTracking()` 实际只绑了 8 个（个人中心 / 宝贝信息 / 店铺上新 / 评价下载 / 车图下载 /
   违禁词检测 / 全部买家秀下载）。`采集问大家` 在表里、但没有组件绑它 —— 死代码。
4. **唯一活着的问大家代码是读数量。** `XwsItemInfoFunc` 里的 `readPageQuestionCount()`
   每 1.5 秒轮询 `[class*="askAnswerWrap--"] [class*="askAnswerTitle--"]`，
   正则 `/^\s*问大家\s*[·•・]\s*(.*?)\s*$/` 取出数字，存进 `questNum`，
   和「SKU数 / 收藏 / 评价」并排显示在宝贝信息卡上。**只显示数字，不取明细。**
5. **它依赖的锚点在当前 PC 详情页已不存在。** 2026-10-26 实测 `askAnswerWrap` 计数 = 0，
   区块标题只有「参数 / 用户评价 / 参数信息 / 图文详情 / 本店推荐 / 看了又看」。

所以「SKU 有了、评价有了，FAQ 什么时候补」这个问题要改问法：**要补的是新建能力，不是吸收**。
若真要做，得从移动端或其它入口找接口，PC 端当前没有入口可依。优先级应低于买家秀——
后者至少小旺神验证过接口形态。

### 4.2 详情页风控：不做自动过滑块，因为频率才是瓶颈（2026-10-26 定）

结论先说：**不实现自动拖滑块。** 不是技术上做不到，是做了没有用，还会把风险放大。

**被拦的到底是什么。** 弹窗出现时页面是**完整渲染**的——标题、价格、SKU 区间、评价区都在，
`readyState=complete`、`window.lib.mtop` 存在（`hasSdk=true`），中间盖一层「请拖动下方滑块还原拼图」
（`hasPuzzle=true`）。真正被拦的是 **mtop 接口**：弹窗挂出来后页面把 pending 请求攥住不返回，
25 秒超时。所以「手动打开正常、采集器失败」不矛盾——手动只加载页面，不发接口。

**风控是频率窗口，不是账号锁。** 同一账号、同一 profile：

| 时间 | 事件 |
|---|---|
| 18:48 | 撞滑块，标签页挂住 |
| 20:02 | **无人干预自己恢复**，滑块一动没动，反馈码都没变 |

被挂住的那个标签页确实是废的（它永远停在那儿等人），但它**不拦新会话**。所以正确处置是
把那个 tab 关掉、等冷却，而不是去解它。拖过去也不改变窗口预算，下一轮照样被拦。

**实测节奏（决定了为什么只能慢慢跑）。**

| 轮次 | 一次跑几个 | 结果 |
|---|---|---|
| r7 | 10 | 5 成 5 败 |
| r13 | 1 | 1/1 |
| r14 | 3 | 3/3 |
| r15 | 4 | 4/4 |
| 20:52 后 | 连续四种打法（新 tab / 复用被弹 tab / 复用干净 tab / 冷启动预热） | 全撞 |

由此反推预算约 **8–10 个商品 / 75 分钟冷却**。稳的打法是**每轮 3–4 个、间隔 8–12 秒**
（`--min-delay/--max-delay` 默认 3000–6000 已偏快，批量跑要往上调）。

**`--reuse-tab` 绕不过去，还自带一个坑。** 它省不掉验证，因为验证挂在会话上不是挂在 tab 上。
更糟的是 `findReusableTab()` 原先只按 host 匹配，会把**上一轮被弹过的那个 tab** 又选上
（同 profile 里它还在），于是下一次跑接着失败——2026-10-26 连撞两次就是这么来的。
现已加 `POISONED_TAB_RE`（`punish|login.taobao|havanaone|login_jump|_____tmd_____`）排除，
且复用的页若已被污染直接关掉。

**冷启动会被踢一次登录页，但不是登录态丢了。** 首次进详情页可能跳到
`login.taobao.com/havanaone/...login_jump`，而同窗口 `www.taobao.com` 显示已登录（实测 tb452480340）。
先预热导航一个商品再跑即可，不要去重登。

**为什么不干脆做掉它。** 三条：

1. **解的是症状。** 真正的约束是窗口预算，不是那道拼图。窗口满了，拖过去也照样超时。
2. **风险不对等。** 账号是老板的真实经营账号，对抗性绕过换来的是「这一轮多采几个」，赌的是账号被降权。
3. **收益有更好的来源。** 降低并发、拉开间隔、分批跨时段跑，是确定能得到全部商品的路；破验证码只是把同一批商品提前几个小时拿到。

代价要写清楚：全量 30 个商品需要**分 3–4 个时段**跑完，不能一口气采。这是已知且接受的限制。

### 单条评价的数据结构（从 `readReview` 反推，字段名为实测）

```
comment.reviewInfo      { content, picList[], videoList[], date }
comment.reviewAppendInfo{ content, picList[], videoList[] }      // 追评，可为空
comment.skuText         { <propKey>: <propValue>, ... }          // 买的是哪个 SKU
comment.userInfo        { nickName }
```

> 「评价下载」输出：每条评论一个文件夹，命名 `{SKU}_{日期}_{昵称}`，内含 `_初评内容.txt`、`_初评图_N.*`、`_初评视频_N.*`，有追评再加 `_追评内容.txt` / `_追评图_N.*` / `_追评视频_N.*`。

### SKU 的两种取法（同一接口）

```js
// 主路径：借页面 SDK（推荐，签名由页面现算）
window.lib.mtop.request({
  api: 'mtop.taobao.pcdetail.data.get', v: '1.0',
  appKey: '12574478', type: 'get', dataType: 'jsonp',
  data: { id,
          detail_v: '3.3.2',
          exParams: JSON.stringify({ id, queryParams: `id=${id}`,
                                     domain: location.origin, path_name: '/item.htm' }) }
})
// 失败回退：直接读页面 React 树
//   #purchasePanel / .PurchasePanel--JEB_OhIE  →  return.memoizedProps.detail
//   [class*="Comments--"]                      →  return.updateQueue.baseState
```

### `skuBase` 的字段结构与解析方式（`SkuPreview` 实测）

```js
skuBase = {
  props: [ { pid, name,                 // 属性名，如「尺寸」「颜色分类」
             values: [ { vid, name, image } ] } ],   // 属性值 + 该值的图
  skus:  [ { skuId, propPath,           // propPath 形如 "pid1:vid1;pid2:vid2"
             price, store,              // 价格、库存
             /* 其余平台字段原样保留 */ } ]
}
```

解析方法（照抄它的做法）：
1. `props` 建索引 `pid → {name, vid → {name, image}}`；
2. 对每个 `sku`，把 `propPath` 按 `;` 拆、再按 `:` 拆，逐段查索引，得到 `{属性名: 属性值}`；
3. `image` 非空则作为该 SKU 的图；
4. 页面 SKU 顺序另取：DOM `.tb-skin .J_TSaleProp.tb-img li` 的 `dataset.value`（仅 `tb_item` / `tm_item` 域）。

> 对我们最直接的价值：**「尺寸」「适用空间」这类属性名就是 `props[].name`，属性值就是 `values[].name`**。周表那两个 Lookup 列不必再靠标题猜。

### 买家秀的签名（唯一需要自己算的一处）

```
token, ts = cookie['_m_h5_tk'].split('_')
sign = md5(`${token}&${ts}&12574478&${JSON.stringify(data)}`)
GET https://h5api.m.taobao.com/h5/mtop.taobao.ugc.itemshow.list/1.0/?jsv=2.5.8&appKey=12574478&t=<ts>&sign=<sign>&api=...&v=1.0&type=jsonp&dataType=jsonp&data=<json>
jsonpCallback = xwsitembuyshow
```

---

## 5. 列表页能力 → 接口映射

`tb-list.js` 同样 25 个组件，对应 10 项功能：

| 能力 | 组件 | 数据来源 | 说明 |
|---|---|---|---|
| **市场分析**（我们已复刻） | `XwsMarketAnalysis` | `xws-exec-getTbSearchData` 读页面 React 的 `itemsArray` / `goodArrRight` / `goodArrBottom` | 小旺神**不发请求**，直接读页面已渲染的数据；我们改成自己发 `mtop.relationrecommend.wirelessrecommend.recommend` v2.0，字段等价 |
| 主图对比 / 本页主图对比 | `XwsListImgSimilar` / `XwsFigureContrast` | appId `34850` 以图搜同款 | 需要 `strimg`（base64 JPEG，压到 320×320） |
| 批量下载主图 | `XwsImgsBatchDown` | DOM + `pcdetail` | — |
| 批量下载详情图 | `XwsDescImgsBatchDown` | DOM 详情描述区 | — |
| 全部买家秀下载 | `XwsBuyershowBatchdown` | 同第 4 节买家秀接口 | — |
| 车图下载 | `XwsZtcImgDownload` | appId `34385` | — |
| 批量查排名 | （列表工具条） | appId `34385` 搜索翻页定位 | `sort:'_coefp'`，`pageSize:50` |
| 店铺商品采集 | `XwsShopGoodSearchBox` | appId `33978`（天猫国际）/ `mtop.hexa.search.searchitems`（天猫超市） | 按店铺维度取商品 |
| 竞品监控 | `XwsAddMonitor` | 写小旺神自己服务端 | 非采集能力 |
| 店铺列表工具 | `XwsShopListTool` / `XwsShopListCopy` | DOM | — |

### appId 对照表

| appId | 用途 |
|---|---|
| `12574478` | 统一网关 appKey（所有 mtop 请求共用） |
| `34385` | PC 搜索（排名 / 关键词 / 车图） |
| `44239` | 店铺搜索 `pc_shop` |
| `34850` | 以图搜同款 |
| `30515` | 按标题搜同款 |
| `33978` | 天猫国际站内搜索 |

---

## 6. 与我们现有实现的差集

**已吸收（3 项）**

| 能力 | 落点 | 状态 |
|---|---|---|
| 搜索页市场分析 | `runtime/taobao-search-core.mjs`（16 列契约）+ `runtime/collect-taobao-search.mjs`（采集）+ 周表全链 | 已产出 1384 行周表并写入飞书 |
| **详情页 SKU** | `runtime/taobao-detail-core.mjs`（契约）+ `runtime/collect-taobao-detail.mjs`（采集） | 代码完成、实测通过。2026-10-26 已采 **14 个商品 / 1019 个 SKU**（`evidence/taobao-detail-2026-10-26/`）。受频率窗口约束须分时段跑，**不需要人工过验证**（见 4.2） |
| **评价下载** | 同上（同一采集器同时取评价） | 同左，每条 40 条分页取全，字段实测全对 |
| **尺寸 / 适用空间 汇总** | `runtime/taobao-sku-dimension-core.mjs`（映射）+ 周表 Lookup(19) | 14 个商品里 **10 个可直接落**（尺寸取自 `长度`）；2 个尺寸缺失、2 个标题无空间词，均如实留空并列出待核验线索（`sku-dimension-report.json`） |

**未吸收（8 项）**，按对我们的价值排序：

1. **买家秀** → `mtop.taobao.ugc.itemshow.list`。可作为真实使用场景的图片素材。实测借页面 SDK 不通（四种调用形态全部 ABORT），须自己算 `md5(token&ts&12574478&data)` 直打 h5api —— 小旺神就是这么做的。是 SKU 之后唯一还有「源头验证过形态」的一项。
2. **店铺上新** → `mtop.taobao.shop.simple.fetch` / `item.fetch`。竞品上新监控。
3. **批量查排名** → appId 34385 翻页定位。
4. **以图搜同款 / 同款数** → appId 34850 `strimg`。
5. **店铺信誉** → 详情页模块内无实现，需另找入口（`tb-seller` 模块未取得）。
6. **违禁词检测** → 本地词库，与淘宝无关。
7. **车图下载** → appId 34385。
8. **问大家** → **不是「未吸收」，是「源头没有」**。全模块无接口、无组件，只有一个从未接线的埋点标签和一个 DOM 数量读取，见 4.1。要做得按新建能力立项，不占吸收预算。

---

## 7. 复现步骤（可重跑）

前置：调试浏览器在 9222 上活着，且装着小旺神。

```bash
# 1) 七个模块族清单（只读，200）
B=https://xcj3.tqdn.cn/modules/v1
for m in "" /list /seller /wujie /creative /jd /dy; do
  curl -s "$B$m/manifest.json" -H "Referer: https://item.taobao.com/"
done

# 2) 模块文件：全部 404（已删）。要拿源码只能从 chrome.storage 缓存解包：
#    Local Extension Settings/kmbagmjnoooeiindcnfgebkekiimbnee/000558.ldb
#    键 XWS_MAIN_REMOTE_DETAIL_V1 / XWS_MAIN_REMOTE_LIST_V1，值为 {"code":"<模块JS>"}
#    需要 LevelDB block 解析 + snappy 解压（脚本见 tmp/xws-re/ldb.py）

# 3) 页面内探接口（只读，不写）
#    借页面 SDK：sdk('mtop.taobao.pcdetail.data.get', {id, detail_v:'3.3.2'})

# 4) 自采详情页（SKU + 评价）。慢是关键，别改快：
#    每轮 3-4 个、间隔 8-12 秒；一次 10 个会踩频率窗口（见 4.2）
node runtime/collect-taobao-detail.mjs \
  --from-csv 周表.csv --out-sku evidence/taobao-detail-2026-10-26/r16/sku.csv \
  --out-review evidence/taobao-detail-2026-10-26/r16/review.csv \
  --min-delay 8000 --max-delay 12000 --reviews 1

# 5) 从已采 SKU 汇总出「周表两个 Lookup 会算出什么」，并列出待人工核验的条目
node runtime/taobao-sku-dimension-core.mjs \
  --sku evidence/taobao-detail-2026-10-26/r6/sku.csv \
  --sku evidence/taobao-detail-2026-10-26/r7/sku.csv \
  --out evidence/taobao-detail-2026-10-26/sku-dimension-report.json
```

---

## 8. 边界与注意事项

- **别把 `retired` 当"还能用"。** 清单可读不等于功能可用：客户端硬锁在模块内部，换版本号绕不过（`normalize` 不看 version）。
- **模块文件已从 CDN 删除。** 任何"升级扩展就能恢复"的假设都不成立。
- **缓存副本与清单 sha 不完全一致**：详情模块缓存 3,009,034 字节 vs 清单 3,009,007，差 27 字节（JSON 转义差异）。判定为同一版本（内嵌 CLIENT_VERSION 均为 2.0.0.24），但不能用缓存的 sha 去校验 CDN。
- **不要长期依赖 `chrome.storage` 缓存**：一次清理就会丢。本报告已把能力契约固化成文字，不再依赖缓存文件存活。
- **小旺神自己的服务端仍活着**（`xiaowangshen.com/crx/xws/new/user/info/` 可访问）。停摆是主动决策，不是倒闭。
- **我们只吸收取数能力，不吸收它的服务端写入**（`xws-to-feishu-base`、竞品监控上云）。

---

## 9. 取证清单

| 项 | 位置 |
|---|---|
| 七份远端清单原文 | `evidence/xws-reverse-2026-10-26/manifests/*.json` |
| 机器可读能力地图 | `evidence/xws-reverse-2026-10-26/capability-map.json` |
| 解包脚本 | `tmp/xws-re/ldb.py`（LevelDB + snappy）、`ctxapi.py` / `ana.py`（接口抽取） |
| REA 静态分析产物 | `E:/REA/.dl/out/xws-2.0.0.7.json`（218MB）、`xws-2.1.0.6.json`（331MB） |
| 扩展源码 | `D:/Retire/edge-debug-profile/Default/Extensions/kmbagmjnoooeiindcnfgebkekiimbnee/2.1.0.6_1` |
| 解包出的模块源码 | `tmp/xws-re/mods/tb-detail.js`（3.0MB）、`tmp/xws-re/mods/tb-list.js`（2.76MB） |
