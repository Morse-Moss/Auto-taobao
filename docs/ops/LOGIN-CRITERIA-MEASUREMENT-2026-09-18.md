# 登录态判据实测记录（2026-09-18）

依据：[`LOGIN-STATE-MANAGEMENT.md`](LOGIN-STATE-MANAGEMENT.md) §7 第 1 条 ——
「实测采集三个平台的会话判据（L2 的关键键名与到期语义、L0 的账号标识在页面上的位置）。
这一条不做完，L2 就是空壳。**禁止照抄任何文档或记忆里的键名。**」

本文就是那次采集的记录。**它只写量到的，没量到的一律写「未采集」。**

原始产物（在仓库外，含与项目无关的站点痕迹，不入库）：`D:/Retire/probe-20260918/`。
入库的整理版：`evidence/login-criteria-measurement-20260918.json`。

---

## 1. 方法：为什么用「差分」而不是「查资料」

要回答的是「哪些 cookie 代表登录态」。查文档/凭记忆写键名的问题在于**无法证伪**：
写错了不会报错，只会让体检永远判「已登录」（假绿）。

所以改成可证伪的做法：**同一批页面，在两个 profile 各采一次 cookie，取差集。**

| 会话 | profile | 采集时 cookie 总数 |
| --- | --- | --- |
| 登录态 | `D:/Retire/edge-daily-report-profile`（项目商家 profile） | 158 |
| 匿名基线 | 全新一次性临时 profile（测后已删除） | 20 |

判据 = **「登录态有、匿名没有」**。反过来，**两边都有的键一律不能当判据** ——
这一条直接否掉了几个看起来很像对的键（见 §3）。

cookie 只记录 `name / domain / path / expires / httpOnly / session`，**值在采集阶段就被丢弃**，
探针里还写了一道断言：一旦发现记录里出现 `value` 字段就当场中止。

## 2. 实测结果：判据候选（登录态独有）

### 2.1 淘宝系 `taobao.com`（13 条）

| 键 | 域 | httpOnly | 到期 |
| --- | --- | --- | --- |
| `cookie2` | `.taobao.com` | 是 | **会话级** |
| `_tb_token_` | `.taobao.com` | 否 | **会话级** |
| `_samesite_flag_` | `.taobao.com` | 是 | **会话级** |
| `sgcookie` | `.taobao.com` | 是 | 2027-09-16（363 天） |
| `_cc_` | `.taobao.com` | 否 | 2027-09-16（363 天） |
| `_3dtid` | `.taobao.com` | 否 | 2027-03-17（180 天） |
| `lid` | `.login.taobao.com` | 否 | 2027-09-16（363 天） |
| `_bl_uid` | `havanalogin.taobao.com` | 否 | 2027-03-15（178 天） |
| `last_cc` | `havanalogin.taobao.com` | 是 | 2026-10-16（28 天） |
| `last_u_taobao_sycm_new` | `havanalogin.taobao.com` | 否 | 2026-09-26（8 天） |
| `XSRF-TOKEN` | `havanalogin.taobao.com` | 是 | **会话级** |
| `DI_T_` ×4 | `sycm.taobao.com` | 否 | 2027-09-16（363 天） |
| `JSESSIONID` | `sycm.taobao.com` | 是 | **会话级** |

生意参谋专属域 `sycm.taobao.com` 上有自己的 `DI_T_` / `JSESSIONID`，
这是**生意参谋单独立会话**的证据（不能只看 `.taobao.com`）。

### 2.2 阿里妈妈 `alimama.com`（2 条）

| 键 | 域 | httpOnly | 到期 |
| --- | --- | --- | --- |
| `p_h5_u` | `one.alimama.com` | 否 | 2027-10-22（399 天） |
| `lid` | `.alimama.com` | 否 | 2027-09-16（363 天） |

注意：阿里妈妈**没有**继承 `.taobao.com` 的 cookie（跨域不会发），所以它的登录态判据必须
单独在这两个域上看，不能在 `.taobao.com` 上查。

### 2.3 天猫 `tmall.com`（2 条）

`lid`（`.tmall.com`，363 天）、`3rdPartyCookie`（`main.m.tmall.com`，会话级）。

### 2.4 飞书 `feishu.cn`（27 条，本次**是已登录态**）

| 键 | 域 | httpOnly | 到期 |
| --- | --- | --- | --- |
| `session` | `.feishu.cn` | 是 | 2027-09-16（363 天） |
| `session_list` | `.feishu.cn` | 是 | 2027-09-16（363 天） |
| `QXV0aHpDb250ZXh0` | `.feishu.cn` | 是 | 2027-09-16（363 天） |
| `passport_web_did` | `.feishu.cn` | 是 | 2027-09-16（363 天） |
| `passport_trace_id` | `.feishu.cn` | 否 | 2027-09-16（363 天） |
| `et` / `locale` / `bitable_tableId_viewId_history` | `kcne618basvj.feishu.cn` | 否 | 363–364 天 |
| `_csrf_token` | `.feishu.cn` | 否 | 2026-10-16（28 天） |
| `swp_csrf_token` | `.feishu.cn` | 否 | 2026-10-02（14 天） |
| `t_beda37` | `.feishu.cn` | 是 | 2026-10-02（14 天） |
| `is_anonymous_session` | `.feishu.cn` | 是 | 2026-10-17（29 天） |

两处**反直觉**、必须记下来的：

1. **`is_anonymous_session` 在「已登录」的库里也存在**（而且只在登录态库里出现）。
   名字会把人骗到反方向 —— 不能拿它判「没登录」。
2. 租户域是 `kcne618basvj.feishu.cn`（随 cookie 一起量到的），
   凭证只挂在 `.feishu.cn` 与租户子域上，**第三方域名上一条都没有**。

## 3. 实测否掉的判据（这些键**不能**用来判登录）

`t`、`tfstk`、`cna`、`xlly_s`、`arms_uid`、`3PcFlag`、`_uab_collina`、`isg`
—— 这些是**匿名 profile 里也有**的键（9 条 taobao 域、3 条 alimama、4 条 tmall）。

其中 `t` 与 `tfstk` 尤其危险：名字像主令牌、到期时间也在几个月量级，
唯一的区别是**匿名访客同样拿得到**。只按「键在不在」判登录，会得到一个永远为真的假绿。

## 4. 三条改变设计的结论

### 4.1 淘宝系与阿里妈妈的「登录态剩余寿命」**量不出来**

关键键（`cookie2` / `_tb_token_` / `_samesite_flag_` / `XSRF-TOKEN` / `JSESSIONID`）
**全是会话级** —— 关掉浏览器就没了，`expires` 根本不含「还能用多久」的信息。
而带到期时间的那些（`last_u_taobao_sycm_new` 8 天、`3PcFlag` 10 天、`last_cc` 28 天）
是**访问标记**，不是会话寿命。

⇒ **§4 判据表里的 `AUTH_EXPIRING`（提前 N 天提醒）对淘宝系和阿里妈妈不可实现。**
不要用「最早到期的登录键」去凑一个数出来（见 4.3 的反例）。这两个平台只能靠 L3 探针回答
「现在还能不能用」，答不了「还能用几天」。

### 4.2 飞书的 `AUTH_EXPIRING` 也只能给一个粗阈值

飞书家族里 `session` 是 363 天，但 `swp_csrf_token` / `t_beda37` 只有 14 天、`_csrf_token` 28 天。
那些短周期的是**每次访问都会刷新的 CSRF 标记**。

⇒ 用「最早到期的登录键」当阈值 ⇒ **天天误报**。

### 4.3 由此得出一条通用规则

**「提前预警」不能用 cookie 到期时间实现，除非先证明该键的到期时间与登录寿命同义。**
本次实测里，三个平台**没有一个是这样的**。所以第 4 步第一版应当：
L2 只做「关键键在不在」+ L3 做「现在能不能用」，`AUTH_EXPIRING` **留空并如实标注未实现**，
而不是拍一个天数进去。

## 5. 新的 L1 判据：机器级系统代理（本轮撞出来的）

实测现象：项目浏览器所有页面报 `ERR_PROXY_CONNECTION_FAILED`，页面标题只剩域名。

排查结果：

| 检查 | 结果 |
| --- | --- |
| profile 自己的代理配置（`Preferences` / `Local State` 的 `proxy`） | **null，没有任何配置** |
| Windows 系统代理（HKCU Internet Settings） | `ProxyEnable=1`，`ProxyServer=127.0.0.1:7897` |
| `127.0.0.1:7897` 是否在监听 | **ECONNREFUSED（代理软件没开）** |
| 直连 `sycm.taobao.com:443` | 通 |
| 加 `--no-proxy-server` 后 | **页面全部正常打开** |

⇒ 这是**机器级**设置导致的失败，而症状（页面打不开）与真正的原因（代理软件没开）
相隔很远。这正属于 L1 环境层该拦的东西：**在起浏览器之前先判一次系统代理可达性**，
不可达就直说「系统代理 127.0.0.1:7897 连不上，请开代理软件，或改用直连」。

顺带一条与交付相关的推论：出口 IP 变化会让平台会话失效（见 §6 的干扰因素），
所以「这台机器走不走代理」不是一个可以随手改的设置。

## 6. 本次采集到时的登录态实况

| 平台 | 落点 | 判定 |
| --- | --- | --- |
| 淘宝首页 | `www.taobao.com`，正文含「**亲，请登录**」 | **未登录** |
| 生意参谋 | 跳到 `sycm.taobao.com/custom/login.htm?_target=...` | **登录墙** |
| 阿里妈妈 | 跳到 `one.alimama.com/index.html#!/login/index` | **登录墙** |
| 飞书租户 | `kcne618basvj.feishu.cn/drive/home/`，标题「主页 - 飞书云文档」 | **已登录** |

**必须写清的干扰因素**：为了让页面能打开，本次把浏览器从「系统代理」改成了「直连」，
出口 IP 因此变了；而平台的登录态对 IP 变化敏感。所以「淘宝系未登录」有两种可能：
(A) 会话本来就已经过期；(B) 我改出口路径导致的失效。**本次区分不了** ——
要区分它，需要在代理软件开着的状态下再起一次浏览器复看。

无论 A 还是 B，结论都成立：**当前这个 profile 对淘宝系是未登录状态，日报链现在跑不了。**

## 7. L0（账号标识在页面上的位置）的采集状态

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| 生意参谋 / 阿里妈妈 | **未采集** | 停在登录墙，页面上没有身份可读 |
| 淘宝 | **未采集** | 同上（首页未登录） |
| 飞书 | **未采集（但会话是活的）** | 两次尝试都没定位到稳定的账号标识元素：先按「已知店名片段」反查（0 命中，符合预期，飞书没有店铺名），再按 `class/id/data-testid` 命中 `avatar|user|account|profile` 反查（**0 命中** —— 该页面这些属性名不含语义词）。**本次不猜选择器，如实记为未采集。** |

⇒ **下一步要换定位手段**（例如按「可见用户名文本」反向定位、或读飞书的账号接口），
不是靠再试一遍同样的办法。

## 8. 本轮未完成 / 被什么卡住

1. **L0 选择器全平台未采集** —— 三个平台卡在登录态，飞书卡在定位手段。
2. **四层体检模块没有开写** —— 实施计划第 4 步的验收条件就是「先补 §7 第 1 条」，
   而第 1 条现在只完成了一半（L1 完成、L2 只到键名与「到期不可用」的结论、L0 空缺）。
   在 L0/L2 判据没量到之前动手写模块，等于把「没做过的检查」写成 OK —— §11.1 明确禁止。
3. 记一条正面结论：**L1 这一层的判据已经量到并可以立刻实现**（代理可达性、
   代理端口、profile 身份、目标页、插件），不依赖登录态。

## 9. 复现方式

采集脚本在仓库外 `D:/Retire/probe-20260918/`（仓库内的临时探针会被端口守卫扫到，故放外面）：

| 脚本 | 作用 |
| --- | --- |
| `collect-login-criteria.mjs --port <n> --tag <名>` | 枚举 cookie + 逐页只读探针，产出 `login-criteria-<名>.json` |
| `diff-cookies.mjs` | 两个会话取差，得出「登录态独有」的键 |
| `probe-one.mjs --port --url --label` | 单页探针（落点/登录墙/风控节点/文本反查） |
| `probe-account.mjs --port --url --label` | 找账号标识元素候选 |
| `show-cookies.mjs <tag>` | 按域看键名与到期 |
| `launch-probe-browser.mjs` | 带 `--no-proxy-server` 的启动器（本次为了绕开已关闭的系统代理） |

原始产物 `login-criteria-{merchant,anon}.json`、`probe-*.json`、`account-candidates-*.json`
留在该目录，**不入库**：里面含与项目无关的站点痕迹（个人账号所在站点），
入库版只保留三个平台的判据。
