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
| `403 91403 Forbidden` | 应用未被该 base 授权（跨租户、未加协作者、版本未发布） | 见第 1、2 节 |
| `99991672` | 缺少所需权限范围 | 权限管理里补 scope 并重新发布版本 |
| `1254060 TextFieldConvFail` | 目标字段是文本却写数字 | 字段类型需与合同一致（`价格` 用数字、`月收货人数` 用文本） |
| `1254069 AttachFieldConvFail` | 附件字段写入非法 | 附件字段连空串都非法，必须整键删除 |

## 5. 参考：本环境的既有事实

- 应用 `cli_aa93e98aeef81cef` 属租户 `rcndesfqro3x`；凭据在 `E:/小红书/.env.local`。
- 该租户内可见：竞品 base `OWebbPUcBa7B8JseYLccQCy9nkf`（10 表）、
  应用自有 base `Hohobp2UDaq698sXAQSc6SRXn3f`（2 表，演练表曾建在此、用完已删）。
- 跨租户表的只读复检记录：4 次均 `403 91403`（见 MIGRATION-8 §8）。
