# 第五家「盖文天猫」的专用浏览器（2026-09-19）

## 为什么要有这一份

用户 2026-09-19 原话：「盖文旗舰店，和盖文全卫定制是两家店……全卫就是盖文淘宝，另一个是天猫，
这样懂了吗，**没有专用浏览器就新增一个**」。

背景是：盖文天猫这家店的数据**一直有人在采**（09-14/15/16 的日报就是它），
但那几天用的是唯一那台商家浏览器（19022）登着它的商家号；那台一旦登成别家店，它就采不到了。
店里五家的口径因此长期缺一角：四家有隔离实例，第五家只能靠「商家浏览器当时登的是谁」撞运气。

## 做了什么（四处改动 + 起实例）

1. `runtime/browser-ports.mjs`：`SHOP_BROWSERS` 加一行 `盖文天猫`
   —— profile `D:/Retire/edge-profiles/gaiwen-flagship`、调试端口 **19035**、代理端口 **19045**、
   自己的 `browserId`/`label`（`/health` 里认得出是哪一家）。
2. `skills/sycm-alimama-daily-report/scripts/shop-identities.mjs`：`ISOLATED_PROFILES` 加同名键。
   两处漂移由 `runtime/browser-ports.test.mjs` 的逐键交叉核对守着。
3. `runtime/start-project-browser.mjs`：argv 改由登记表的纯函数 `buildBrowserLaunchArgs` 拼；
   新增「店铺 profile 卫生开关」`SHOP_BROWSER_EXTRA_ARGS = ['--disable-sync']`
   （配方出处：`docs/ops/MULTI-SHOP-AND-INTERACTION-DECISION.md` §5.3.1 —— 不带这个开关，
   新建 profile 会把个人密码库连同别家店凭据一起同步进来，实测 47 条）。
   **两个老浏览器（competitor / dailyReport）的 argv 逐字不变**，这条由判据钉住。
4. 起实例：浏览器（19035）+ 它自己的代理（19045，`node runtime/start-shop-proxy.mjs gaiwen-flagship`）、
   挂店名标签页（标题 `盖文天猫 · 日报采集窗口`，pinned）、开出两个工作页。

## 现场状态（截至本证据落盘）

- 两个工作页**都停在登录页**：`sycm.taobao.com/custom/login.htm?_target=…` 与
  `one.alimama.com/index.html#!/login/index` ⇒ **这家店的账号还没登**，采集还没跑。
- profile 卫生实测：`Preferences.sync.passwords = null`、`Login Data` 的 `logins` **0 条**
  （无个人密码库、无别家店凭据）。注意 `account_info` 里仍有微软账号（Edge 会自动登录微软账号，
  带不带 `--disable-sync` 都一样 —— 与 §5.3.1 的 B 组实测一致；**有效的是密码不同步**）。
- 身份登记表里这一家仍是 `sycmHeaderVerified: 'text'` / `alimamaVerified: 'human-record'`
  （2026-09-17 从生产窗口读到 + 人工抄），**还没走过采集脚本那两个表达式**。

## 判据与验证

| 项 | 结果 | 证据文件 |
| --- | --- | --- |
| runtime 段 | **644 / 644**（基线 643，+1 即新判据） | `07-runtime-suite.txt` |
| 日报技能段 | 151 / 151 | `08-skills-suite.txt` |
| 突变 | **3 / 3 红且点名，还原后 sha256 逐字一致** | `06-mutation.txt` |
| 端口/身份盘点 | 五台店浏览器 + 五个代理都在，19035/19045 是本轮新起的 | `01-inventory.txt` |
| 页签构成 | 新窗口：标签页（pinned）+ 两页登录页 + 空白页 | `02-tabs.txt` |
| profile 卫生 | `sync.passwords=null`、`logins=0` | `03-hygiene.txt`、`04-logindata-count.txt` |

突变三条（都是「这条判据真的能被打坏吗」）：M1 把 `--disable-sync` 从登记表删掉 ⇒ 红在
「店铺 profile 没带 --disable-sync」；M2 让 `extraArgsForProfile` 忘记按 profile 匹配 ⇒
红在「认不出的目录不该加开关」；M3 把开关排到 `startUrl` 之后 ⇒ 红在「开关必须在 URL 之前」。

## 还没做的（如实写在这里，别当已完成）

1. **这家店的账号还没登录** —— 需要人在那台窗口（标题「盖文天猫 · 日报采集窗口」）登一次
   商家号；登录后由浏览器自己的密码库接管自动填充（本链不接触明文）。
2. 登录后要把两侧身份用采集脚本那两个表达式各读一次，把登记表升级到 `expression`，
   并把 `shop-identities.test.mjs` 里那张「谁还没验到表达式级」的清单从 `['盖文天猫']` 清空。
3. 09-18 那一行的 `询单量/同层同行询单量` 现在还是空的 —— 采集跑完才有。

## 重起这两个进程

```
PROJECT_BROWSER_PORT=19035 PROJECT_BROWSER_PROFILE=D:/Retire/edge-profiles/gaiwen-flagship \
  node runtime/start-project-browser.mjs          # 会打印「额外开关：--disable-sync」
node runtime/start-shop-proxy.mjs gaiwen-flagship # 一家店一个代理进程
```

## 2026-09-19 下午更新（本文件上面「还没做」三条已全部做完）

用户当天 13:40 回「登录了」⇒ 三件事当天做完，证据在别处（本目录只保留「建实例」那一轮的现场）：

1. 两侧身份用采集脚本那两个表达式各读一次 ⇒ 登记表升 `expression`（提交 `eadad75`）；
2. 09-18 那一家补采完成（底单 1883→1884、询单 12/35）——`evidence/multi-shop-2026-09-18/00-README.md`（提交 `13400a1`）；
3. 独立回读 + 提交前后逐行 diff + 审计表第 39/40 行，证明没串店（同上）。

⇒ 上面第 27 行的「两个工作页都停在登录页」与第 54-58 行的「还没做」是**当时**的事实，
现在以 `evidence/multi-shop-2026-09-18/` 为准。
