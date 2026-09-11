# 测试基线登记 2026-09-11

范围：P1 建立分级测试入口后的首次全量基线。执行机为开发机（Windows，Node v22.22.2），非干净环境。
本文件只登记事实与已知问题，不改任何测试断言。

## 入口变更

新增 `scripts/run-test-suite.mjs`（unit / runtime / integration 三层，目录自动发现 + 显式排除注册表，支持 `--concurrency=N` 与 `--dry-run`）。
`package.json` 新增 `test:unit`、`test:runtime`、`test:integration`、`test:all`（test:all = offline + unit + runtime，不含 integration）。

## 分套件基线结果

| 套件 | 结果 | 耗时 | 备注 |
| --- | --- | --- | --- |
| huitun-to-feishu-keyword-heat/tests | 26/26 通过 | 0.9s | |
| sycm-export-search-rank/scripts | 26/26 通过 | 4.7s | |
| sycm-to-feishu-base/tests | 58 测试，57 过，1 失败 | 1.4s | 失败项见下 |
| xws-to-feishu-base/tests | 76/76 通过 | 1.0s | |
| xws-export-market-analysis/tests | 201 测试，192 过，1 失败，8 跳过 | 260s（并行） | 时序敏感，见下 |
| runtime/*.test.mjs | 337/337 通过 | 6.8s（直跑）/ 37.8s（经 npm） | |

汇总：698 测试，688 过，2 失败，8 跳过。

## 已知问题（登记，不在本轮修复）

### K1 paste-endpoint.test.mjs 被误归为离线测试

位置：`skills/sycm-to-feishu-base/tests/paste-endpoint.test.mjs`
事实：它直连共享 CDP Proxy `http://127.0.0.1:3456`、用 PowerShell 写真实 Windows 剪贴板、向真实浏览器 tab 粘贴。它从未出现在 README 的"验证"清单里（该清单只列 build-paste-tsv 与 inspect-fields）。
本次失败表现：`GET /paste?target=missing-target` 返回 404，断言期望 400（测试第 58 行）。
处理：已从 offline 套件排除，归入 integration 层（run-test-suite.mjs EXCLUSIONS）。失败原因本身（404 vs 400）留待在真实 Proxy 环境下复核。

### K2 prepare-flow.test.mjs 的子进程时序测试在负载下 flake

位置：`skills/xws-export-market-analysis/tests/prepare-flow.test.mjs`
涉及用例：第 994 行 "full flow falls back to a DOM click when coordinate clicks do not start collection"（并行整包跑时失败）；第 1089 行断言 `result.code === 1` 的 backgroundRequestBetweenArmAndClick 用例（串行跑时观察到失败栈）。
特征：两者都 spawn 真实 CLI 子进程 + fake proxy，依赖 stall/deadline 真实定时器。测试本身隔离良好（独立 mkdtemp、临时端口、XWS_RUNTIME_DIR 覆盖），失败与 CPU 负载相关。
单跑对照：`flow.test.mjs` 单独跑 50/50 通过、0.6s；`prepare-flow.test.mjs` 单跑超过 240s 未完成（该文件本身耗时长）。
环境污染说明：本轮多次用 timeout 截断测试进程，Windows 下会遗留孤儿子进程，后续测量受其影响，基线数字可能偏悲观。需要在安静机器上用 `node scripts/run-test-suite.mjs unit --concurrency=1` 重测一次才能给出可信结论。
处理：登记，不改断言。候选方案（P1/P2 决策）：该重套件固定 `--test-concurrency=1`，或将这两个用例的截止阈值放宽。

## 遗留待办

1. `test:agent-runtime` 仍使用 shell glob（`agent-runtime/tests/*.test.mjs`），依赖 Node >= 21 的 --test glob 支持，与 engines 声明的 >=18 不一致；且该套件需 Temporal 本地测试服务，未纳入本轮基线。
2. 4 个 skill（sycm-export-search-rank、sycm-to-feishu-base、xws-to-feishu-base、huitun-to-feishu-keyword-heat）的 SKILL.md frontmatter 没有 version 字段；`agent-runtime` 的 manifest 解析器要求 name+version，当前只因恰好只加载 xws-export-market-analysis 而未触发问题。
3. Python 侧无 CI 覆盖（本轮 CI 只做 Node L0-L2）。
