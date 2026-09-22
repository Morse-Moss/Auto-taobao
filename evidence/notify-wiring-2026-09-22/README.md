# 2026-09-22 告警接线：让「需要登录」真的叫到人

## 结论先行

`xws-sku-auth-preflight.mjs` 的告警链路**全建好了、只缺一根线**，这轮把那根线接上了，并且补上了
一个从前连告警都不产生的盲区。三条结论：

1. **默认就会叫人**。不给任何参数时，告警 JSON 会经 stdin 交给仓库里那条已经跑通的投递 CLI
   （`runtime/notify-feishu.mjs`），收据写进 `delivery.status`。接线前默认值是「不通知任何人」。
2. **「商品页不在位」现在也有告警**。这个失败发生在分类器**之前**，从前是直接 `throw` ——
   2026-09-20 那一期的 SKU 富化就是在这条路上静默卡住的。退出码语义没变（仍是 `STALLED` → exit 3）。
3. **`.cmd` 包装这条路是死的**（实测）。Node ≥18.20.2 起 `spawn('x.cmd', [], { shell: false })`
   **同步抛 EINVAL**，而文档一直把「.mjs 外面包一个 .cmd」当作兜底做法。

## 为什么做这个（根因链的原文）

| 出处 | 原文 |
| --- | --- |
| `docs/ops/WEEKLY-SUPERVISION-2026-09-13_2026-09-19.md:124` | 「…通知 `delivery.status = NOT_CONFIGURED`（第三跳 webhook 已取消）→ **卡点无人知晓，正是你说的「飞书未收到提醒」**」 |
| `docs/ops/LOGIN-STATE-MANAGEMENT.md:218`（改前） | 「保留；把 `--notify-command` 指向真实的 `notify-feishu.mjs`」——一条**待办**，没有执行者 |
| `evidence/sku-step6-2026-09-20/INDEX.md` | 正式预检返回 **STALLED（exit 3）**：`Product page target is unavailable: 921092099640` |

第三行是关键：那次的失败根本**没走到**分类器，所以即使把通知接上，那条路当时也不会响。
两个缺口必须一起补。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `runtime/xws-sku-auth-preflight.mjs` | ①`resolveNotifyTarget()`：唯一的「叫不叫人、叫谁」决策点（`--no-notify` > `--notify-command` > 内置默认）；②`notifyOperator()`：收 stdout 收据、按 CLI 报的状态下结论、`MUTED` 与 `FAILED` 分开；③读页阶段失败归入新状态 `PAGE_UNAVAILABLE` 并落告警；④`buildAuthStatus` 在没读到页面时把两个布尔写成 `null` 而不是 `false` |
| `runtime/notify-feishu-core.mjs` | `TITLE_BY_TYPE` 补齐 5 个预检能发出、却一直没有标题的 type，并导出供跨模块判据使用 |
| `runtime/xws-sku-auth-preflight.test.mjs` | 6 → 18 例；新增「默认出口指向真实文件」「静音压过覆盖口」「跨模块标题对齐」「页面不在位也落告警并去重」 |
| `skills/xws-sku-collection/SKILL.md` §2 | 把「需要运营自己传 `--notify-command`」改成「默认已接线」，并写明 `.cmd` 不能用 |
| `docs/ops/LOGIN-STATE-MANAGEMENT.md` | §4 状态词表补 `PAGE_UNAVAILABLE` 一行；§6 接线表那行标为已接线 |
| `docs/ops/UNATTENDED-AGENT-RUNTIME-PLAN.md` | 划掉已被证伪的 `.cmd` 建议，写明实测结论与现行做法 |
| `docs/ops/WEEKLY-FLOW-CURRENT-2026-09-20.md` | 修掉两处引用错位（「见 §九」→ §八）与一处悬空引用（§七 的「见 §八」→ §六） |

## 判据（离线）

命令：`node --test runtime/xws-sku-auth-preflight.test.mjs`
原始输出：`preflight-tests-18.txt` —— **18/18，0 红**。

其中 4 条是新加的守门：其中一条是**跨模块**的（预检能发出的每个 type，在投递侧都有一个人话标题）——
这正是本项目最常踩的「两端都在、中间没接，而且不报错」。

## 突变验证（证明判据真的会红）

脚本 `mutate-preflight-wiring.mjs`，原始输出 `mutate-preflight-wiring.output.txt`：

| 突变 | 结果 |
| --- | --- |
| 默认通知目标退回「不发」 | 红了 1 条，**点名**「不给 --notify-command 时，默认出口就是仓库里那条投递 CLI」 |
| 标题表删掉 `XWS_PAGE_UNAVAILABLE` | 红了 1 条，**点名**「预检能发出的每个 type 都要有人话标题」 |
| 「要叫人」名单删掉 `PAGE_UNAVAILABLE` | 红了 2 条，**点名**「商品页不在位也要落一条可通知的告警」 |
| —— | 还原后两份源码 sha256 与改前**逐字节一致**，重跑 0 红 |

## 真机排练（不只在内存里跑）

脚本 `rehearse-notify-wiring.mjs`，输出 `rehearse-notify-wiring.output.txt`；
四个子目录 `a-*`/`b-*`/`c-*` 是**真进程**产出的证据文件（真预检 CLI、真 CDP 假代理、真子进程投递）。

| 场景 | 怎么做到一条消息都不发 | 观察到的结果 |
| --- | --- | --- |
| A 默认出口 | 给投递子进程 `SYCM_FEISHU_PROFILE=bogus-on-purpose` ⇒ CLI 在读 profile 时**先于任何网络请求**退出 1 | 预检 exit 2；`delivery.status=FAILED`，`error` 里是 CLI 的原话 `Unknown Feishu profile: bogus-on-purpose…` ⇒ **证明告警 JSON 真的经 stdin 送到了 CLI** |
| B 显式静音 | `--no-notify` | `delivery.status=MUTED`，未起任何投递子进程 |
| C 页面不在位 | `--no-notify` + 假代理只返回**别的**商品页 | 告警 `type=XWS_PAGE_UNAVAILABLE`、`severity=HIGH`、reason 带原始报文；状态工件 `status=PAGE_UNAVAILABLE`、`page.pluginPresent=null`；预检 exit **3**（与改动前一致） |
| D 渲染 | 拿 A 产出的告警喂真投递 CLI 的 `--dry-run` | exit 0、零发送，渲染第一行 = `【需要处理】小旺神登录已失效`（不是 `XWS_LOGIN_REQUIRED`） |

**A 是这轮最重要的那条证据**：它证明「预检 → 投递 CLI」这段真跑得通，
而不是只证明了「两个文件各自没问题」。

## `.cmd` 那条路为什么是死的（独立实测）

`probe-cmd-spawn.mjs` / `probe-cmd-spawn.output.txt`：

```
spawn('wrapper.cmd', [], { shell: false })  →  同步抛 Error: spawn EINVAL (errno -4071)
```

Node ≥18.20.2（CVE-2024-27980 加固）之后 `.cmd`/`.bat` 必须走 shell 才能起。
所以：`--notify-command` 现在收 `.mjs`/`.js` 并自动用 `node` 跑；其它形状按真可执行文件 spawn。

## 回归

| 跑的是哪一档 | 文件数 | 用例 | 结果 | 原始输出 |
| --- | --- | --- | --- | --- |
| `node scripts/run-test-suite.mjs unit --concurrency=1` → `unit:skills` | 57 | 786 | **786 pass / 0 fail**（1240 s） | `unit-full-2026-09-22.txt` |
| 同上 → `unit:runtime` | 91 | 819 | **819 pass / 0 fail**（9.1 s） | 同上 |
| `node --test runtime/xws-sku-auth-preflight.test.mjs`（最后一次注释改动**之后**重跑） | 1 | 18 | **18 pass / 0 fail** | `preflight-tests-after-final-edit.txt` |
| `runtime/sop-runtime`（**套件运行器不递归，必须单跑**） | 27 | 398 | **398 pass / 0 fail** | `sop-runtime-tests.txt` |

整轮 `unit` 退出码 **0**（1605 用例，0 红）。

口径提醒（免得把增长记到这次头上）：`runtime` 那一半在 2026-09-21 的记录里是 794 例
（`evidence/full-automation-fixes-2026-09-21/unit-2026-09-21-c.txt`），今天 819 ——
其中**本次新增的是 8 例**（预检文件 10 → 18），余下的是这两天别的改动带进来的。
`skills` 那一半 786 与 2026-09-21 晚的记录一致，没有增减。

上一节里 `18/18` 的那份输出 `preflight-tests-18.txt` 跑在最后一次**注释**改动之前；
那条改动只动注释、不改行为，但为了「绿灯要说清跑在哪个版本之后」，改动后又整份重跑了一遍，
即上表第 3 行。

## 边界：这轮**没有**验证的

- ~~**没有真的往飞书发过一条告警**~~ ← **同日晚已补上，见本文最后一节。**
  写这一段时的状态是：投递能力本身 2026-09-15 已实测过（两跳真实收据
  `evidence/notify-channel-check-20260915.receipt.json` / `…-group-20260915…`），
  这轮新接的是「预检 → 投递 CLI」那一段，用真子进程 + 可控失败证明了它通。
  原文保留，作为「哪些结论是排练推出来的、哪些是后来真发出来的」的分界。
- **没启停任何进程**：浏览器与代理只做过只读探测（`/json/list`、`/targets`）。
- **没碰服务端状态**：整轮零飞书写入、零 DB 写入。
- **`evaluateTarget` 失败也归入了 `PAGE_UNAVAILABLE`**（代理读不到页面）。这是一个有意的取舍：
  它属于「需要人去看现场」，而不是「代码未覆盖」；但如果将来这里出现真缺陷，
  它会以「原因」那行里的原始报文形态出现，而不是以 `BUG` 分类出现。
- 另一条相关但未处理的路径：`SOURCE_MISMATCH` 按既有口径**不通知**（属流程参数问题）。
  本文件不打算改这条口径。
- 本轮**没跑** `integration` 档（那两个文件需要活浏览器/真实剪贴板/DB，与本改动无关）。
- 一条**没修**的潜在口径缺口，已用注释钉在代码里：新的 `MUTED` 收据值**不在**
  `runtime/sop-runtime/round-history.mjs` 的 `undelivered` 名单里（那张表只数 `FAILED` / `NOT_CONFIGURED`）。
  今天到不了那里（轮次链有自己的投递实现，`notifyOperator` 只服务本文件），
  但如果将来把这里的收据并进轮次账本，「静音」会被那张表静默漏掉 ——
  同族事故本项目已经发生过两次（失败分类的词表与 DB CHECK 漂移，见 006/008）。

## 下一步（需要人点头的那一步）

~~真发一条验证性告警到飞书~~ —— **已做，见下一节。**

---

## 2026-09-22 晚：端到端真发 + 独立回读（补上上面那条边界）

触发时机的现场是真实的，不是造出来的：买家浏览器（9222）**只开着「我的淘宝」，没有任何商品页**，
所以真实预检必然命中 `PAGE_UNAVAILABLE` —— 也就是本轮新加的那条路。

### 逐次留证

| 文件 | 是什么 |
| --- | --- |
| `e-preview.txt` | **零风险预览**：`--no-notify` 跑真实预检拿到真告警 JSON（`delivery=MUTED`），再喂给 `notify-feishu.mjs --dry-run` 渲染出「真要发出去的那段字」 |
| `e-live-send.txt` / `e-live-send/xws-sku-operator-alert.json` | **第 1 次真发**：`delivery = SENT / channel app / sentAt`。这一步仍走默认出口，零参数干预 |
| `e-live-send-2.txt` / `e-live-send-2/xws-sku-operator-alert.json` | **第 2 次真发**：修掉下面的 `messageId` 缺口之后重跑，收据里带上 `om_x100b642b4db654a0b39a71cb2214d62` |
| `e-live-send-readback.txt` | 一次**失败**的回读尝试（如实留证）：`GET /im/v1/chats` 只列得出群，**列不出 P2P 单聊**，所以没有 messageId 时够不到那条消息 |
| `message-readback-probe.txt` | 用 2026-09-15 那张老收据里的 messageId 打通读回：`GET /im/v1/messages/{id}` → `code=0` 且读回完整正文。**这条路是通的** |
| `mutation-round2.txt` | 6 个突变点（含本轮新增的 3 条），全部被点名拦住，还原 sha256 逐字节一致 |
| `preflight-tests-19.txt` / `preflight-tests-20.txt` | 用例数 18 → 19 → 20 的原始输出 |

### 这一轮修掉的两个真缺陷（都是「真发」才暴露出来的）

1. **动作文案里的 Markdown 加粗会原样发给运营**。`ALERT_BY_STATUS.PAGE_UNAVAILABLE` 的 `action` 里
   写了 `**买家**` —— 那是按 Markdown 面写的，但这条通道发的是飞书 `msg_type=text` 的**纯文本**，
   星号不会被渲染，运营会看到字面上的 `**买家**`。预览时一眼看见，已改。
   配套判据：「给运营看的告警是纯文本」遍历所有状态跑 `buildOperatorAlert → renderAlertText` 再断言
   （不断言常量表，因为标题来自另一张表、正文还拼了 reason/source/时间/编号）。
2. **收据把平台回执号一起剥掉了，导致收据无法独立复验**。`compactReceipt` 原来只留
   `status/channel/alertId/sentAt/error`；`messageId` 长在 `attempts[]` 里，而那一项同时带收件人
   `target`，于是「剥掉收件人」把「平台回执号」连坐剥了。后果很具体：事后想确认「这条到底发出去没有」，
   手上没有任何能拿去 `GET /im/v1/messages/{message_id}` 的凭据，只能选择相信这份收据自己写的 `SENT`。
   已改为**留 `messageId`、仍不留 `target`**，并加一条用例同时钉住两个方向
   （留回执号 + 不许把 `ou_…`/`oc_…` 抄进证据文件）。
   本次实发因此**发了两次**：第 1 次是修复前的代码（收据无回执号），第 2 次带上了回执号并当即可回读。

### 真发那一条的完整闭环

```
预检(真实 HTTP 到 3457) → PAGE_UNAVAILABLE → 默认出口 notify-feishu.mjs
  → SENT / app / sentAt=2026-09-22T03:04:23.337Z / messageId=om_x100b642b4db654a0b39a71cb2214d62
  → GET /open-apis/im/v1/messages/om_x100b642b4db654a0b39a71cb2214d62 → http=200 code=0 msg_type=text
  → 读回来的正文与本轮渲染逐字一致（标题是人话「采集用的商品页不在位」，且没有星号）
```

**「发出去了」这件事现在由平台自己作证，不用相信我们自己的收据。**

### 这一轮**没有**做的

- 没给 `PAGE_UNAVAILABLE` 之外的其它 type 也做一次真发。已发的都是 `XWS_PAGE_UNAVAILABLE`。
- 没做 P2P 单聊的机器可读回读（平台不给列 P2P 会话）；目前的回读按 `message_id` 直取，够用。
- `MUTED` 仍不在 `round-history.mjs` 的 `undelivered` 名单里（同上，未修，已用注释钉住）。
- 「纯文本」这条判据只覆盖了 `ALERT_BY_STATUS` 这一条渲染路径；仓库里其它自己拼告警文案的链
  （如 `sop-runtime` 的升级文案）**没有**被它保护。今天全仓 grep 没发现别处有 `**`，但那是快照，不是守卫。
