# 生意参谋到飞书自动化

项目根目录：`D:\Retire\sycm-automation`

## 目录

- `skills/sycm-export-search-rank`：生意参谋搜索排行采集、CSV/XLSX 输出与校验。
- `skills/xws-export-market-analysis`：从淘宝首页运行小旺神市场分析，监管慢速采集并校验 CSV/XLSX 竞品数据。
- `skills/xws-to-feishu-base`：提取小旺神 XLSX 内嵌商品图，通过飞书 API 写入授权副本，并维护竞品分类、公式和 AI 提示词合同。
- `skills/xws-sku-collection`：v1.2.0，从真实淘宝商品页点击小旺神 SKU 控件，原子读取 Windows 剪贴板、按商品独立维护 `batch-index.json` 并生成可复现 dry-run，在精确授权后写入飞书 `SKU明细` 与回读验收。
- `skills/xws-faq-operator`：v1.1.0，面向运营的 FAQ 周更总入口，通过自然语言检查状态、断点续跑并安全发布固定 `问题库`。
- `skills/xws-faq-raw-collection`：锁定最新竞品周 A/B TOP5，保存小旺神问大家与评论原始证据。
- `skills/xws-question-library-collection`：将已验证原始证据幂等写入日期问题库表。
- `skills/sycm-to-feishu-base`：飞书副本字段检查、TSV 构建、真实粘贴与导入验收。
- `skills/huitun-to-feishu-keyword-heat`：读取飞书 `A候选` 队列，在灰豚红薯版采集完全同名话题浏览量，并只回填 `灰豚话题浏览量`；`内容热度`由上游流程提供。
- `evidence/stability-20260804`：三轮 267 行稳定性验证文件。
- `runtime`：后续项目专用运行入口。
- `docs/project-knowledge.md`：项目定位、真实能力、验证证据与对外表述边界。
- `docs/references/revolution-knowledge-patterns.md`：从 Revolution 知识库迁移并本地化的证据治理方法。

## 外部依赖

- 共享 `web-access` Skill 和 CDP Proxy：`D:\codex\skills\web-access`
- 已登录的 Edge 用户会话
- 外部飞书应用凭据文件：当前位于 `E:\小红书\.env.local`，仅向导入命令传入路径，不复制凭据值

账号密码、Cookie、浏览器用户目录和安全验证数据不属于项目资产，不复制到本目录。

全局 Skill 入口 `D:\codex\skills\sycm-*`、`D:\codex\skills\xws-*` 和 `D:\codex\skills\huitun-*` 是指向本项目 `skills` 目录的目录联接，不是第二份代码。

## 竞品分析 V2

`竞品主表`保留小旺神 16 个源字段和真实图片附件。`是否有效竞品`由商品标题的明确证据自动重算；类目仍原样保留，但配件也可能挂在浴缸类目下，因此不作为有效性依据。只有“是”才计算或分析后续字段；“否”和“待确认”只保留原始数据与状态。有效竞品的七个 AI 字段空值回填为`无注明`，`否`和`待确认`统一回填为`不适用`，已有非空分析值不覆盖。`排除原因`同样由公式输出。`竞品分类`为单一公式结果 `A-爆款竞品/B-高价值竞品/C-差异化竞品/D-价格/流量型竞品/无分类/不适用`，按 `A > B > C > D` 优先级输出；价格缺失时为`不适用`，C 类固定为`价格>=8000`，不再使用主图、异形或造型特殊判断。`待补数据项`检查月收货人数和全部七个 AI 字段，`无注明`与`不适用`都视为缺少证据；`数据状态`对有效竞品输出`可用`或`部分待补`，非有效和待确认留空。`PMMA、高分子、绮美石、可丽耐、杜邦石、亚克力人造石`统一归入人造石，普通亚克力仍归亚克力。

已有授权副本通过 `migrate-competitor-v2-analysis.mjs` 受控升级：9 个确定性字段全部由飞书实时公式生成并回读验证，迁移脚本不会把本地分类器结果写入记录。执行顺序固定为“公式/选项更新 -> 飞书回读收敛 -> 仅按回读的`是否有效竞品`生成 AI 哨兵值 -> 只写 7 个 AI 字段 -> 再回读验证”。本轮飞书 AI 无额度时，AI 字段只允许空值哨兵回填：有效竞品为`无注明`，`否`/`待确认`为`不适用`；已有非空值不覆盖。迁移脚本不点击、不运行飞书 AI，`aiRunTriggered=false`。

## FAQ 周更

运营只使用固定的 `问题库` 表，并通过自然语言让 Codex 执行 `xws-faq-operator`。内部按周期保留原始表、分析表和飞书公式汇总表，用于追溯和重跑。TOP5 固定从最新有效竞品周的 A-爆款竞品与 B-高价值竞品中，按月收货人数计算值降序、序号升序锁定。分类使用版本化确定性规则；出现次数来自飞书汇总公式回读，不调用飞书 AI。

统一入口为 `runtime/run-faq-operator.mjs`：`--status` 只读检查，`--advance` 每次只推进一个阶段；浏览器采集遇到登录、验证码、风控、额度或下载失败时停在当前商品并保留告警。固定 `问题库` 同内容重复发布必须为 `toCreate=0`；跨周替换只在运营明确要求更新时使用 `--replace-current`，并执行备份、替换、回读，失败时恢复上一版。

## 周更边界

周更前半程使用 `run-weekly-pre-ai.mjs`：每次从生意参谋首页进入搜索排行后显式选择并验收 `7天`，以 `collection-date` 作为七天区间结束日；单日、区间不完整或回执无法证明七天的数据会在任何飞书写入前被拒绝。显式复用既有数据时必须同时提供 CSV/XLSX，脚本会回读验证页、逐字段比较并锁定两个文件哈希，不能只凭 CSV 文件名跳过采集。随后在同一 Base 复制上一周结构、追加本周表和历史，并生成携带当前表、上一周表、历史表、批次和行数精确上下文的 `pre-ai-manifest.json`，停在 `READY_FOR_AI`。用户只运行运营已确认的飞书 AI 字段；完成后将该清单交给 `run-weekly-post-ai.mjs`，它会按顺序完成公式 dry-run/必要迁移、灰豚 dry-run/回填、历史 dry-run/同步和最终幂等验收。`是否重点词`不依赖内容热度，`对应产品方向`由三个近两周达标次数按“主推 > 增长 > 探索 > 暂无”自动计算。灰豚返回 `AI_REQUIRED` 时整链停止且不会同步历史；`DONE_NO_CANDIDATES` 会跳过灰豚写入并继续历史同步。

三个 `近2周...达标次数` 是飞书实时公式，不再由周更脚本硬写。历史同步只冻结有效批次的 `0/1` 证据，并按永久关键词编号向本周表写入三个 `上一有效周...达标` 数字快照；本周搜索、交易、内容或灰豚数据变化后，近2周次数、重点词、优先级和产品方向会连续重算。缺少上一周或本周证据时只保留对应结果为空，`A候选`不能按未达标 `0` 处理。

固定可视化只读取 `关键词历史总表 V1`，不为每周数据新建仪表盘。历史同步会把有效周分析表的 `标准归并词`、`是否重点词`、`优先级`冻结为文本快照，并维护公式字段 `本期标记`；只有“当前批次编号且批次有效性=有效”的记录为“是”。所有图表统一筛选 `本期标记=是` 和 `批次有效性=有效`。每周成功同步后只需更新一次该公式中的当前批次号，图表自动切换；当前批次快照不完整时禁止切换。

当前授权 Base 的两周依据为批次 `[1,3]`：`关键词分析 V1（修正版）`对应批次 1，`关键词分析 V1（2026-08-15）`对应批次 3；批次 2 是已确认的单日周期错误数据，只保留审计并排除。旧批次有效性为空时不得自行纳入；只有显式给出上一周表、目标批次与预期行数，并通过永久关键词编号集合完全一致校验后，才允许把该批次受控提升为`有效`。

```powershell
node "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\scripts\run-weekly-post-ai.mjs" `
  --pre-ai-manifest "<pre-ai-manifest.json>" --apply `
  --confirm-base <app-token> --confirm-current-table <current-table-id> `
  --confirm-history-table <history-table-id>
```

## 验证

```powershell
node "D:\Retire\sycm-automation\skills\sycm-export-search-rank\scripts\export-search-rank.mjs" --self-test
node --test "D:\Retire\sycm-automation\skills\sycm-export-search-rank\scripts\full-flow.test.mjs" "D:\Retire\sycm-automation\skills\sycm-export-search-rank\scripts\output-publish.test.mjs"
node --test "D:\Retire\sycm-automation\skills\sycm-export-search-rank\scripts\source-period-proof.test.mjs"
node "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\tests\build-paste-tsv.test.mjs"
node "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\tests\inspect-fields.test.mjs"
node --test "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\tests\copy-weekly-table.test.mjs" "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\tests\update-weekly-base.test.mjs"
node --test "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\tests\sync-decision-history.test.mjs" "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\tests\run-weekly-pre-ai.test.mjs"
node --test "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\tests\run-weekly-post-ai.test.mjs"
node --test "D:\Retire\sycm-automation\runtime\keyword-decision-formulas.test.mjs" "D:\Retire\sycm-automation\runtime\apply-weekly-decision-formulas.test.mjs"
node --test "D:\Retire\sycm-automation\skills\xws-export-market-analysis\tests\flow.test.mjs" "D:\Retire\sycm-automation\skills\xws-export-market-analysis\tests\cli.test.mjs" "D:\Retire\sycm-automation\skills\xws-export-market-analysis\tests\validate-output.test.mjs" "D:\Retire\sycm-automation\skills\xws-export-market-analysis\tests\prepare-flow.test.mjs"
node "D:\Retire\sycm-automation\skills\xws-export-market-analysis\scripts\export-market-analysis.mjs" --self-test
py -3 "D:\Retire\sycm-automation\skills\xws-export-market-analysis\scripts\validate-output.py" --self-test
node --test "D:\Retire\sycm-automation\skills\xws-to-feishu-base\tests\*.test.mjs"
py -3 -m unittest "D:\Retire\sycm-automation\skills\xws-to-feishu-base\tests\extract_xws_xlsx_test.py"
node --test "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\tests\*.test.mjs"
node "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs" --self-test
```
