# 生意参谋到飞书自动化

项目根目录：`D:\Retire\sycm-automation`

## 目录

- `skills/sycm-export-search-rank`：生意参谋搜索排行采集、CSV/XLSX 输出与校验。
- `skills/xws-export-market-analysis`：从淘宝首页运行小旺神市场分析，监管慢速采集并校验 CSV/XLSX 竞品数据。
- `skills/xws-to-feishu-base`：提取小旺神 XLSX 内嵌商品图，通过飞书 API 上传素材并写入授权空副本的附件字段。
- `skills/sycm-to-feishu-base`：飞书副本字段检查、TSV 构建、真实粘贴与导入验收。
- `skills/huitun-to-feishu-keyword-heat`：读取飞书 `A候选` 队列，在灰豚红薯版采集完全同名话题浏览量，并受保护回填内容热度。
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

## 验证

```powershell
node "D:\Retire\sycm-automation\skills\sycm-export-search-rank\scripts\export-search-rank.mjs" --self-test
node --test "D:\Retire\sycm-automation\skills\sycm-export-search-rank\scripts\full-flow.test.mjs" "D:\Retire\sycm-automation\skills\sycm-export-search-rank\scripts\output-publish.test.mjs"
node "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\tests\build-paste-tsv.test.mjs"
node "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\tests\inspect-fields.test.mjs"
node --test "D:\Retire\sycm-automation\skills\xws-export-market-analysis\tests\flow.test.mjs" "D:\Retire\sycm-automation\skills\xws-export-market-analysis\tests\cli.test.mjs" "D:\Retire\sycm-automation\skills\xws-export-market-analysis\tests\validate-output.test.mjs" "D:\Retire\sycm-automation\skills\xws-export-market-analysis\tests\prepare-flow.test.mjs"
node "D:\Retire\sycm-automation\skills\xws-export-market-analysis\scripts\export-market-analysis.mjs" --self-test
py -3 "D:\Retire\sycm-automation\skills\xws-export-market-analysis\scripts\validate-output.py" --self-test
node --test "D:\Retire\sycm-automation\skills\xws-to-feishu-base\tests\*.test.mjs"
py -3 -m unittest "D:\Retire\sycm-automation\skills\xws-to-feishu-base\tests\extract_xws_xlsx_test.py"
node --test "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\tests\*.test.mjs"
node "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs" --self-test
```
