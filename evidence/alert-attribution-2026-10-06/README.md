# 证据：整轮被挡的告警归因（共用窗口掉登录 ≠ 页面不齐）（2026-10-06）

这一批修的是**告警指错方向**：整轮被挡时，链把「共用窗口掉登录」判成了「页面不齐」，
于是发给业务人员的动作是「把这两页各开一个」——而真因是那个共用窗口自己掉了登录，
补页是无效动作，人照着做完还会再失败一次。

现场：2026-10-06 15:34 那一轮（目标日 2026-10-05），8 家店**一家都没跑**，
两批都停在链的第 0 步 `health-check`。完整轮证据在 `evidence/daily-job-2026-10-05/`
与 `evidence/batches-2026-10-05/`（本机）。

## 真因是怎么读出来的（现场，不是推断）

`evidence/batches-2026-10-05/b1/00-health-check-daily.txt` 里，归位动作的 `from` 是：

```
https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop
```

这是一堵**登录墙**，不是「页面不在」。同一份产物里 `after` 两个页签计数是
`生意参谋工作页 0` / `飞书底单页 1` —— 那两个 0 是掉登录的**结果**，不是原因。
旧代码只看 `after` 的计数，于是把结果当成了原因。

## 改了什么（一个文件 ＋ 一张表）

1. `run-multi-shop-day.mjs` 新增纯函数 `roundCauseOf({ ok, normalize })`：
   体检不过时，**先看归位记录里有没有登录墙**（`isSycmLoginWallUrl`，复用登录模块已有的判据），
   有 ⇒ `ROUND_LOGIN_WALL`，没有 ⇒ 旧的 `ROUND_BLOCKED`。新增纯函数
   `roundMissingPagesOf(normalize)` 从 `after` 里取出「少了哪一页」，供文案指名道姓。
2. 体检那一步把这**两个结论落盘**（`summary.round.healthCheckDaily.roundCause` / `.missingPages`）——
   告警只是它一个读者，驻留那一步在**别的进程**里，只能读落盘的东西。
3. 告警文案分叉：`ROUND_LOGIN_WALL` 时不再说「问题不在登录上」、不再叫人补页，
   改成「登那**一个**共用窗口（就是开着飞书「各店铺日报」表格的那个）」，并明说
   「不用去各店自己的窗口里登」——指错窗口比不指更贵。
4. `remediation-table.mjs` 补登 `ROUND_LOGIN_WALL`（动作 `HUMAN`）。
   这张表的键必须与 `FAILURE_CAUSES` 逐字一致，**漏一条 = 那一类永远走兜底叫人**；
   补之前 `remediation-table.test.mjs` 是红的（就是它在拦这件事）。

**默认不变**：不传新字段的老 summary，重建出来与当时真发出去的那条**逐字相同**（见下）。

## 本目录有什么

| 文件 | 是什么 | 怎么复现（都在仓库根跑） |
| --- | --- | --- |
| `mutation-verify.mjs` | 突变验证脚本（3 条，把源码逐条改坏再还原） | `node evidence/alert-attribution-2026-10-06/mutation-verify.mjs` |
| `mutation-output.txt` | 上面那次的输出：**3/3 抓住**，每条点名到期望的用例，sha256 逐字节还原，最终复绿 | 同上 |
| `rebuild-alerts.mjs` | 用**真渲染器 + 本轮真实输入**重建两条告警（含「老 summary 必须逐字不变」的硬断言） | `node evidence/alert-attribution-2026-10-06/rebuild-alerts.mjs` |
| `rebuild-output.txt` | 上面那次的输出；其中「逐字一致：`true`」是默认不变那条纪律的判据 | 同上 |
| `suite-runtime.txt` | `runtime` 整包套件：**1076 条全过、0 失败、退出码 0** | `node scripts/run-test-suite.mjs runtime --concurrency=1` |
| `suite-skill-daily-report.txt` | 日报 skill 整包：**440 条全过、0 失败、退出码 0** | `node scripts/run-test-suite.mjs skills --skill=sycm-alimama-daily-report --concurrency=1` |

重建出来的成品文案落在 `evidence/daily-job-2026-10-05/ALERT-COPY-REBUILD.md`（那条轮证据旁边）。

定向组（引用该模块的全部测试文件，与上面两块重叠，264 条）：

```bash
node --test runtime/alert-throttle.test.mjs runtime/arch-boundary.test.mjs \
  runtime/daily-job-plan.test.mjs runtime/hold-and-resume-plan.test.mjs runtime/shop-pages.test.mjs \
  skills/sycm-alimama-daily-report/scripts/remediation-table.test.mjs \
  skills/sycm-alimama-daily-report/scripts/repair-actions.test.mjs \
  skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs
```

## 两个脚本的写法约束（都是踩过才知道的）

- **`stdio` 必须写 `['ignore','pipe','pipe']`**。写成 `'pipe'`（= 三根管道）会让 stdin 也成管道，
  本机沙箱下 `spawnSync` 必抛 `EBUSY` —— 后果是**测试根本没启动**，而 `catch` 把「没跑起来」
  当成「测试红了」，突变验证变成空转假绿（本次实测踩到：三条突变全报「红=true」而输出为空）。
  `mutation-verify.mjs` 因此把「红」重新定义成「TAP 汇总里真的出现 `# fail [1-9]`」，
  并把「输出里没有 `# tests`」单独判死。本仓 `run-multi-shop-day.test.mjs` 自己也有守卫在断言这条 stdio 形状。
- **`await import()` 在 Windows 上必须走 `pathToFileURL`**。直接给 `D:\...` 会报
  `ERR_UNSUPPORTED_ESM_URL_SCHEME` —— 而这两个脚本靠「自己向上找 `VERSION` 定根」来保证
  复制到别处也能跑，所以必须动态 import。漏了这一步，脚本在本目录**根本跑不起来**，
  而它偏偏是证据脚本（跑不起来 = 证据不存在）。本次实测踩到并修掉。
- 期望串要按**断言类型**选：node 对 `assert.match` 失败会把整段 `Input` 打出来（内容级串能被看见），
  对 `assert.equal` 只打消息 + `true !== false`（只有消息文本能被看见）。

## 这一批**没有**做到的（说清楚）

- **驻留等人登录仍然不会发生**。生产命令走 `--batches`，而分批形态下**没有** `hold` 那一步
  （`runtime/daily-job-plan.mjs` 的 `batchWithoutHold`，2026-09-26 起就是刻意的缺口）。
  所以本轮改的只是**文案指对方向**，人还是得自己发现、自己重跑 —— 告警里那句
  「告诉技术同学重跑一次」就是这件事的如实写照（`willResume` 没有被接上）。
  这是下一批（B 项）的范围。
- **登录那条告警仍然渲染「机器」与「浏览器配置」两行**（`login-merchant-core.mjs` 发的，
  `sycm-login-sycm-20261006`）。业务人员看这两行没有用，属于 C 项范围，本批未动（原件在
  `rebuild-output.txt` 第 4 节原样附上）。
- **共用窗口没有标识页**：`runtime/launch-plan.mjs` 只给**店铺实例**设 `PROJECT_BROWSER_URL`
  （标签页地址），共享的日报浏览器（19022/19023）冷启动落在 `https://sycm.taobao.com/`，
  窗口标题里也没有店铺名 —— 所以 C 项要让它有一个业务人员认得出的标识。本批未动。
- **没有在真机上跑过一轮**。「掉登录 ⇒ 告警说去登那个共用窗口」这条路径只有在真的掉登录时才被考到，
  上面全部是离线判据（真实输入重建 ＋ 突变验证），**证明不了**真机上会走到。
  第一次真跑的判据：`evidence/batches-<日>/batches.log` 里的轮级告警出现
  「那个共用窗口自己掉登录了」而不是「页面不齐」。
