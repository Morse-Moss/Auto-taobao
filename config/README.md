# 客户配置

这一份 JSON 是给「换机器 / 换租户」用的：把原先**必须改代码**的两件事收进来 ——
飞书凭据文件路径，以及飞书 base / 表 id。

## 怎么用

```powershell
copy config\customer.example.json config\customer.json
notepad config\customer.json
```

改完就生效，**不用改任何代码**。配置在进程启动时解析一次；常驻进程要立刻生效，
调一次 `resetCustomerConfigCache()`（见 `runtime/feishu-targets.mjs`），或重启。

- **没有 `config/customer.json` 时**，全部走内置登记表（`runtime/feishu-targets.mjs` 的
  `PROFILES`）。这是开发机的正常状态，不是错误。
- **文件在、但写坏了**（JSON 语法错、字段拼错、类型不符）⇒ **直接报错，不会退回内置值**。
  理由：把「配置写错了」变成「配置没生效但没人知道」，是比报错坏得多的结果。
- 换一个位置放配置：设环境变量 `SYCM_CUSTOMER_CONFIG`（相对路径按**仓库根**解析）。
- `config/customer.json` **不进版本库**（`.gitignore` 已排除）。它是部署产物，
  跟 `.env` 同类：跟着客户机器走，不跟着 git 走。模板 `customer.example.json` 才提交。

## 字段

`feishu.<profile>` 下的键就是内置 profile 的键；**写成不在表里的名字会报错**（防拼错静默失效）。

| 字段 | 含义 | 改它的场景 |
| --- | --- | --- |
| `label` | 人读的租户名 | 换租户时 |
| `host` | 租户域名，如 `xxx.feishu.cn` | 换租户时 |
| `envFile` | 存 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 的文件**绝对路径** | **换机器必改**（原值是本机 `E:` 盘路径） |
| `competitorBase` | 竞品 base token | 换租户时 |
| `keywordBase` | 关键词库 base token（**另一张独立 base**，不能与竞品 base 混用） | 换租户时 |
| `writeVerified` | 是否**已在该 base 上实测过**写权限 | 换 base 后先置 `false`，实测通过再置 `true` |
| `tables.*` | 四张稳定表的 id（`competitorMain` / `skuDetail` / `history` / `questionMaster`） | 换租户时 |
| `dailyReport.*` | 日报底单 / 询单表的 base 与表 id | 换租户时 |

四条纪律（都是踩过的坑）：

1. **`writeVerified` 不能沿用旧 base 的结论。** 换 base 必须重新跑一次幂等写探针
   （把某个已有字段写成它当前的值），拿到 HTTP 200 / code 0 才算数。
2. **`tables` 四张表要齐全。** 只有这四张是「稳定表」；周表（竞品周 / SKU 周 / 问题库）
   每周新建、id 天然过期，按名字在运行时解析，**不在这里配**。
3. **`competitorBase` 与 `keywordBase` 是两张 base。** 复制竞品 base 不会带上关键词库。
4. **租户域名与 base 要同源。** `host` 与 `*Base` 来自不同租户时，读表会 403 或读到别人的表。

## 不在这里的东西

**浏览器 profile 目录与 Edge 可执行文件路径**用环境变量配，不放这份 JSON：

```powershell
$env:PROJECT_BROWSER_PROFILE = "D:/somewhere/edge-debug-profile"   # 甲（买家链）
$env:PROJECT_BROWSER_EXE     = "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
```

默认值是 x86 的 Edge 路径，**64 位机器一定要给 `PROJECT_BROWSER_EXE`**（否则浏览器起不来）。
两条链各起一次，乙（`start-daily-report-browser.mjs`）会自动带上 `dailyReport` 的默认值。
