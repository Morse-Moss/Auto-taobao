-- 001-supervisor-tables.sql
-- 监督 Agent 持久化最小 schema（S0，SUPERVISOR-AGENT-DESIGN.md 8.2-4）
-- 状态：未执行。DDL 属关键数据库变更，须用户明确授权后才能 apply。
-- 回滚：执行 001-rollback.sql（先建后删，幂等）。

-- 监督 Agent 产生的提案（模型输出 + 审计元数据；原文摘要，不存敏感 payload）
CREATE TABLE IF NOT EXISTS supervisor_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_key    text NOT NULL UNIQUE,              -- 稳定幂等键（run:attempt:task:digest）
  run_id          uuid NOT NULL,
  step_id         text,
  attempt_id      text,
  task_type       text NOT NULL,
  schema_version  text NOT NULL DEFAULT 'agent-proposal-v1',
  prompt_version  text NOT NULL,
  model           text NOT NULL,
  model_version   text,
  risk_class      text NOT NULL CHECK (risk_class IN ('LOW','MEDIUM','HIGH','HUMAN_REQUIRED')),
  requested_action text NOT NULL,
  parameters      jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_refs   jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason          text,
  confidence      real,
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'PROPOSED'
                  CHECK (status IN ('PROPOSED','VALIDATED','REJECTED','APPROVED','EXPIRED')),
  rejection_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supervisor_proposals_run ON supervisor_proposals(run_id, created_at DESC);

-- 已验证 proposal 转成的动作意图（Workflow 的唯一输入）
CREATE TABLE IF NOT EXISTS supervisor_action_intents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_key      text NOT NULL UNIQUE,              -- 幂等键 run:attempt:action:profile
  proposal_id     uuid REFERENCES supervisor_proposals(id),
  run_id          uuid NOT NULL,
  attempt_id      text,
  action          text NOT NULL,
  parameters      jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_decision text NOT NULL CHECK (policy_decision IN ('APPROVED','HUMAN_REQUIRED','DENIED')),
  idempotency_key text NOT NULL,
  expires_at      timestamptz NOT NULL,
  executed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supervisor_intents_run ON supervisor_action_intents(run_id, created_at DESC);

-- 人工审批（一等持久化状态，公理 5）
CREATE TABLE IF NOT EXISTS supervisor_approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id    uuid REFERENCES supervisor_action_intents(id),
  run_id       uuid NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('APPROVED','DENIED','EXPIRED')),
  operator     text NOT NULL,
  decided_at   timestamptz NOT NULL DEFAULT now(),
  note         text
);

-- 提交记录（幂等副作用对账用；状态机含 UNKNOWN）
CREATE TABLE IF NOT EXISTS supervisor_commit_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_key      text NOT NULL UNIQUE,              -- 业务唯一键（幂等）
  run_id          uuid NOT NULL,
  attempt_id      text,
  target          text NOT NULL,                     -- 提交目标（如表名/外部系统）
  status          text NOT NULL DEFAULT 'READY'
                  CHECK (status IN ('NOT_REQUESTED','READY','COMMITTING','COMMITTED','VERIFIED','UNKNOWN')),
  artifact_digest text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz
);

-- 经验库生产表（签名 + 环境指纹 + 置信度 + 历史退役）
CREATE TABLE IF NOT EXISTS supervisor_experience (
  id              text PRIMARY KEY,                  -- exp-<...>
  signature       jsonb NOT NULL,                    -- {failureClass, errorPattern, stage}
  symptom         text,
  root_cause      text,
  remedy          text,
  actions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_digest text,
  capability_version text,
  env_fingerprint text,
  confidence      real NOT NULL DEFAULT 0.5,
  occurrences     integer NOT NULL DEFAULT 0,
  retired         boolean NOT NULL DEFAULT false,
  needs_review    boolean NOT NULL DEFAULT false,
  history         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
