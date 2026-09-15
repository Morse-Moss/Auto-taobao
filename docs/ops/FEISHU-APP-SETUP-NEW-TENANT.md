# 在新租户里准备一个可用的飞书应用（多维表格写入前置）

状态：2026-09-14 编写。起因是用户提供的实操表在另一个租户，本应用的凭据跨租户不可用。

## 0. 一句话结论

这**不是「恢复原本的权限」**。飞书自建应用是**租户级实体**：应用 `cli_aa93e98aeef81cef`
生存在租户 `rcndesfqro3x`，能读该租户里的竞品 base（10 张表 / 36 字段实测正常）；
而用户指定的表在租户 `kcne618basvj`。跨租户既不能把应用加为文档协作者，也不能共享 secret。
正确做法是在**目标租户里有一个等效应用**，再把它加为那张 base 的协作者。

## 1. 需要开通的权限（按代码实际调用的接口逐个对齐）

| 接口 | 用途 | 需要的权限 |
| --- | --- | --- |
| `POST /auth/v3/tenant_access_token/internal` | 取 tenant token | 无需单独权限（应用级） |
| `GET /bitable/v1/apps/:app/tables` | 列 base 下的表 | `bitable:app` |
| `POST /bitable/v1/apps/:app/tables` | 建表（演练表用） | `bitable:app` |
| `GET`/`POST /bitable/v1/apps/:app/tables/:tbl/fields` | 读写字段 | `bitable:app` |
| `GET /bitable/v1/apps/:app/tables/:tbl/records` | 回读、计数 | `bitable:app` |
| `POST .../records/batch_create`、`batch_update` | 写入记录 | `bitable:app` |
| `POST /drive/v1/medias/upload_all` | 上传商品图片附件 | `drive:drive` |

即最小集合 **`bitable:app` + `drive:drive`**（"查看、评论、编辑和管理多维表格" +
"查看、评论、编辑和管理云空间中所有文件"）。

## 2. 在新租户里的操作步骤

1. 用**新用户**登录 <https://open.feishu.cn/app>，进入你新建的那个应用。
   （"建了飞书机器人"就是在同一个应用里开的「机器人」能力，凭证在同一个应用下。）
2. 「凭证与基础信息」→ 复制 **App ID**（`cli_` 开头）与 **App Secret**。
3. 「权限管理」→ 搜索并开通 `bitable:app`、`drive:drive`。
4. 「版本管理与发布」→ **创建版本并发布**。权限变更必须发布新版本才生效；
   自建应用通常自己就是管理员，若是企业租户需管理员审批。
5. 把应用加为**那张多维表格**的协作者：打开 base → 右上角「分享 / ⋯」→
   「添加文档应用」（或「添加协作者」里搜应用名）→ 权限给「可编辑」。
   找不到应用时先确认第 4 步已发布；若这张 base 在**知识库（wiki）**里，
   还要在知识库设置里把应用加为成员，或直接在 wiki 页面上添加文档应用。
6. 把该租户的凭据写成 env 文件交给我，例如 `E:/小红书/.env.feishu-kcne.local`：

   ```
   FEISHU_APP_ID=cli_xxxxxxxxxxxx
   FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

   不要贴在聊天里，文件路径告诉我就行（沿用现有 `E:/小红书/.env.local` 的风格）。

## 3. 我接手后做什么

1. 只读验证：列该 base 的表、列目标表字段、读记录数——只证明"看得见"，
   不动任何数据。
2. 通过后再跑真实演练或正式导入（`runtime/sop-runtime/run-feishu-import-two-stage.mjs`，
   默认 dry-run，`--commit` 需要 `--env-file` + `--operator` 人工留痕）。
3. 目标表必须是**空表**且 16 字段齐备、`商品图片` 为附件字段（type 17），
   否则发布段会 fail-closed 拒绝写入。

## 4. 出错码对照（排查用）

| 码 | 含义 | 处理 |
| --- | --- | --- |
| `403 91403 Forbidden` | 应用在该文档上没有足够权限（未加协作者 / 只给了「可阅读」/ 跨租户） | 把应用加为该 base 的协作者并给「可编辑」/「可管理」 |
| `99991672`（HTTP 400） | **应用缺 scope**，返回体里会列出需要哪些 scope | 权限管理里补 scope 并**重新发布版本** |
| `1254060 TextFieldConvFail` | 目标字段是文本却写数字 | 字段类型需与合同一致（`价格` 用数字、`月收货人数` 用文本） |
| `1254069 AttachFieldConvFail` | 附件字段写入非法 | 附件字段连空串都非法，必须整键删除 |

**两个 403 类错误要分清**：`99991672` 是"应用根本没开这个 API 的权限"，返回体自带 scope 清单，
照着开通即可；`403 91403` 是"scope 有了，但这份文档不让你动"——只读协作者、或者没被加为协作者。
只读能力正常、写操作 91403，就是后者。

## 5. 诊断实录：新租户 `kcne618basvj`（2026-09-14，应用 `cli_a96ee8749078dbcf`）

| 调用 | 结果 |
| --- | --- |
| `POST /auth/v3/tenant_access_token/internal` | 200，token 正常 |
| `GET .../apps/OUMqbkYwVaQxQNsv2EDc1DV7nDf/tables` | 200，**11 张表全部可见** |
| `GET .../tables/tblg6lkg6431QulJ/fields`、`records` | 200 |
| `POST .../tables`（建表） | **403 91403** |
| `POST .../tables/tblg6lkg6431QulJ/fields`（建字段） | **403 91403**（不是 99991672） |

**结论：读通、写不通**——应用在该 base 上当时是只读身份。要能写，两件事必须同时满足：
① 开放平台补 `bitable:app`（注意不是 `bitable:app:readonly`）与 `drive:drive` 并重新发布版本；
② 在该 base 里把应用加为协作者、权限给「可编辑」。

**2026-09-14 复测（用户完成①②之后）：写通了。**
`POST /tables` 200、`POST /tables/:id/fields` 200、回读字段 `文本:1, 价格:2`、`DELETE` 200，
演练表即时删除，base 回到原 11 张表。随后在该 base 上跑通了完整的两段式真实提交
（`publicationStatus=VERIFIED`、游标 1→3、独立回读 3 行 3 附件），证据见
`docs/ops/TENANT-MIGRATION-MAP.md` §5.3。

**副本事实**：该 base 的 10 张生产表与现用 base `OWebbPUcBa7B8JseYLccQCy9nkf`
**逐表行数完全相同**（2004/734/4346/2023/1461/734/2023/1423/0/1462），表 ID 不同，
另多一张默认「数据表」`tblg6lkg6431QulJ`（1 字段 / 5 行）——即原 base 的完整副本。
若要把周更 SOP 切到新租户，所有 base token 与 table ID 都要换一遍。

**一条容易误会的事实（2026-09-14 实测更正）**：关键词库 base
`N21Abkg0HakO6AsbCaDckvcwnVd`（名字是「词库 最新 副本」）**仍在旧租户**
`rcndesfqro3x`，**不在**新租户。新应用能读它，靠的是跨租户共享（外部协作者），
不是因为它在新区。原因是**复制一张 base 只会复制那张 base 自己**——词库是另一张独立的
base，不属于竞品 base，所以复制竞品 base 时不会带上它。
`/drive/v1/files`（应用云空间根目录）对新应用返回空列表，所以无法从应用侧枚举新区里
是否另有一份；要确认只能在浏览器里看。

**同样地，新应用目前同时是旧生产 base、副本 base、词库 base 的协作者**（跨租户）。
这三处授权哪些该保留需要逐个确认。

## 6. 参考：本环境的既有事实

- 应用 `cli_aa93e98aeef81cef` 属租户 `rcndesfqro3x`；凭据在 `E:/小红书/.env.local`。
- 该租户内可见：竞品 base `OWebbPUcBa7B8JseYLccQCy9nkf`（10 表）、
  应用自有 base `Hohobp2UDaq698sXAQSc6SRXn3f`（2 表，演练表曾建在此、用完已删）。
- 跨租户表的只读复检记录：4 次均 `403 91403`（见 MIGRATION-8 §8）。

## 7. 发消息权限（`im:message:send_as_bot`）怎么开

2026-09-15 补充。起因：用户反馈在「权限管理」里**搜不到** `im:message:send_as_bot`。
原因是控制台**显示中文名**、且按「应用身份」分组，直接搜英文标识容易搜不到。

| 项 | 值 |
| --- | --- |
| 权限名称（控制台显示） | **以应用的身份发消息** |
| 权限标识 | `im:message:send_as_bot` |
| 权限类型 | 应用身份（`tenant_access_token`） |
| 对应接口 | `POST /im/v1/messages`（发给单聊或群） |

直达该应用的权限申请页（`q` 就是搜索词，可用权限标识）：

> <https://open.feishu.cn/app/cli_a96ee8749078dbcf/auth?q=im:message:send_as_bot>

搜不到的三种原因，按可能性排：

1. 搜的是英文代码或「发送消息」，而列表显示的是中文名 → 改搜「以应用的身份」。
2. 面板分「API 权限 / 数据权限」与「应用身份 / 用户身份」，要在 **API 权限 + 应用身份** 这一组里找。
3. 应用没加「机器人」能力时，消息类权限可能不出现 → 先看「应用能力 → 添加应用能力 → 机器人」，
   并确认它加在**同一个应用** `cli_a96ee8749078dbcf` 下（本项目现在用的就是这个应用）。

**收件人怎么指**：`POST /im/v1/messages` 的 `receive_id_type` 支持
`open_id` / `user_id` / `union_id` / `email` / `chat_id`。
用 **`email`** 可以直接给指定的人发单聊，**不需要额外开通通讯录权限**（发完用一次真实调用验证即可）；
若要按 `open_id`/`user_id` 发，通常需要用户先与机器人产生会话，或另开 `contact:user.id:readonly`。

**两件必须一起做、否则不生效的事**：

1. **发布版本**：「版本管理与发布 → 创建版本 → 发布」。权限变更不发布版本不生效
   （本项目 2026-09-14 已在多维表格权限上踩过同一个坑）。
2. **可用范围**：若应用设了「可见范围」，要把运营加进可见范围，否则消息发不出去。
