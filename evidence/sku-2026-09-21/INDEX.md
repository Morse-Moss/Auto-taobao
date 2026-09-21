# 第 6 步（SKU 富化）执行记录 2026-09-21

## 结论先行

**本期不需要任何写入。** dry-run 结果 `DRY_RUN_READY`：`parsedRows 96 / toCreate 0 / alreadyPresent 96 / conflict 0`。
即：本期唯一那条 A/B 竞品（`921092099640`）的 96 个 SKU **早已在 `SKU明细` 表里**（2026-09-16 写入），
本次采集读到的 payload 与其**逐字节相同** ⇒ 幂等命中，无新增。

## 执行链（全部只读或本地落盘，未写飞书）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 预检 | `runtime/xws-sku-auth-preflight.mjs` | `AUTH_READY`，`pluginPresent=true`、`skuControlPresent=true`，商品页正常加载（**无登录墙**） |
| 采集 | `runtime/capture-xws-sku-payload.mjs` | `payloadSha256 = 1ada52ee…`，551 字符 |
| 拓扑 | `runtime/collect-live-xws-sku-topology.mjs` | `propertyCount 2`、`validCombinationCount 96`、`topologySha256 = ad50bbe4…` |
| dry-run | `runtime/run-xws-sku-dry-run.mjs` | `DRY_RUN_READY`，`toCreate 0 / alreadyPresent 96` |

## 关键取证：payload 与 09-16 逐字节相同

本次 `payloadSha256 = 1ada52eeb0d931f6ed216a714e9101173503f77c85eb98016eac14282d3f7ba4`
与 `evidence/sku-2026-09-13_2026-09-19/xws-sku-capture-2026-09-16T03-01-57-630Z-*.json` 的
`payloadSha256` **完全一致** ⇒ 该商品的 SKU 在这 5 天内没有变化，采集路径**可复现**。

## 两个与文档/契约有关的观察（本轮实测）

1. **页面上没有「已复制」提示**。点击后 400ms 与 1.2s 两次探测（含 MutationObserver 监听
   `document.body` 的 childList/subtree/characterData）都未观察到该文本；`body.innerText` 里
   也不含「复制」任何字样（`hits: []`）。⇒ 走 SKILL.md §2 的「无成功 toast 时，**可见的 SKU 控件
   ＋ 剪贴板读取成功**即足够」分支。本次剪贴板确实读到了正确的 payload。
2. **工具条里有静态文本 `请登录`**（`el-tooltip cate-text`）。这正是 SKILL.md §1.7.1 专门规定的
   情形——**不是登录墙**，预检判 `AUTH_READY` 是正确的，不应据此要求操作者去登录。

## 实现细节（复现时用得上）

- 真实鼠标手势的点法：代理端点 **`POST /clickText?target=<id>`**（body `{"text":"SKU"}`）。
  它用 `Accessibility.getFullAXTree` 按**精确名称**匹配，唯一命中才用 `DOM.getBoxModel` 取中心点并
  发 `Input.dispatchMouseEvent`。**不要用 `POST /click`** —— 那个是 `el.click()` 合成事件，不是可信手势。
- 目标唯一性核对（动作前）：`#xws-copy` 内共 9 个可见 `.xws-copy-item.xws-copy-link`，文本恰为 `SKU` 的**只有 1 个**。
- 剪贴板读取：`capture-xws-sku-payload.mjs` 走 PowerShell `Get-Clipboard -Raw`（Windows 系统剪贴板）。
  **不要**试图用 `/eval` 读 `navigator.clipboard.readText()`——该端点不 await，实测直接超时。
- 中文参数（`--classification B-高价值竞品`、`--validity 是`、`--copy-feedback 已复制`）**必须经
  `spawn` 传数组**，不要经过 shell（会被 GBK 打坏）。
- `--env-file` 可省略：`run-xws-sku-dry-run.mjs` 的默认值取自 `runtime/feishu-targets.mjs`，
  省掉它同时也就避开了含中文的 env 路径。

## 本目录文件

| 文件 | 说明 |
| --- | --- |
| `xws-sku-auth-status-20260921T015933958Z-908b62ad-d26.json` | 登录态预检收据 |
| `xws-sku-capture-2026-09-21T02-02-46-022Z-1ada52eeb0d9.json` | 剪贴板捕获收据 |
| `xws-sku-topology-921092099640.json` / `…-receipt-….json` | 页面 SKU 拓扑与收据 |
| `xws-sku-dry-run-manifest-….json` / `…-receipt-….json` | dry-run 计划与收据 |
| `batch-index.json` | 批次索引（上述文件的规范映射） |
| `xws-sku-payload-….txt` | **受保护证据**：原始 SKU payload。SKILL.md 明令不得提交／上传／打印 |

## 遗留：payload 的处置与 SKILL.md 冲突（待定）

`git ls-files` 实测：`evidence/sku-2026-09-13_2026-09-19/` 下的**两个 payload 文件已被 git 跟踪**，
且 `.gitignore` 并未排除它们。这与 SKILL.md §Safety Contract 的
「Raw copied SKU payloads are protected local evidence and must not be … committed」冲突。
本轮**未提交** `xws-sku-payload-….txt`；是否把 payload 加进 `.gitignore`（并清理历史）需要单独决定。
