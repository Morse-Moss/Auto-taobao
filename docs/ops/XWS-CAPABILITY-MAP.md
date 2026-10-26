# 小旺神全能力反向报告（2026-10-26）

对象：小旺神扩展 `kmbagmjnoooeiindcnfgebkekiimbnee` 2.1.0.6（MV3，49 个 JS，12 组 content_scripts，224 条 host 权限）
方法：REA 静态分析产物 + 扩展源码直读 + `chrome.storage.local` 的 LevelDB 离线解包
取证：`evidence/xws-reverse-2026-10-26/`（7 份远端清单 + 本报告 + `capability-map.json`）

---

## 0. 结论先行

1. **停摆不是服务端停服。** 远端清单仍在、仍可 200 读到，但客户端 `normalize()` 在展开服务端策略之后，**再次硬写入 `search:false, detail:false`**，把账号权限覆盖掉。付费号、管理员号一样被关。
2. **模块文件已从 CDN 删除。** `/modules/tb-detail.*.js`、`/modules/tb-list.*.js` 等全部 404。现存的完整模块源码只在浏览器 `chrome.storage.local` 缓存里，本次已离线解包取出（详情 3.0MB、列表 2.76MB）。
3. **小旺神的能力不是"一个搜索页功能"，是 7 个远端模块族、约 50 个前端组件。** 我们目前只吸收了其中 1 项（搜索页市场分析 → 16 列周报）。
4. **SKU 与 FAQ 的取数路径已完全拿到**，见第 4 节：SKU 走 `mtop.taobao.pcdetail.data.get`，评价走 `mtop.taobao.rate.detaillist.get v6.0`，买家秀走 `mtop.taobao.ugc.itemshow.list`。三条都是**淘宝原生接口 + 页面现算签名**，不需要逆向风控。

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
| **采集问大家** | （入口已随锁失效） | 仅剩 DOM 计数：`[class*="askAnswerWrap--"] [class*="askAnswerTitle--"]` 文本「问大家 · N」 | — | 数量 | ❌ |

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

**已吸收（1 项）**
- 搜索页市场分析 → `runtime/taobao-search-core.mjs`（16 列契约）+ `runtime/collect-taobao-search.mjs`（采集）+ 周表全链。同源接口，已产出 1384 行周表并写入飞书。

**未吸收（10 项）**，按对我们的价值排序：

1. **详情页 SKU** → `mtop.taobao.pcdetail.data.get`。周表「尺寸 / 适用空间」两列的 Lookup 来源，优先级最高。
2. **评价下载** → `mtop.taobao.rate.detaillist.get v6.0`。可做差评归因、卖点验证。
3. **问大家** → 模块里只剩数量读取，采集入口已随锁失效，需另探接口（候选：`mtop.taobao.ugc.tql.facade` 的其它 `sceneName`）。
4. **买家秀** → `mtop.taobao.ugc.itemshow.list`。可作为真实使用场景的图片素材。
5. **店铺上新** → `mtop.taobao.shop.simple.fetch` / `item.fetch`。竞品上新监控。
6. **批量查排名** → appId 34385 翻页定位。
7. **以图搜同款 / 同款数** → appId 34850 `strimg`。
8. **店铺信誉** → 详情页模块内无实现，需另找入口（`tb-seller` 模块未取得）。
9. **违禁词检测** → 本地词库，与淘宝无关。
10. **车图下载** → appId 34385。

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
