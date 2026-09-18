# 注意：本目录里的 receipt.json / plan.json / paste.tsv 不是「网林天猫」的

这三件文件属于 **科塔全卫定制**（recordId `recvvySuZ5zUpB`），被一次「全抄」操作覆盖进来了。

时间线（本机时钟 UTC）：

- 09:09:05 网林天猫 `--commit` 成功 → 立即把代次目录 `evidence/daily-report-2026-09-17-rerun6/`
  里的 receipt/plan/paste 抄进本目录，**当时这三件是网林天猫的（正确）**。
- 09:12:39 科塔淘宝 `--commit` → 代次目录里的同名文件被换成科塔的（这是设计使然：
  代次目录只按日期取名，永远只有**最后一次**运行的那一份）。
- 09:16:44 网林天猫询单回填后，我又执行了一次「全抄 5 件」，
  **把本目录里已经正确的三件用科塔的同名文件覆盖掉了** —— 这是我的操作失误，
  不是脚本的问题（脚本从没承诺过代次目录会保留历史）。

本目录里**仍然正确**的是这两个（它们是在覆盖之后才生成的，属于网林天猫）：

- `inquiry-backfill-plan.json`
- `inquiry-backfill-receipt.json`

网林天猫推送那一步的事实没有丢，可以从这三处独立读到：

1. `../06-daily-report-commit.txt` —— 当时的完整 stdout（recordId `recvvyRBZ74juL`、
   `verifiedFields 240`、`recordCountBefore 1877 → after 1878`、`shopName 网林家居旗舰店`）。
2. 本地审计表 `daily_report_push_audit` 的 `id=14`（`push/ok`）。
3. 独立回读：`../../11-independent-readback.txt`（底单命中 5 行，含网林家居旗舰店）
   与 `../../13-final-verify-0917-fixed.txt`（OpenAPI 直读，访客数 109 与源 xlsx 一致）。

根因与修法见 `../../RUN-LOG.md` 的「发现 1」。
