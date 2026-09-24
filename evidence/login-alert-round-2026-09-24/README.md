# 1.7.0 的证据：整轮登录告警的形状、真渲染器输出、只读真跑预检

本目录是 **1.7.0**（提交 `7e73b89`）改动的一手产物。它回答的问题：**改完之后，收信人到底会收到什么、
以及「接线真的接上了」有没有证据。**

起因：2026-09-24 08:14 那轮定时里，链 11/11 全绿、退出码 0、底单 5 行齐全，**预检却发了 5 条假红**
（`README` 不重复那段分析，见 `CHANGELOG.md` 的 `[1.7.0]` 与
`docs/ops/FULL-AUTOMATION-STATE-CONTRACT-2026-09-21.md` §十三）。

## 逐文件

| 文件 | 它是什么 | 证明了什么 | 怎么复现 |
|---|---|---|---|
| `affected-tests-1.7.0.txt` | 发版后跑的受影响用例原始输出 | **6 文件 155/155、fail 0、退出码 0** | 见下「复现命令 ①」 |
| `affected-tests-before-bump.txt` | 改完、发版前那一次（5 文件） | 149/149 —— 用来解释为什么有两个分母（发版那次多带上了版本号一致性守卫） | 少一个文件跑同样的命令 |
| `arch-boundary-RED-before-registering.txt` | 跨目录依赖守卫**先红**的原始输出（exit 1） | 新增依赖被守卫**真的抓到了**（`added: check-login-shops-core.mjs`），不是「恰好本来就绿」 | 把 `runtime/arch-boundary.test.mjs` 里那行登记删掉再跑 |
| `arch-boundary-GREEN-after.txt` | 登记后重跑 | **3/3 绿** | 见下「复现命令 ①」 |
| `guards-after-adding-this-dir.txt` | 把上面那条生成脚本（一个 `.mjs`）放进本目录**之后**再跑守卫 | 守卫**仍 9/9 绿** ⇒ `arch-boundary-scan` **不扫 `evidence/`**，在证据目录里放可跑脚本不会把它顶红（这条值得留证：下次想在 evidence 下放脚本时不用先猜） | 见下「复现命令 ③」 |
| `round-alert-input.json` | 构造出来的整轮告警（2 家店：里可林只掉阿里妈妈、盖文天猫两个都掉） | 编号是 `sycm-login-round-20260924`（**整轮共用一个锚**，去重的前提）、指纹是「哪几家+哪几个后台」 | `node evidence/login-alert-round-2026-09-24/gen-round-alert.mjs` |
| `gen-round-alert.mjs` | 上一条的生成脚本 | **从本目录原地可跑**（路径按自身位置算，不按 cwd）；跑出来的 JSON 与存档**逐字节相同**（sha256 `7cd7e29e…c3a4`） | 同上 |
| `round-alert-dry-run.json` | 同一条告警过**真渲染器** `runtime/notify-feishu.mjs --dry-run` 的输出 | ① 正文里 对象／店铺／任务／原因／下一步／时间／告警编号 七项齐全；② `source` 的键名都在白名单里（写错会被渲染器**静默丢掉**那一行）；③ 正文**不含机器名与本机路径**；④ `--dry-run` ⇒ **一个字节都没发** | 见下「复现命令 ②」 |
| `preflight-readonly.json` | **只读**真跑一次预检（不带 `--login`，一个页面都没碰）的 stdout | ① 五家 `notify.mode` 全是 `off`（子进程不再自己发飞书）；② `roundNotify.status = SKIPPED`（只读体检一个字都不发）；③ `normalize.asked = false`（不带 `--login` 就不碰页面）；④ 五家代理当时没起（`fetch failed`）⇒ 逐店 `UNREADABLE` 而 `needHuman = []` —— **读不到的时候不叫人**，这正是改之前做不到的 | `node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --json` |
| `preflight-readonly.stderr` | 同一次的 stderr | **0 字节** ⇒ stdout 是纯 JSON，宿主的 `--json` 落文件不会被打断 | 同上 |

## 复现命令

```bash
# ① 受影响用例（仓库根）
node --test runtime/alert-throttle.test.mjs \
  skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs \
  skills/sycm-alimama-daily-report/scripts/login-merchant-core.test.mjs \
  skills/sycm-alimama-daily-report/scripts/check-login-shops-core.test.mjs \
  runtime/arch-boundary.test.mjs runtime/version-consistency.test.mjs

# ② 整轮告警过真渲染器（只渲染，不投递）
node runtime/notify-feishu.mjs --dry-run \
  --alert-file evidence/login-alert-round-2026-09-24/round-alert-input.json
```

复跑 ② 的输出与存档 `round-alert-dry-run.json` **逐字节相同**（sha256 `28cb16b9…6b73`）。

```bash
# ③ 只跑两道守卫（证明「在 evidence/ 下放脚本」不会把跨目录守卫顶红）
node --test runtime/arch-boundary.test.mjs runtime/version-consistency.test.mjs
```

## 本目录**没有**覆盖的（缺口照实写，别把这份目录读成「全验过了」）

1. **`--login` 档的归位写路径没有真机证据**：本会话没有起实例的授权，没真跑。
   可依赖的间接证据是 `normalizePages` 这**同一份实现**已在链的第 0 步于 09-22／09-23／09-24
   三轮真跑里被考过；本版新增的只是「多一个调用点」。
2. **`PAGES_ABSENT` 没有真机现场复现**：需要先有「窗口里没有该站点页面」的现场（今天五家店代理没起，
   拿到的是 `UNREADABLE`，与页面不在同形但成因不同）。
3. 下一轮无人值守真跑（08:14）是这两处**第一次真机被考**。

## 一条工具坑（影响本目录脚本怎么写）

本机某些会话**禁止一切同步起子进程**：`spawnSync` / `execFileSync` 对 `node.exe`、系统 node、
`cmd.exe`、`where.exe` 全部 `EBUSY`（`status = null`、`stdout = undefined`），而**异步 `spawn` 正常**。
所以本目录的脚本**只写文件**，跑 CLI 的那一步交给**顶层命令**（上面的复现命令 ②）。
详见技能 `verified-edit-and-wiring-guard` §6。
