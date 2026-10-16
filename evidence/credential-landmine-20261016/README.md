# 凭据地雷：商品/推广链已指向外组织 base，但凭据仍是本组织 kcne（2026-10-16 20:40 只读取证）

## 一句话

2026-10-16 17:54 的 `af63b71` 把 **商品（1部/2部）与推广（1部）** 的飞书 base 从本组织 kcne
换到了**外组织 rcnbpuvafkct**；但同一天 17:08 的 `1.12.0` 只给**日报链**接了「对方组织的
应用凭据」（`dailyReportCredentials` + `envFile`）。商品/推广的写入口**仍然用
`loadFeishuCredentials('kcne')`** —— 那是本组织应用的凭据，对外组织那几张 base 只有
链接分享级只读。⇒ **这两条链下一次真写真会 403/91403。**

## 会什么时候炸

| 时间 | 自动化（宿主 `~/.workbuddy/logs/automation.log` 里的真名） | 写入口 | 会撞的坑 |
| --- | --- | --- | --- |
| 07:00 | sycm 推广日报定时（每日 07:00 · 销售1部 8 家） | `skills/sycm-alimama-daily-report/scripts/import-promotion-daily-report.mjs:52` `loadFeishuCredentials(profile)`，落点 `promotionDailyTargets()` = 外组织 `CjLsb7qXRaeaC6srePtcLBkInTh` | 写 403 |
| 10:00 | sycm 商品数据定时跑（销售1部 8 家，每日 10:00） | `skills/sycm-product-data/scripts/import-product-data.mjs:24`、`skills/sycm-inquiry-data/scripts/import-inquiry-data.mjs:13`、`skills/sycm-promotion-data/scripts/import-promotion-data.mjs:17` —— 三处都是 `loadFeishuCredentials('kcne')` + `productDataTargetsForShop(...)` = 外组织商品 base | 读/写都可能 403 |
| 11:00 | sycm 日报定时（每日 11:00 · 销售1部 8 家） | **已修好**（1.12.0 的三个入口走 `dailyReportCredentials`） | 不受影响 |

## 只读取证（本目录 `perms-output.txt`，可复跑）

```
node evidence/credential-landmine-20261016/check-rcnb-perms.mjs
```

四张外组织 base 的实测（kcne 凭据）：

| base | 协作者接口 | app 信息 |
| --- | --- | --- |
| 日报 `RqzrbD4z…`（**对照**：已知写入 403/91403） | 403 `1063004 User has no share permission` | 200 `code 0`（可读） |
| 推广1部 `CjLsb7qXRaeaC6srePtcLBkInTh` | 403 `1063004` | 200 `code 0`（可读） |
| 商品1部 `LQgZbi78oaAmIYsc4urcwk9rnNf` | 403 `1063004` | **403 `91403 Forbidden`**（连 app 信息都读不到） |
| 商品2部 `LLWcbIuVFaBm6yshX9Xc8DFZn9d` | 403 `1063004` | 200 `code 0`（可读） |

**四张 base 的协作者接口与「已证实写入被拒」的日报 base 完全同形** ⇒ 结论：kcne 不是这四张
base 的协作者。

## 这份证据的边界（说清楚，别当成结论）

- 这是**只读取证**：协作者接口 + app 信息，**没有做幂等写探针**。
  「写会失败」是**高置信推断**（同组织、同共享形态、日报 base 已实测写 403/91403），
  不是直接实测。要变成实测，得跑幂等写探针（把某一行的某个字段原样写回）。
- 商品1部那张连 app 信息都 403/91403 ⇒ 商品链的**去重读**（`client.listRecords()`）
  在那张 base 上也会先失败，不会走到写。

## 修法（`1.12.0` 的模式现成，照抄即可）

1. `runtime/feishu-targets.mjs`：给 `promotionDaily` 与商品那两张（`PRODUCT_DATA_MONTH_BASES['2026-10']`
   的 sales1/sales2）各加 `envFile`（对方组织的凭据文件；与日报共用同一个
   `E:/小红书/.env.feishu-rcnb.local` 即可，只要那个应用被加为这几张 base 的可编辑协作者）。
2. 加一个按 target 解析凭据的访问器（可把 `dailyReportCredentials` 泛化成
   `targetCredentials(target)`，或照它再写几个），把上面 4 个调用点从
   `loadFeishuCredentials('kcne')` 切过去。
3. **先探针后切换**：每张 base 跑一次幂等写探针，`200/code 0` 才算通；不然就是换个地方撞墙。
   （注意 1.12.0 记录的探针坑：type 1 文本字段写纯字符串，segments 格式会 1254060。）
4. 切完补 CHANGELOG，并按 `AGENTS.md` 的版本/提交纪律同一个提交。

## 归属

迁移（换 base）是 2026-10-16 另一个会话做的，`1.12.0` 的模式也是他们写的 ⇒
**由迁移方修最省事**（他们有上下文、且这是同一次迁移的另一半）。本目录只提供取证与清单，
**未改动任何共享代码**（动共享代码需要用户明确点头）。
