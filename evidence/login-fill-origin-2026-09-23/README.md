# 「有保存密码为什么不自动登录」＋「登录不了为什么不发飞书」——取证（2026-09-23）

用户当日原话：

> 「我看到都有保存登录信息，为什么你不直接登录？如果登录不了，为什么没有飞书提醒？」

这份目录回答这两问，并留下可复核的原始输出。**所有结论都来自下面的文件，没有一条是推断。**

## 1. 为什么不是「有保存就能登」

自动登录（`skills/sycm-alimama-daily-report/scripts/login-merchant.mjs`）靠**浏览器自己的密码管理器**给表单做填充，
而 Chromium 的填充判据是「保存凭据的 `origin_url` == 当前登录页的 origin」。
脚本固定打开的那一页是 `TAOBAO_LOGIN_URL`（`login-merchant-core.mjs:5`）：

    https://login.taobao.com/havanaone/login/login.htm?bizName=taobao   ⇒ origin = https://login.taobao.com

复核命令：

    node evidence/login-fill-origin-2026-09-23/audit-login-data-all-profiles.mjs

原始输出：`login-data-all-profiles.txt`（只读、不打印任何明文账号密码，只取 origin 与两列长度）。
实测（2026-09-23 14:3x，浏览器都在运行中）：

| 实例 | `login.taobao.com` 下有凭据吗 | 结论 |
| --- | --- | --- |
| 里可林淘宝 | 有（`/havanaone/login/login.htm`） | 能填 |
| 网林天猫 | 有（`/havanaone/login/login.htm`） | 能填 |
| 盖文淘宝 | 有（`/member/login.jhtml`，同 origin） | 能填 |
| **盖文天猫** | **没有**（只有 `havanalogin.taobao.com/mini_login.htm` 一条） | **填不上** |
| 科塔淘宝 | 有（`/havanaone/login/login.htm`） | 能填 |
| 商家浏览器（日报链） | 有（`/member/login.jhtml` 用过 10 次） | 能填 |

⇒ 「密码管理器里看得见那条记录」与「脚本打开的那一页会被填上」是两件事。
盖文天猫看见的那条存的是 `havanalogin.taobao.com/mini_login.htm` 这个 origin，脚本那一页用不上它。

## 2. 为什么这次「没有直接登」（这是行为，不是失败）

我这一次跑的是**只读档**（`check-login-shops.mjs` 不带 `--login`）：
它的子进程走 `login-merchant.mjs --check-only`，**连登录页都不开**（`check-login-shops.mjs:20-27`）。
它为此专门有一个结论词 `NEEDS_LOGIN`（`login-merchant-core.mjs:36-43`）—— 语义就是
「要去登一次，但这一档不许我碰页面」。

带 `--login` 才是「查 + 掉了就自己登一次」（2026-09-23 按用户明确授权加的）。
本次**已按授权真跑一轮**，原始回执：`auto-login-shops.txt`（五家店）、`auto-login-daily-browser.txt`（商家浏览器）。

真跑结果（2026-09-23 14:38–14:41）：

| 实例 | 结果 |
| --- | --- |
| 里可林淘宝 / 科塔淘宝 | 本来就在登录态 |
| **盖文淘宝** | **自动登录成功**（`在登录态`） |
| 网林天猫 | `LOGIN_NOT_CONFIRMED` —— 填上了、提交了、页面还停在登录页 |
| 盖文天猫 | `NO_SAVED_CREDENTIAL` —— 上面第 1 节那条 origin 不匹配 |
| 商家浏览器 | `LOGIN_NOT_CONFIRMED`（截图 `shots-daily/login-after-submit.png`） |

## 3. 附带抓到的一件事（需要人拍板）

商家浏览器（`D:/Retire/edge-daily-report-profile`）的登录页上，被自动填充进去的账号是
**里可林家居:阿彦**，而不是 `docs/ops/LOGIN-STATE-MANAGEMENT.md:382` 与
`docs/ops/DAILY-REPORT-RUN-2026-09-17-FINDINGS.md:264` 记的 **盖文旗舰店**。
读法（只读 DOM，不读密码框的值）：

    node evidence/login-fill-origin-2026-09-23/probe-read-login-id.mjs 19023 havanaone
    node evidence/login-fill-origin-2026-09-23/probe-read-login-id.mjs 19042 havanaone

值取自 `document.querySelector('#fm-login-id').value`（只读，不点、不导航）。

⇒ 这个 profile 的密码库里躺的是**另一家店**的凭据。人工登它之前先定夺：这台该登哪家店
（文档说盖文旗舰店；现库里是里可林）。定错了，日报链的推送/回读段会以错的身份跑。

## 4. 为什么没有飞书提醒

| 层 | 会不会发飞书 | 依据 |
| --- | --- | --- |
| `check-login-shops.mjs`（本次跑的这一步） | **不发**（两种模式都写死 `--notify off`） | `check-login-shops.mjs:80-84`：同一次故障只由「链失败那一条」报，避免群里两条重复、且第二条说不出链停在哪 |
| `login-merchant.mjs`（会渲染告警文案） | 本次用 `--notify dry` ⇒ 只渲染不投递 | `auto-login-daily-browser.txt` 里那段 `"status": "DRY_RUN"` 的 `text` **就是真会发出去的那段话** |
| 定时链（`scripts/run-daily-job.mjs --notify`） | **会**：跑前自动登 → 没成 → 链照样跑 → 链失败 → 发飞书，文案点名「哪个店哪个后台掉登录」 | `runtime/daily-job-plan.mjs:243-262` ＋ 定时任务实际入参（`sycm 日报定时`，`automation a11daa89`） |

所以本次群里安静的直接原因是：**只跑了体检那一步，没跑链**。
而体检那一层是**刻意**不发告警的。

两点未能证实、不许当成已成立的事（待确认）：

1. 仓库里**没有 `evidence/daily-job-*` 产物目录** ⇒ 这条定时链「跑过并按新接法发出过告警」
   这件事，我没有证据。代码上成立 ≠ 真跑验证过。
2. 定时任务的排期字段是 `BYHOUR=8;BYMINUTE=14`，与它的名字「每日 11:40」不一致
   （时区口径待确认）。排期错＝到点不跑＝永远不会有告警。

## 5. 还没做的

- 网林天猫 / 盖文天猫 / 商家浏览器的人工登录（登录后勾「保存密码」）。
- 「跑前自动登录失败 ⇒ 直接发一条飞书」这个接线**没改**（属行为变更，等拍板）。
