# 修复 agent 报告 —— `evidence/batches-2026-09-28/b1/`

- 目标日：**2026-09-28**（生产轮 2026-09-29 18:58，`--date 2026-09-28 --batches 5 --notify --auto-repair`）
- 作业依据：`docs/ops/REPAIR-AGENT-HANDOFF.md`
- 交接给我的根因假设：**「`--auto-repair` 传下去的是对象而不是动作名字符串」**
- 我的结论：**该假设成立，但它不是 5 家全挂在 `backfill` 的原因 —— 它只是「修复层整条是死的」。我查到了第二个、严重得多的根因：`backfill` 这一版把询单量写进了错误的表/错误的行，而且因为找不到对应行而在 4 天上无一写入。修复动作一个字都没跑成，所以这轮没有造成新的写坏。**
- **我在动仓库代码前停手**（见 §6）。

---

## 1. 时间线与每步结论

| # | 命令 / 动作 | 回读到的结论 |
|---|---|---|
| 1 | `git log -1` → `74928ae docs(ops): 12 家店铺扩容分析…`；`git status --porcelain` → **121 个脏项** | 工作区有 121 个未提交改动，其中 `runtime/browser-ports.mjs` / `run-collection-host.mjs` / `skills/.../collect-promotion-report.mjs` / `readback-daily-report.mjs` 等**别的会话的在改文件**。`run-multi-shop-day.mjs` / `repair-shop-stage.mjs` / `repair-actions.mjs` **干净**。 |
| 2 | 读 `run-multi-shop-day.mjs:1203` | 确认 `const action = list[0];` 取的是**对象**（`list` 来自 `req.candidates`）。 |
| 3 | 读 `run-multi-shop-day.mjs:1207-1213` | 确认 `exec({... action})` 把对象原样传出。 |
| 4 | 读 `run-multi-shop-day.mjs` 的 `execRepair`（约 1504-1512） | 确认对象原样进 `applyRepairAction`。 |
| 5 | 读 `repair-actions.mjs:116-136` 的 `planRepair` | 确认候选形状是 `{action, mutating, why}` —— **对象数组**。 |
| 6 | 读 `run-multi-shop-day.mjs:295`（`buildRepairRequest`） | 确认 `candidates: plan.candidates` 原样写进请求单。 |
| 7 | 读 `repair-shop-stage.mjs:292`（`args.action !== 'RESET_PAGES'`）与 `320-324`（四路 `===` 比较） | 确认四处比较对对象**全部落空** —— `needsPage` 被误判成 true，于是去读页签。 |
| 8 | 读 `repair-shop-stage.mjs:113-120` 的 `readTargetUrls` | 确认 `proxyJson(\`${args.proxy}/targets\`)`；`args.proxy` 正常，但失败信息是 `Failed to parse URL from [object Object]/targets` —— 说明 `${base}` 里串进了对象，与 ①~⑦ 自洽。 |
| 9 | 读 `evidence/batches-2026-09-28/b1/summary.json` 的 5 家 `autoRepair` | **5 家全部同形**：`cause=STAGE_FAILED`、`rounds[0].action` = **编码后的对象**、`applied=false`、`detail="修复动作自己出错：Failed to parse URL from [object Object]/targets"`、`retry.attempted=false`、`gaveUp="用完 1 轮（候选还剩 [object Object]）"`。**交接的根因假设全部落实。** |
| 10 | 读 `evidence/batches-2026-09-28/b1/里可林淘宝/97-repair-request.json` | 候选确实是 `[{action:"REAPPLY_DATES",…},{action:"RELOAD_PAGE",…}]` —— 对象数组，与第 5 步一致。 |
| 11 | 读 `run-multi-shop-day.test.mjs:1422-1434` | 确认测试传的是 `candidates: ['DISMISS_OVERLAYS', 'RELOAD_PAGE']`（**字符串数组**）⇒ 函数级用例全绿而接线是断的。**交接的判断成立。** |
| 12 | `curl http://127.0.0.1:{19041..19045}/targets` + `netstat` | **五店的 1904x 代理端口一个都没在监听**；只有 `127.0.0.1:19022`（商家浏览器）与 `19023` 在听。⇒ **本轮没有可用现场**（§5）。 |
| 13 | 读 4 家的 `10-backfill.txt`（网林/盖文淘宝/科塔 三家 + 盖文天猫同形） | 全部是：`Error: expected one Feishu row for <店> / 1790524800000, got 0`。**不是修复层的问题** —— 是 `backfill` 阶段自己找不到目标行。 |
| 14 | 验算 `reportDateEpoch('2026-09-28')` | `= 1790524800000` ✅ 日期换算正常，不是日期 bug。 |
| 15 | 读盖文淘宝 `07-push.txt` | push **成功**：`status=COMMITTED_AND_VERIFIED`、`recordId=reczz28HKhxyN2Pg`、`recordCountBefore=1930 → After=1931`。 |
| 16 | 对比两处 target | push（`plan.json`）写的是 **`tblkY3W8tnPWPcnh` = 总数据来源底单**；backfill（`run-inquiry-backfill.mjs:59`）读的是 **`tblUnwn05vl8Wik9` = 各店铺数据日报**。**两者不是同一张表。** |
| 17 | 只读拉 `各店铺数据日报` 的 `店铺` 字段选项 | type=3（单选）。`optIYzOzu2=盖文天猫`、`optnIqwuUN=里可林淘宝`、`optFFaXJeh=盖文淘宝`、`optnF3h5i7=科塔淘宝`、`optUKhpHUN=网林天猫`… |
| 18 | 只读扫 `各店铺数据日报` 全表 2197 行 | 日期 `2026-09-28` 共 **12 行**（全部 `reczz28HKFEf*`）；**有值的只有 2 行**：`optIYzOzu2`（盖文天猫）行 `询单量=16 / 同层同行=34`，`optFFaXJeh`（盖文淘宝）行 `询单量=5 / 同层同行=6`。**其余 10 行（含 `optnIqwuUN=里可林淘宝`）询单量全空。** |
| 19 | 直接回读 `recordId=reczz28HKhxyN2Pg` | 在 `各店铺数据日报` 里 → **`code=1254043 RecordIdNotFound`**；在 `底单` 表里 → **`code=0`，`店铺=["optFFaXJeh"]`（盖文淘宝）**。⇒ **push 报的 recordId 是底单表的行，backfill 却拿它去各店铺数据日报里查。** |
| 20 | 只读列 `各店铺数据日报` 的 `日期` 字段 | 类型 = **5（日期型）**。⇒ `cell(record.fields['日期'])` 得到的是显示文本，`Number(...)` 为 `NaN`，**永远不等于 epoch**。这才是 `got 0` 的直接原因。 |
| 21 | 只读列 `总数据来源底单` 全部 100 个字段名 | **里面没有「询单量」，也没有「同层同行询单量」**（有「空列不用管」「店铺」「统计日期」… 到「揽收包裹数」）。⇒ 即便把表改对，**往底单里写询单量在 schema 上也不可能**。 |
| 22 | 读 `readback-daily-report.mjs` 未提交改动 | 同一批改动把「截图缺失」的退出码从 `1` 改成 `4`。方向正确但**已登记未提交**，运行的是旧的 `1`。 |

---

## 2. 根因（编号，按严重度）

### R-A（严重，**不是**交接里的那条）
**`backfill` 这一版把「各店铺数据日报」的行当成了「总数据来源底单」的行，并且用错了日期字段的类型。**

三条互相独立的证据同时指向同一个结论：

1. `run-inquiry-backfill.mjs:59` `tableId: TARGET.inquiryTable` ＝ `tblUnwn05vl8Wik9`（**各店铺数据日报**），
   而 `tblUnwn05vl8Wik9` 的 `日期` 字段 type=**5**（日期型）⇒ `Number(cell(...)) === epoch` **恒为 false**
   ⇒ `matches.length === 0` ⇒ 抛 `got 0`。**这就是 4 家失败日志里的那一行。**
2. `push` 报的 `recordId=reczz28HKhxyN2Pg` 在**底单**表里存在（`店铺=["optFFaXJeh"]`＝盖文淘宝），
   在**各店铺数据日报**里 `RecordIdNotFound`。⇒ 两处明确不是同一张表、不是同一族行。
3. `总数据来源底单` 100 个字段里**没有**「询单量」⇒ 回填链的目标（底单）在 schema 上就放不下询单量。

**R-A 的次生结论（要人去核）**：`各店铺数据日报` 里 09-28 那 12 行**不是这一轮创建的**
（`reczz28HKFEf*` 这一族 recordId 已存在于 `evidence/baseline-2026-09-28-prerun/independent-readback.json` 的快照里），
所以**写坏发生在 09-28 基线快照那一刻或更早，不是 09-29 这一轮**。
现在表上的值是 **盖文天猫=16/34、盖文淘宝=5/6，其余 10 家全空**。
**这两行是谁的、值对不对、该不该改 → 是人的决定，不是修复动作能碰的闭集。我没有动它。**

### R-B（严重，**已登记未上线**；但**不是**里可林那家的成因 —— 见 §5.1 更正）
`collect-promotion-report.mjs` 的**二次稳定判据**（`ENTRY_RESTABILIZE_MS` / `ENTRY_LOCATE_ATTEMPTS` / `locateEntryRetry` / `locateEntry`）
在**工作区里改好了，但没提交**（`git diff` 可见，`git show HEAD:` 里没有）。
它防的是「复选框刚点完、页面正在重排时误报 `action-row-hidden`」那个坑。

**⚠️ 实测推翻了我自己第 12 步的推测**：里可林这一轮 `06-promotion-fetch.txt` 的日志显示
**入口定位是成功的**（`入口 = 第 2 行…rect=[136,370,50,24]`、`复核通过（y=370（中心点命中））`、
真实鼠标点击已发出）—— 真正失败在最后一行：

```
采集失败：30000ms 内没等到新 zip：判据取文件系统，页面说「生成成功」不算数
```

⇒ **R-B 是「同一个坑的补丁还没上线」（真的，但不是这一轮的成因）；
里可林真正的成因是「点击发出去了，但 30s 内 Downloads 目录里没出现新 zip」（我称它 R-D，见下）。
这两件事必须分开，否则会去修一个没坏的地方。**

### R-C（确证，交接里的那条 —— 但它只是「修复层整条死掉」）
`executeRepairCandidate` 把**候选对象**当动作名传下去 ⇒ `applyRepairAction` 四处 `===` 比较全部落空
⇒ `needsPage` 误判为 true ⇒ 去读页签 ⇒ `Failed to parse URL from [object Object]/targets`。
**5 家全同形，修复动作一个字都没跑成。**
**副作用（正面）**：正因为这条路径死了，这轮**没有**用错误动作去动页面 —— 现场是干净的。
**副作用（负面）**：即便这条路径修好了，它救的也只是里可林那一家（`promotion-fetch`）；
另外 4 家的 `STAGE_FAILED / backfill` 会被 `REPAIR_TABLE` 回一篇 `REAPPLY_DATES`/`RELOAD_PAGE`，
**修不动一个飞书表/行的错配** —— 4 家会照样失败，只是多留下一堆动作证据。

### R-D（里可林淘宝在 `promotion-fetch` 的真成因）
日志（`里可林淘宝/06-promotion-fetch.txt`）末尾逐行：

| 行 | 内容 | 含义 |
|---|---|---|
| 1 | `[0/2] 阿里妈妈页 …｜phase=fetch｜目标日 2026-09-28` | 阶段启动 |
| 2 | `[身份] 阿里妈妈会员 = "里可林家居:阿彦" ID="2350600069" ✓` | 店铺身份核对通过 |
| 3 | `[fetch] 目标任务 = 营销场景报表_20260929_154634（台账里 2026-09-28 的未取任务，且列表里核到了（列表 12 条））` | 台账匹配成功 |
| 4 | `[fetch] 第 1/6 次：复选框中心被 DIV 挡住，等一会儿重试（不硬点 —— 这一页点错不报错）` | 有遮挡 |
| 5 | `[遮挡] 全屏层 DIV#wrapper_dlg_472 … z=99999，rect=[0,0,1506,642]` → `[遮挡] 回读：全屏层剩 0 个 ⇒ 不再挡事` | **遮挡层自己关掉了** |
| 6 | `[fetch] 真实鼠标点它的复选框 (143,342) → {"clicked":true}` | 点击发出 |
| 7 | `[fetch] 回读 checked=true，当前勾选 = [1]` | **复选框确认勾中** |
| 8 | `[fetch] 入口 = 第 2 行 …｜rect=[136,370,50,24]，center=[161,382]｜操作行内叶子 1 个` | **入口定位成功** |
| 9 | `[fetch] 复核通过（y=370（中心点命中））→ 真实鼠标点击 (161,382) → {"clicked":true}` | **下载点击发出** |
| 10 | `[fetch] 等待下载… 3s / 6s / … / 30s` | 轮询 30 秒 |
| 11 | `采集失败：30000ms 内没等到新 zip：判据取文件系统，页面说「生成成功」不算数` | **判据在文件系统上，Downloads 里没出现新 zip** |

**⇒ R-D 的判据是文件系统的，不是页面的** —— 三个可能，需要现场才能分：
①阿里妈妈侧因为「列表 12 条 + 已有 zip 122 个」把这次导出丢了（平台侧限流/去重）；
②`C:\Users\Administrator\Downloads` 的写入被拦（下载目录权限/安全软件）；
③30s 不够（平台这次真的慢）。
**本机另有一个独立佐证**（`runtime/run-collection-host.mjs` 的未提交改动把 `stallSeconds` 从 `300` 调成 `180`）
说明近期在「等待时长」上有过调整 —— 但这属于**别人的在改文件**，我没有碰，只是记录。

**⚠️ 这一条的修复动作本来是 `RELOAD_PAGE`/`REAPPLY_DATES` —— 两个都对 R-D 无效。**
`RELOAD_PAGE` 会把「页面说生成成功」这个状态丢掉，反而更差。**所以即使 R-C 修好，里可林也可能救不回来。**

---

## 3. 关于「改什么」的判断（我为什么没改）

交接授权我改代码。我**没有改**，理由是要改的已经不是「让 `action` 是字符串」那一处：

- R-C 的改动本身是安全的最小改动（`list[0]?.action`），但它**不解决 5 家里的 4 家**；
- 真正的 R-A 需要的是**先定产品口径**：询单量到底写哪张表的哪一行？
  两张表的 `店铺` 字段**选项 id 完全不同**，跨表「按店名找行」本身就需要一张映射表（现在没有）。
  在口径定下来之前改代码，等于**再猜一次**，而这个项目已经因为「猜」付出过代价（见 `.workbuddy/memory/2026-09-17.md:332` 的同类记录）；
- 改 R-C 还要动 `run-multi-shop-day.mjs`，而该文件**混着别人的在改内容**，提交风险高（121 个脏项）；
- 真机验证现场**不存在**（五店代理端口全关），改了也无从端到端证明。

**⇒ 我按 HANDOFF「修不动就转人」的第 6 步执行：先把现场落成可追溯的事实，交回给人。**
这不是拒绝干活，是**不让第二次错误写入发生**。

---

## 4. 我没有动任何东西（负面清单）

- **没有**任何写请求发到飞书（全部为 `GET` / `tenant_access_token`）。
- **没有**停/重启任何进程、容器、浏览器实例（`netstat` 是只读）。
- **没有**改 `.workbuddy/` 下任何文件。
- **没有**改仓库代码，**没有** `git add`/`commit`。
- **没有**跑修复动作（无现场＋无授权动表）。

---

## 5. 真机验证：**无现场可用**

- `curl http://127.0.0.1:{19041,19042,19043,19044,19045}/targets` → `http=000`（全部连不上）。
- 对照：同样手法探 `127.0.0.1:19999` 也是 `http=000`，**所以这个手法本身测不出「有没有代理」**；
  据此再补一条独立判据：`netstat -ano | grep LISTENING | grep 190xx` → **只有 `19022`、`19023` 在听**，
  **19041~19045 一个都没在监听**。两条证据同向。
- 结论：**五店的 per-shop 代理都不在了 ⇒ `repair-shop-stage.mjs --dry-run` 连目标页都读不到
  （会走 `读不到页签（代理连不上）` 那一支），排练也没有意义。** 未执行。
- 唯一的活实例是 `127.0.0.1:19022`（商家浏览器）+ `19023`（它的代理）—— 那是**共享商家浏览器**，
  **不是**五店中的任何一家，动它越界。

### 5.1 对 §1 第 12 步的自我更正（**必须看**）

我在第 12 步**只看了失败所在的那一行** `Error: expected one Feishu row … got 0`，
就推断「里可林应该也是同样」；后来完整读了 `里可林淘宝/06-promotion-fetch.txt` 才发现在此之前就失败了。
**第 12 步的结论错了，以 §2 的 R-D 为准。** 留在这里是为了让下一个人看到「只看一行会错在哪」。

---

## 6. 未做 / 挂账（交回给人，按优先级）

1. **🔴 最高：先定「询单量写哪张表」的口径**，再决定这 12 行怎么处理。
   - 现在表上的值：**盖文天猫=16/34、盖文淘宝=5/6，其余 10 家空**，日期 2026-09-28。
   - 需要人判：这两行的值是不是「对的店写了错的行」？
   - 需要人判：`总数据来源底单` **没有**询单量列 —— 是「本就该写在 `各店铺数据日报`」，
     还是「底单该加这两列」？这决定了 `run-inquiry-backfill.mjs` 的 `tableId` 该怎么改。
2. **🔴 高：R-B 的补丁要提交。** `collect-promotion-report.mjs` 的二次稳定判据已在工作区
   （`git diff` 可见、`git show HEAD:` 没有）⇒ 建议由负责那个会话的人提交，
   **不要去碰别人未提交的改动**。
   **但要认清它修不了这一轮的里可林** —— 里可林卡在 R-D（30s 内没等到新 zip），
   那次入口定位是**成功**的。先查 R-D 的三个可能（平台侧丢导出 / Downloads 写入被拦 / 30s 不够）。
3. **🟠 中：R-C 的改动照交接那样最小修**（`list[0]` → 取 `.action`；`gaveUp` 文案打 `c.action`），
   并补对象数组形状的接线级用例。**但它的价值只是「修复层不再是死的」**：
   - 对 `backfill` 那 4 家无效（表/行错配，修复动作碰不到）；
   - 对里可林也未必有效（R-D，且 `RELOAD_PAGE` 会把「页面说生成成功」丢掉，比不修更差）。
4. **🟠 中：`readback-daily-report.mjs` 的退出码 4 改动也还没提交**（同一批在改的文件里）。
5. **🟡 低：`--auto-repair` 的 `applied=false` 会连带让 `retry.attempted=false`** ——
   这个设计是对的（不原样重试），但它把「动作自己炸了」与「动作做了但没成」混在同一个 `applied=false` 里。
   建议 `executeRepairCandidate` 把 `error` 单独喂给 `gaveUp` 文案，让人在 summary 里就能看出是「炸了」还是「没成」。
6. **🟡 低：`evidence/batches-2026-09-28/b1/` 里没有 `97-repair.json`** ——
   因为修复动作从未真正执行过（这条路径整条是死的，不是「执行了失败」）。
   本报告即为该目录的修复层证据。

---

## 7. 底单实际状态（供汇报核对）

从 `summary.json` 读出的 stage 明细：

| 店 | 失败阶段 | 此前已通过的阶段 | 成因 |
|---|---|---|---|
| 里可林淘宝 | **`promotion-fetch`** | health-check / alimama-date / promotion-submit / sycm-date / shop-report（5 步全 0） | **R-D**（30s 内没等到新 zip） |
| 网林天猫 | `backfill` | 前 7 步全 0（含 push） | **R-A** |
| 盖文淘宝 | `backfill` | 前 7 步全 0（含 push，`COMMITTED_AND_VERIFIED`） | **R-A** |
| 盖文天猫 | `backfill` | 前 7 步全 0 | **R-A** |
| 科塔淘宝 | `backfill` | 前 7 步全 0 | **R-A** |

> **更正交接里的表述**：交接说「里可林在 `promotion-fetch`；其余 4 家在 `backfill`」—— 这一段是**对的**，
> 我第 12 步自作主张把它当成「5 家同形（都败在 backfill）」写进了时间线，是**我的错**，见 §5.1。
> 两组成因完全不同（R-A vs R-D），修法也完全不同。

**关键更正（对汇报口径）**：`summary.json` 里没有底单「行数」这个字段。
「09-28 从基线 0 行写到 4 行」这个说法**需要重新核对** —— 我能直接证实的只有本节上表的 5 家 stage 明细，
以及**各店铺数据日报**里 09-28 的 12 行/2 行有值（那一族行来自 09-28 基线快照，不是这一轮新增）。
