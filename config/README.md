# 客户配置

这一份 JSON 是给「换机器 / 换租户」用的：把原先**必须改代码**的事情收进来 ——
飞书凭据文件路径、飞书 base / 表 id，以及多店铺的跨平台店名映射。

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

### `stores[]` —— 多店铺的跨平台店名映射

**它不是店铺清单的真相源。** 口径是「飞书多维表有多少店铺就有多少」：清单来自飞书，
这里只回答「同一家店，在三个地方分别叫什么、用哪个内部 id」。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | 内部标识，如 `bathtub-flagship`。**只能小写字母/数字/短横线**——它会进业务幂等键 |
| `feishuName` | 是 | 飞书表里的店铺名称（就是查重键里的那个「店铺」） |
| `sycmDisplay` | 否 | 生意参谋里的显示名（实测形如「盖文旗舰店 主店」） |
| `alimamaDisplay` | 否 | 阿里妈妈里的显示名（实测形如「盖文旗舰店:阿彦 ID 2995200080」） |
| `profileDir` | 否 | 该店专用的浏览器 profile 目录（多店铺时**每店一个**，同一 profile 不能开两个实例） |
| `credentialRef` | 否 | 该店凭据的存放位置标识（**不放明文密码**，见下方纪律 5） |

为什么需要它：日报的查重键是「同一天 + 同店铺」，而「店铺」是个字符串，它在两个平台上显示得并不一样。
没有这张对照表，多家店迟早会写成多个不同的名字，或者两家撞成同一行。**重名会被直接拒绝**
（`feishuName` 重复＝两家的数据会撞进同一行）。

**诚实标注：这一段目前没有读方。** 按店铺拆排期的生成器还没做，所以此刻它只被校验、不被使用。
现在只有一家店、映射表只有一行；等多家店都跑起来再补，就得逐店去三处比对显示名。

### `feishu.<profile>` —— 飞书租户与表

键就是内置 profile 的键；**写成不在表里的名字会报错**（防拼错静默失效）。

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

第 5 条（`stores` 专属）：

5. **这一份配置里不许出现任何明文凭据。** `credentialRef` 只是「凭据放在哪」的**标识**
   （Windows 凭据管理器的目标名、或某个只读环境变量名），不是密码本身。
   原因很实际：`config/customer.json` 跟着机器走、会被复制、会被人用记事本打开看，
   而它同时又是要交付给客户的东西——它不承担保管秘密的职责。

## 不在这里的东西

**浏览器 profile 目录与 Edge 可执行文件路径**用环境变量配，不放这份 JSON：

```powershell
$env:PROJECT_BROWSER_PROFILE = "D:/somewhere/edge-debug-profile"   # 甲（买家链）
$env:PROJECT_BROWSER_EXE     = "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
```

默认值是 x86 的 Edge 路径，**64 位机器一定要给 `PROJECT_BROWSER_EXE`**（否则浏览器起不来）。
两条链各起一次，乙（`start-daily-report-browser.mjs`）会自动带上 `dailyReport` 的默认值。
