# 2026-10-16 开发日志 · 发布成飞书云文档

## 这份证据回答什么

用户要求「给今天的开发收尾，并将开发日志发到我的飞书文档去」。本目录是一次性产物与原始输出，用来复核「那份文档确实是这样生成、这样发布的」。

- 文档标题：**2026-10-16 开发日志 · 店铺日报链切换外组织 base（rcnb）**
- 文档 URL：<https://kcne618basvj.feishu.cn/docx/KvhMdMtSYohguZx53YecxBEjnJe>
- `document_id`：`KvhMdMtSYohguZx53YecxBEjnJe`（创建于云空间根目录，创建时未指定目录）
- 体裁：`workplace.weekly_report`；`presentation_mode=normal`；`visual_plan.blocks=[]`
- 终稿结构：`title`×1、`h1`×7、`table`×2、`callout`×1、`li`×8、`tr`×16；revision 4

## 落点是怎么定的（先查，不默认）

| 候选落点 | 本仓的现状 | 结论 |
|-|-|-|
| 多维表格（base） | `runtime/feishu-targets.mjs` 只有 base / 表 id（日报底单、商品、推广） | 适合结构化数据，不适合长文 |
| 群 / 个人消息 | `runtime/notify-feishu-core.mjs` 走消息接口（`receive_id_type` / `receive_id`） | 只适合短提醒与告警 |
| 云文档（docx） | 全仓没有「开发日志」这类文档目标 | **选用**（与 2026-09-22 先例一致：`evidence/daily-report-and-publish-2026-09-22/`） |

## 唯一一次卡点：用户身份令牌过期

- lark-cli 的 user 身份（`ou_e254f8d7…`）refresh 令牌 **2026-10-14 21:33 已过期并被清除** ⇒ `docs +fetch --as user` 报 `need_user_authorization`；bot 身份 ready，但 bot 建的文档归应用、不算「我的文档」，所以**没有**改用 bot。
- 走设备码登录：`auth login --domain docs,drive --no-wait` 拿 `verification_url` + `device_code` → 交给用户点击/扫码 → 用户确认后 `auth login --device-code <code>` 完成登录。第一枚 22:11 发的码 22:21 过期，23:18 重发后成功。
- 授权链接与二维码由助手在对话里展示；`device_code` 存仓库外 scratch（`D:/Retire/devlog-20261016/auth-device-code.json`），**不入库**。

## 流程（按 lark-doc 的最短闭环）

1. `init-draft`：工作区 `draft_61de6314_folder`。**本地脚本，不需要用户身份**；CLI 只建工作区，不建 `draft.xml`。
2. `parse`：`assessment.status=passed`（`word_count=896`、`block_count=120`、`h1=6`、`table=2`）。
3. `create`：`ok=true`、返回 `document_id` 与 `url`、**无 `warnings` 字段**。
4. `append`（晚间追加一段）：`ok=true`、`revision 4`、`result=success`、`warnings` 空。
5. `fetch` 回读两次：追加前 `title 1 / h1 6 / table 2 / callout 1 / li 6 / tr 16`；追加后 `h1 7`、`li 8`，关键段落逐条核对全在。

## 本目录文件清单

| 文件 | 是什么 | 复核要点 |
|-|-|-|
| `presentation-decision.json` | Step 2 提交的视觉决策 | `genre_contract=workplace.weekly_report`、`visual_plan.blocks=[]` |
| `draft.xml` | 发布用的正文（先发布这一份） | `title` 唯一且在首；标题 `seq="auto"`；两张表；一个高亮块 |
| `append-evening.xml` | 晚间追加的一段（定时对调 + 收尾结论） | 1 个 `h1`、2 个 `li`、3 个 `p` |
| `readback-1-before-append.json` | 追加前的独立回查 | `content` 里 title 1 / h1 6 / table 2 / callout 1 |
| `readback-2-after-append.json` | 追加后的独立回查 | h1 7、li 8；「晚间追加」「11:20」「DELIVERY_VERIFIED」均在场 |

## 未关闭缺口（写文档时就已声明）

- 2026-10-17 07:00 首轮全自动真跑尚未发生，其低值核对结论未知。
- 本批只做「写文档 + 发文档」，未启停任何进程 / 容器，未改仓库代码。
