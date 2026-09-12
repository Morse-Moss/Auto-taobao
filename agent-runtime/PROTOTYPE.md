# PROTOTYPE 定位声明（S0 边界门禁）

`agent-runtime/temporal/` 当前状态：**Temporal POC，fake adapter**。

依据 SUPERVISOR-AGENT-DESIGN.md 第 0/8.3 节的代码事实：

- activities.mjs 的 observePage / executeAction / commitArtifact / releaseLease 是 fake adapter；
- 模块级 Set 与变量（commitKeys、leaseReleased）在进程重启后全部消失；
- workflows.mjs 只接受单页、内存拼装输入，未证明真实浏览器采集、真实 PostgreSQL cursor、真实工件校验或恢复。

在 S1 真实故障注入验收逐项通过前，本目录不得用于生产，文件与文档必须持续标注 prototype。
Temporal 的采用条件见设计文档第 9 节：由故障注入结果决定，不由框架名称决定。
