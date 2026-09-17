-- 007-daily-report-push-audit.sql
-- 日报链的**只追加审计日志**（不是台账、不是权威）。
--
-- 为什么建它（2026-09-17 用户拍板「建」）：
--   日报链的本地落地只有过程文件（evidence/daily-report-*/{plan,paste,receipt}.json）。
--   要回答「09-14 那天推过几次、用的哪个源文件、重推覆盖过没有」，只能一个个翻收据目录，
--   或者去问飞书。飞书是外部租户，查不了 SQL。所以需要一份本地、可 SQL 查询的动作记录。
--
-- 为什么它的定位必须是「审计」而不是「台账」：
--   日报链的事实只有一个 —— **飞书底单里有没有这一行**。如果本地也存一份「已推送集合」，
--   就会出现两个地方都能对同一个问题下断言（飞书那行被人手删了、API 超时但本地已写成功、
--   本地表被谁改了），而没有任何东西能判定谁对。
--   所以本表的语义边界写死为：
--     只记「我做过什么动作、结果如何」，不记「现在事实是什么」。
--   具体约束（由 runtime/daily-report-audit.mjs 与它的测试守着）：
--     1. 没有任何读接口 —— 写入方模块只导出写函数，不导出查询函数；
--     2. 没有业务唯一键 —— 同一天同一店推十次就有十行，重复本身就是要被记录的事实；
--     3. 查重、判重、幂等一律仍然只问飞书（见 run-daily-report.mjs 的 duplicates 逻辑）。
--   换句话说：这张表允许与飞书不一致，因为「不一致」正是它要暴露的现象。
--
-- 幂等：CREATE TABLE / INDEX IF NOT EXISTS，可重复执行。纯新增表，不触碰任何既有表与数据行。
-- 回滚：执行 007-rollback.sql（DROP TABLE，fail-closed：表上已有数据时不删）。

CREATE TABLE IF NOT EXISTS daily_report_push_audit (
  id                      bigserial PRIMARY KEY,
  at                      timestamptz NOT NULL DEFAULT now(),   -- 动作发生时刻（真实时钟）
  action                  text NOT NULL
                          CHECK (action IN ('push','ui-verify','inquiry-backfill')),
  outcome                 text NOT NULL CHECK (outcome IN ('ok','failed')),
  report_date             date,               -- 审计对象：报表是哪一天的（不是「哪天发生的」）
  shop_name               text,
  record_id               text,               -- 飞书记录 id（失败时为 NULL）
  record_count_before     integer,
  record_count_after      integer,
  verified_fields         integer,
  mode                    text,               -- api-commit / verify-existing / ui-import / preset / explicit
  source_shop_file        text,
  source_shop_sha256      text,
  source_promotion_file   text,
  source_promotion_sha256 text,
  browser_port            integer,            -- 收据 environment.browserPort.port（可能是退役端口，如 9223）
  browser_id              text,
  proxy_port              integer,
  computed_at             timestamptz,        -- 收据 environment.computedAt（用来暴露「提示时钟≠真实时钟」）
  node_version            text,
  receipt_path            text,
  detail                  jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- 主查询形状：「某个日期+店铺，历史上发生过什么」。
CREATE INDEX IF NOT EXISTS idx_daily_report_push_audit_date_shop
  ON daily_report_push_audit (report_date DESC, shop_name, at DESC);

-- 次查询形状：「最近发生过什么」（排障时最常用）。
CREATE INDEX IF NOT EXISTS idx_daily_report_push_audit_at
  ON daily_report_push_audit (at DESC);

COMMENT ON TABLE daily_report_push_audit IS
  '只追加审计日志：记录日报链做过的动作与结果。不参与查重/判重/幂等（那些只问飞书），
   因此允许与飞书不一致 —— 不一致正是它要暴露的现象。无读接口，无业务唯一键。';
