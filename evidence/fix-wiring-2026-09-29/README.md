# 接线断点三修（⑧ / ⑨ / ⑨b）—— 2026-09-29

用户指令：「该需要修复的就修复，查清楚问题所在，9-24 的数据不用管了」。
本目录是这次修复的**可复跑证据**。脚本都用「文件自身位置」定位仓库根，
可以 `node evidence/fix-wiring-2026-09-29/<脚本>` 从任意 CWD 跑。

## 修了什么（三处，同一病根：东西建好了、没接上）

| # | 断点 | 真因 | 修法 | 验证 |
|---|---|---|---|---|
| ⑧ | 询单量回填 `got 0` | `店铺` 是 SingleSelect，OpenAPI 会回**选项 id**（`optFFaXJeh`），旧判据只比店名 ⇒ 恒不等 | `findDailyStoreRow()` 认两种形态；optionId 从 API 反查 | 真机只读排练 + 3/3 突变 |
| ⑨ | `--auto-repair` 整条是死的 | `planRepair()` 给**对象**，`executeRepairCandidate` 当**动作名**传 ⇒ 四路 `===` 全落空 | `actionNameOf()` 归一（两种形状都收）；`splice` 按名字摘 | 3/3 突变（M1 红 4 条 / M2 红 2 条 / M3 红 1 条） |
| ⑨b | 链级告警不等 agent | 告警直接发飞书，从不问「该不该先交给 agent」⇒ 第②层从没执行、第③层被提前执行 | 默认关的 `--defer-agent-actionable-alert` 闸门：整批都够格才拦并落 `escalation-handoff.json` | 3/3 突变 + 开关两跳都通 |

## 本目录脚本

- `rehearse-inquiry-match.mjs` —— **真机排练**（只读，走 OpenAPI，不碰浏览器）。
  拿真实询单表当下具：09-28（id 形态）修复前 0 / 修复后 1；09-27（店名形态）前后都 1；
  未登记店名 ⇒ 0。**不发任何写请求。**
- `mutate-inquiry-shop-match.mjs` —— ⑧ 的突变验证（3 个突变，逐条还原 + sha256 比对）。
- `mutate-repair-wiring.mjs` —— ⑨ 的突变验证（3 个突变）。
- `mutate-alert-deferral.mjs` —— ⑨b 的突变验证（3 个突变）。

## 复跑结果（2026-09-29 20:5x）

```
mutate-inquiry-shop-match   : 3/3 全红且点名，还原 sha256 609214a8… 逐字节一致
mutate-repair-wiring        : 3/3 全红且点名，还原逐字节一致
mutate-alert-deferral       : 3/3 全红且点名，还原 sha256 159a3813… 逐字节一致
rehearse-inquiry-match      : 09-28 五家 0→1（matchedBy=field-option-id）；
                              09-27 五家 1/1（matchedBy=shop-name）；未登记店名 ⇒ 0；未发写请求
```

## 离线套件（本版之后）

- `runtime/*.test.mjs` 966/966
- `skills/sycm-alimama-daily-report/scripts/*.test.mjs` 403/403
- `skills/xws-to-feishu-base/tests/*.test.mjs` 101/101
- `runtime/version-consistency.test.mjs` 6/6（VERSION = package.json = CHANGELOG 首条 = 1.7.9）

## 验证边界（说清楚，别把「接上线」读成「已证明能救」）

- ⑧ 有真机只读证据（未发写请求）⇒ 匹配口径这一层是真跑过的。
- ⑨ 的验证程度是「**修复层不再是死的**」，**不是**「已证明能救回 09-28 那 4 家」。
  它**也救不了**那 4 家 —— 修复动作碰不到字段映射（⑧ 才是那 4 家的病根）。
  真机排练做不了：09-29 当晚 12 个端口全 free，没有存活浏览器；**未经许可不起停任何进程**。
- ⑨b 的验证程度是「开关两跳都通、默认逐字不变」，**不是**「会话侧已按派单派 agent」
  —— 那一步在会话侧，脚本唤不醒 agent（没有 `Agent` 工具）。

## 顺带查清（只读，结论已在 1.7.9 的 CHANGELOG 里）

询单表 2197 行 + 66 份收据交叉核对：09-17~09-23 5/5、**09-24 4/5**、09-25/26 5/5、
09-27 4/5、09-28 2/5。失配 **100% 在 `店铺` 维度**（日期维度已排除，两边都是北京零点）。
**09-24 网林天猫收据假绿**（写 6/10、实读 null，66 份里唯一一份）——
用户已明确「9-24 的数据不用管了」，故**不补**，只留档。
完整核查产物在 `evidence/inquiry-writeback-audit-2026-09-29/`。

## 一处判断更正

09-28 那 12 行与周围同属 `reczz28HKFE` 批次，是**普通批次行的 `店铺` 值被写成了选项 id 形态**，
不是「另一套流程写的骨架行」——初版判断（`inquiry-writeback-audit-2026-09-29/README.md` §3/§5）
已按此更正。
