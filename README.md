# 生意参谋到飞书自动化

项目根目录：`D:\Retire\sycm-automation`

## 目录

- `skills/sycm-export-search-rank`：生意参谋搜索排行采集、CSV/XLSX 输出与校验。
- `skills/xws-export-market-analysis`：从淘宝首页运行小旺神市场分析，监管慢速采集并校验 CSV/XLSX 竞品数据。
- `skills/xws-to-feishu-base`：提取小旺神 XLSX 内嵌商品图，通过飞书 API 上传素材并写入授权空副本的附件字段。
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

## 周更边界

周更前半程使用 `run-weekly-pre-ai.mjs`：每次从生意参谋首页进入搜索排行后显式选择并验收 `7天`，以 `collection-date` 作为七天区间结束日；单日、区间不完整或回执无法证明七天的数据会在任何飞书写入前被拒绝。显式复用既有数据时必须同时提供 CSV/XLSX，脚本会回读验证页、逐字段比较并锁定两个文件哈希，不能只凭 CSV 文件名跳过采集。随后在同一 Base 复制上一周结构、追加本周表和历史，并生成携带当前表、上一周表、历史表、批次和行数精确上下文的 `pre-ai-manifest.json`，停在 `READY_FOR_AI`。用户只运行运营已确认的飞书 AI 字段；完成后将该清单交给 `run-weekly-post-ai.mjs`，它会按顺序完成公式 dry-run/必要迁移、灰豚 dry-run/回填、历史 dry-run/同步和最终幂等验收。`是否重点词`不依赖内容热度，`对应产品方向`由三个近两周达标次数按“主推 > 增长 > 探索 > 暂无”自动计算。灰豚返回 `AI_REQUIRED` 时整链停止且不会同步历史；`DONE_NO_CANDIDATES` 会跳过灰豚写入并继续历史同步。

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
