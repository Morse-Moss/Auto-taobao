# 2026-09-22 日报：把当天工作总结发布成飞书云文档

## 这份证据回答什么

用户要求「把今天的问题和解决方案，还有工作成果，经验总结成日报发到飞书」。
本目录是一次性产物与原始输出，用来复核「那份文档确实是这样生成、这样发布的」。

- 文档标题：**2026-09-22 日报 · 淘宝五店日报自动化**
- 文档 URL：<https://kcne618basvj.feishu.cn/docx/Cv6mdV5wVo718WxLRjIcyC82nZ3>
- `document_id`：`Cv6mdV5wVo718WxLRjIcyC82nZ3`（创建于云空间根目录，创建时未指定目录）
- 体裁：`workplace.weekly_report`（日报是该 leaf 点名的形态）；`presentation_mode=normal`；`visual_plan.blocks=[]`

## 落点是怎么定的（先查，不默认）

| 候选落点 | 本仓的现状 | 结论 |
|-|-|-|
| 多维表格（base） | `runtime/feishu-targets.mjs` 只有 base / 表 id（日报底单 `PTfHbPt9EaIzddsfL8Jcj238nrb` 等） | 不适合承载长文 |
| 群 / 个人消息 | `runtime/notify-feishu-core.mjs` 走消息接口（`receive_id_type` / `receive_id`，默认 `chat_id`） | 只适合短提醒与告警 |
| 云文档（docx） | 全仓没有「工作日报」这类文档目标 | **选用** |

⇒ 结论：本仓此前**没有**「日报文档」这个落点，所以用飞书云文档承载，并在交付时说明落在了哪里。

## 工具链的关键一处：lark-cli 的 sh shim 在本机不可用

`lark-cli <子命令>` 在本机直接报：

```
sed: command not found
dirname: command not found
Error: Cannot find module 'D:\node_modules\@larksuite\cli\scripts\run.js'
```

**工具是装好的**（`.../binaries/node/cli-connector-packages/node_modules/@larksuite/cli/`），
坏的是启动器：那个 sh shim 用 `dirname` / `sed` / `uname` 算自身目录，而本机 Git Bash 没有 coreutils，
`basedir` 解析成空串，于是拼出盘根下的假路径。

绕法落在本目录的 `lark-cli-invoker.mjs`：直接调真实入口，并用 `spawnSync` **传数组**（中文与 JSON 参数不过 shell）。

复核命令（在**仓库根目录**执行，因为 `@相对路径` 以 CWD 为基准）：

```bash
node evidence/daily-report-and-publish-2026-09-22/lark-cli-invoker.mjs \
  docs +fetch --doc "Cv6mdV5wVo718WxLRjIcyC82nZ3" --as user --format json
```

## 本目录文件清单

| 文件 | 是什么 | 复核要点 |
|-|-|-|
| `presentation-decision.json` | Step 4 提交的视觉决策（`init-draft` 的固定基线） | `genre_contract=workplace.weekly_report`、`visual_plan.blocks=[]` |
| `draft.xml` | 最终 release candidate（发布用的就是它） | `<title>` 唯一且在首；标题带 `seq="auto"`；两张表；一个高亮块 |
| `01-init-draft.txt` | 初始化草稿工作区的返回 | `data.workspace=draft_fa9f921e_folder`、`data.draft_path=…/draft.xml` |
| `02-parse-draft-profile-check.txt` | Draft Profile Check | `data.assessment.status=passed`；`word_count=3295`、`block_count=147` |
| `03-create-document.txt` | 创建返回 | `ok=true`、`document_id`、`url`；**无 `warnings` 字段** |
| `04-readback-fetch.txt` | 独立回查全文 | `content` 里 title×1、h1×7、table×2、callout×1；`seq-marker` 已自动编号 |
| `05-readback-callout-block.txt` | 关键词定位高亮块拿 block id | 见下方「唯一一处降级」 |
| `06-daily-base-readback.txt` | 写日报当天拉的底单现状（只读） | 总行数 1899；09-21 = 5 行（齐）、09-20 = 4 行、09-22 = 0 行 |
| `07-workspace-state.txt` | 收尾时的仓库现状 | 本地领先 `origin/main` 6 个提交；脏文件均属其它会话 |
| `lark-cli-invoker.mjs` | 上面的通用调用器 | 绝对路径 + `process.cwd()`，复制到任何位置都能跑 |

## 唯一一处降级（已判定不需要修）

源码写的是 `<callout emoji="⚠️" background-color="light-yellow" border-color="yellow">`，
服务端归一化成：

```
<callout background-color="rgb(254,255,240)" border-color="rgb(255,242,88)" emoji="💡">
```

即 **颜色其实落地了**（浅黄底 + 黄色边），只有 `emoji` 被换掉。
⇒ 判「有没有降级」要回读**实际属性值**，不能拿「和源码不一样」当判据；
这里既不是样式丢失，也没有内容丢失，故**没有**再开一轮 `docs +update`，更没有重建文档
（流程明令：局部问题只能对已创建文档做最小修复，不得再新建一份）。

## 未关闭缺口（写日报时就已声明）

- 09-20 缺「科塔全卫定制」1 行：用户明确决定不补，作为旧欠账留档。
- 09-22 目标日 0 行：定时链 11:40 跑的目标日始终是前一天，属预期，不是故障。
- 本批只做「读 + 发文档」，**没有真跑日报链**，没有启停任何浏览器或容器，没有碰飞书底单数据。
