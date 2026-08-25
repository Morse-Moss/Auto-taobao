Current stage: STAGED / CRITICAL / CONTRACT - add one permanent current-period dashboard data source without changing weekly business fields.
Last verified: batches `[1,3]` are valid, batch 2 remains excluded, the current 300-row table has no pending decision-formula changes, and the existing history/post-AI tests pass 22/22.
Next action: add failure-first tests for history visual snapshots and the formula-driven `本期标记`, then implement only the guarded history-sync delta.

Decision: keep one dashboard on `关键词历史总表 V1`; snapshot `标准归并词`, `是否重点词`, and `优先级` as text, and calculate `本期标记` from the latest valid batch number. Reject per-row current markers because partial writes can expose two or zero current periods.
DoD: dry-run reports exact schema/record changes; apply is backup-first and allowlisted; exactly the latest valid batch evaluates to `本期标记=是`; invalid batch 2 remains excluded; a second dry-run is a no-op; unrelated fields and records are byte-equivalent after excluding planned/formula outputs.
Authorization: user said `开始补吧`; bounded to Base `N21Abkg0HakO6AsbCaDckvcwnVd`, current table `tblCswWXxEVGV20s`, history table `tblh1Rwt0LE68KXc`, additive/update-only visualization fields and one dashboard. No deletion, no other Base/table, no secret disclosure.
