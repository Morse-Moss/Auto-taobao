-- 004-architecture-catalog.sql
-- Agent SOP Runtime 架构目录（本项目业务库 PostgreSQL：xws_automation @ 127.0.0.1:5432）
--
-- Scope: 架构审查、目标模块、缺口、实施阶段、决策和证据引用。
-- This migration does not replace durable_runs, supervisor_commit_records,
-- supervisor_proposals, business tables, or runtime evidence.
-- Apply: only in the authorized project business DB (xws_automation, container xws-adaptive-postgres).
-- Rollback: db/migrations/004-rollback.sql

CREATE SCHEMA IF NOT EXISTS architecture;

CREATE TABLE IF NOT EXISTS architecture.reviews (
  review_id                  uuid PRIMARY KEY,
  project_key                text NOT NULL,
  review_version             integer NOT NULL,
  review_scope               text NOT NULL,
  conclusion_status          text NOT NULL CHECK (conclusion_status IN ('complete','partial','incomplete')),
  can_start_simple_sop       boolean NOT NULL DEFAULT false,
  can_start_multi_agent_sop  boolean NOT NULL DEFAULT false,
  summary                    text NOT NULL,
  source_snapshot            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  supersedes_review_id       uuid NULL REFERENCES architecture.reviews(review_id),
  UNIQUE (project_key, review_version)
);

CREATE TABLE IF NOT EXISTS architecture.capabilities (
  capability_id          uuid PRIMARY KEY,
  review_id              uuid NOT NULL REFERENCES architecture.reviews(review_id) ON DELETE CASCADE,
  capability_code        text NOT NULL,
  status                 text NOT NULL CHECK (status IN ('已具备','部分具备','缺失')),
  current_implementation text NOT NULL,
  advantages             text NOT NULL DEFAULT '',
  gaps                   text NOT NULL DEFAULT '',
  new_module_impact      text NOT NULL DEFAULT '',
  recommendations        text NOT NULL DEFAULT '',
  evidence_refs          jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority               text NOT NULL CHECK (priority IN ('P0','P1','P2')),
  UNIQUE (review_id, capability_code)
);

CREATE TABLE IF NOT EXISTS architecture.modules (
  module_id              uuid PRIMARY KEY,
  review_id              uuid NOT NULL REFERENCES architecture.reviews(review_id) ON DELETE CASCADE,
  module_name            text NOT NULL,
  module_layer            text NOT NULL,
  current_state          text NOT NULL,
  target_state           text NOT NULL,
  change_type            text NOT NULL CHECK (change_type IN ('retain','add','refactor','replace')),
  responsibility         text NOT NULL,
  owns_state             text NOT NULL DEFAULT '',
  dependencies           jsonb NOT NULL DEFAULT '[]'::jsonb,
  forbidden_dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk                   text NOT NULL DEFAULT '',
  priority               text NOT NULL CHECK (priority IN ('P0','P1','P2')),
  UNIQUE (review_id, module_name)
);

CREATE TABLE IF NOT EXISTS architecture.gaps (
  gap_id               uuid PRIMARY KEY,
  review_id            uuid NOT NULL REFERENCES architecture.reviews(review_id) ON DELETE CASCADE,
  gap_code             text NOT NULL,
  gap_title            text NOT NULL,
  current_evidence     text NOT NULL,
  target_requirement   text NOT NULL,
  severity             text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  priority             text NOT NULL CHECK (priority IN ('P0','P1','P2')),
  proposed_action      text NOT NULL,
  acceptance_criteria  text NOT NULL,
  status               text NOT NULL CHECK (status IN ('open','planned','in_progress','done','deferred')),
  owner_module         text,
  depends_on           jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (review_id, gap_code)
);

CREATE TABLE IF NOT EXISTS architecture.phases (
  phase_id        uuid PRIMARY KEY,
  review_id       uuid NOT NULL REFERENCES architecture.reviews(review_id) ON DELETE CASCADE,
  phase_no        integer NOT NULL,
  phase_name      text NOT NULL,
  priority        text NOT NULL CHECK (priority IN ('P0','P1','P2')),
  objective       text NOT NULL,
  key_changes     jsonb NOT NULL DEFAULT '[]'::jsonb,
  deliverables    jsonb NOT NULL DEFAULT '[]'::jsonb,
  dependencies    jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks           jsonb NOT NULL DEFAULT '[]'::jsonb,
  exit_criteria   jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL CHECK (status IN ('planned','in_progress','done','blocked','deferred')),
  UNIQUE (review_id, phase_no)
);

CREATE TABLE IF NOT EXISTS architecture.decisions (
  decision_id            uuid PRIMARY KEY,
  review_id              uuid NOT NULL REFERENCES architecture.reviews(review_id) ON DELETE CASCADE,
  decision_code          text NOT NULL,
  decision               text NOT NULL,
  rationale              text NOT NULL,
  alternatives_rejected  jsonb NOT NULL DEFAULT '[]'::jsonb,
  tradeoffs              text NOT NULL DEFAULT '',
  status                 text NOT NULL CHECK (status IN ('accepted','provisional','superseded')),
  effective_from         timestamptz NOT NULL DEFAULT now(),
  superseded_by          uuid NULL REFERENCES architecture.decisions(decision_id),
  UNIQUE (review_id, decision_code)
);

CREATE TABLE IF NOT EXISTS architecture.evidence_refs (
  evidence_ref_id uuid PRIMARY KEY,
  review_id       uuid NOT NULL REFERENCES architecture.reviews(review_id) ON DELETE CASCADE,
  ref_type        text NOT NULL CHECK (ref_type IN ('file','run','decision','external_plan','command_output')),
  ref_uri         text NOT NULL,
  label           text NOT NULL,
  evidence_time   timestamptz,
  confidence      text NOT NULL CHECK (confidence IN ('verified','observed','inferred','unverified')),
  notes           text NOT NULL DEFAULT '',
  UNIQUE (review_id, ref_uri)
);

CREATE INDEX IF NOT EXISTS idx_arch_reviews_project
  ON architecture.reviews(project_key, review_version DESC);
CREATE INDEX IF NOT EXISTS idx_arch_capabilities_priority
  ON architecture.capabilities(priority, status);
CREATE INDEX IF NOT EXISTS idx_arch_gaps_open_priority
  ON architecture.gaps(priority, status) WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS idx_arch_modules_layer
  ON architecture.modules(module_layer, priority);
CREATE INDEX IF NOT EXISTS idx_arch_phases_status
  ON architecture.phases(status, priority);
CREATE INDEX IF NOT EXISTS idx_arch_evidence_type
  ON architecture.evidence_refs(ref_type, confidence);

-- Fixed IDs keep the catalog seed idempotent without overwriting later revisions.
INSERT INTO architecture.reviews (
  review_id, project_key, review_version, review_scope, conclusion_status,
  can_start_simple_sop, can_start_multi_agent_sop, summary, source_snapshot
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  'sycm-automation',
  1,
  '前两套 SYCM/XWS 自动化流程、现有 runtime/skills/agent-runtime 框架，以及上下文、压缩、记忆、动态 Skill、模块化和扩展性。',
  'partial',
  true,
  false,
  '业务 Skill 和证据校验基础较成熟；统一 Context、压缩、跨会话记忆、动态 Skill Registry、恢复和多 Agent 高并发闭环尚未完成。',
  jsonb_build_object(
    'projectPath', 'D:/Retire/sycm-automation',
    'reviewDate', '2026-09-13',
    'baselineDocs', jsonb_build_array('docs/architecture/README.md','docs/standards/README.md','PROJECT-HANDOVER-ANALYSIS.md','SUPERVISOR-AGENT-DESIGN.md','PROJECT-SYSTEM-DESIGN-ANALYSIS.md'),
    'migration', '004-architecture-catalog.sql'
  )
) ON CONFLICT (project_key, review_version) DO NOTHING;

INSERT INTO architecture.capabilities (
  capability_id, review_id, capability_code, status, current_implementation,
  advantages, gaps, new_module_impact, recommendations, evidence_refs, priority
) VALUES
(
  '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'context_management', '部分具备',
  'Skill 合同、运行参数、durable_runs/durable_attempts、verified cursor、阶段收据和人工状态分别保存上下文。',
  '已有进程外 PostgreSQL 状态、CAS cursor、attempt 心跳和业务验收收据。',
  '缺少统一 sop-context-v1、跨 Agent 交接协议、上下文版本和单一恢复入口。',
  '长流程恢复和多 Agent 结果合并需要重复解释状态，容易重复执行副作用。',
  '实现 Context Store、五条状态轴、checkpoint/CAS 和统一 Context 读取接口。',
  jsonb_build_array('db/migrations/002-durable-run-tables.sql','db/migrations/003-durable-attempt-heartbeat.sql','docs/architecture/README.md'),
  'P0'
),
(
  '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
  'context_compression', '缺失',
  '未形成结构化上下文摘要、token/字节阈值或压缩后 schema 校验。',
  '已有 manifest、evidence 和运行收据，可作为压缩后的原文引用。',
  '压缩可能丢失授权边界、游标、外部副作用、阻塞原因和下一动作。',
  '长会话或跨会话恢复会重复执行或把历史推断当作当前事实。',
  '建立结构化摘要，永久保留身份、授权、状态轴、游标、副作用、阻塞、下一动作和原文 digest。',
  jsonb_build_array('docs/architecture/README.md','docs/standards/README.md'),
  'P1'
),
(
  '20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
  'cross_session_memory', '部分具备',
  '架构文档、project knowledge、经验表和历史 evidence 保存跨运行知识。',
  '已经沉淀平台控制、失败模式、证据边界和用户偏好的真实经验。',
  '缺少记忆类型、作用域、来源、置信度、有效期、冲突处理和检索层。',
  '新模块只能人工阅读分散规则，旧证据可能污染当前运行判断。',
  '分离 Run Context、Evidence、Verified Fact、Rule/Decision 和 Experience；当前证据优先。',
  jsonb_build_array('db/migrations/001-supervisor-tables.sql','docs/project-knowledge.md'),
  'P1'
),
(
  '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
  'dynamic_skill_mounting', '部分具备',
  'Skill 目录和 frontmatter 可被 agent-runtime 原型读取，现有能力按目录拆分。',
  '业务边界清楚，新 SOP 可参考现有 Skill 合同和脚本组织。',
  '没有统一 manifest schema、Registry、Loader、依赖解析、权限/副作用声明和兼容性检查。',
  '新 Skill 需要人工选择，版本漂移或动态路径错误可能在运行中才暴露。',
  '为 Skill 增加 manifest，建立 Registry/Loader，执行前校验输入、依赖、权限、副作用和恢复能力。',
  jsonb_build_array('agent-runtime/local-vertical-slice.mjs','docs/architecture/README.md','skills/xws-export-market-analysis/SKILL.md'),
  'P0'
),
(
  '20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
  'modularity', '部分具备',
  'skills/ 已有能力边界，runtime/ 事实承担编排，agent-runtime/ 为未接入 POC。',
  'SYCM/XWS/Feishu 能力和验证规则已有可复用模式，外部平台规则较明确。',
  'runtime/ 与 skills/ 存在双向依赖，平台细节、运行状态和验证器还未完全隔离。',
  '新增跨平台或高并发模块会重复状态、校验、恢复和资源处理逻辑。',
  '保留业务 Skill，新增 Workflow/Adapter/Validator 边界，冻结反向依赖并迁移公共能力。',
  jsonb_build_array('PROJECT-HANDOVER-ANALYSIS.md','docs/architecture/README.md','docs/standards/README.md'),
  'P1'
)
ON CONFLICT (review_id, capability_code) DO NOTHING;

INSERT INTO architecture.modules (
  module_id, review_id, module_name, module_layer, current_state, target_state,
  change_type, responsibility, owns_state, dependencies, forbidden_dependencies, risk, priority
) VALUES
('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','task_admission','runtime','分散在运行入口和人工前置检查。','统一校验范围、授权、资源和配额并创建 run_id。','add','任务准入和策略判断。','任务身份和准入结果。','["policy","context_store"]','["browser_dom","model_decision","external_write"]','准入规则重复或越权。','P0'),
('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','workflow_controller','runtime','runtime/ 入口和局部状态机承担编排；Temporal 仍为 POC。','唯一拥有 Run/Step/Attempt 生命周期、恢复、暂停、取消和人工闸门的控制器。','add','确定性工作流控制。','执行状态和 checkpoint。','["context_store","skill_registry","validation_framework","side_effect_ledger"]','["dom_selector","direct_platform_write","agent_owned_state"]','多头状态拥有者。','P0'),
('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','context_store','storage','durable_runs/durable_attempts 已有局部状态。','统一 sop-context-v1、版本/CAS 和 checkpoint 存取。','add','当前运行上下文权威。','Context、阶段、游标引用和状态轴。','["postgresql"]','["raw_evidence","browser_dom","llm_memory"]','恢复位置不一致。','P0'),
('30000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','side_effect_ledger','storage','supervisor_commit_records 已有，覆盖不完整。','统一外部写入、上传、付费调用和 UNKNOWN 对账。','add','幂等键和副作用账本。','effect/commit 状态和 provider reference。','["postgresql","commit_reconcile"]','["agent_decision","business_field_parse"]','重复写入或重复扣费。','P0'),
('30000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','skill_registry','runtime','frontmatter 可被局部原型读取。','机器可读 manifest、依赖、版本、权限和副作用索引。','add','Skill 发现和兼容性校验。','Registry 索引。','["filesystem","schema_validator"]','["skill_execution","external_resource"]','版本漂移和动态路径逃逸。','P0'),
('30000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','skill_loader','runtime','尚无统一 Loader。','仅装载 Registry 允许的实现。','add','按 manifest 装载能力。','加载记录和版本。','["skill_registry"]','["arbitrary_path","undeclared_side_effect"]','加载任意代码。','P0'),
('30000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','validation_framework','validation','各 Skill 局部实现字段、行数、哈希和回读校验。','可组合的身份、范围、结构、完整性、关系和发布验证器。','refactor','确定性验证边界。','验证结果和证据引用。','["evidence_store"]','["state_mutation","llm_decision"]','抽象过度或规则回归。','P1'),
('30000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001','browser_broker','adapter','共享 Proxy/CDP 和登录会话由现有规则管理。','管理 profile、账号、session、tab 和短租约，不暴露凭据。','add','浏览器资源生命周期和隔离。','Lease 和资源所有权。','["postgresql","shared_cdp_proxy"]','["unknown_tab_close","credential_exposure"]','账号串用和租约泄漏。','P1'),
('30000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000001','sycm_adapter','adapter','SYCM 脚本包含页面细节和导出校验。','封装 SYCM 发现、分页、下载和 Observation/ArtifactRef。','refactor','SYCM 平台适配。','无业务状态；输出工件引用。','["browser_worker","validation_framework"]','["workflow_state","agent_write"]','页面变化传播到工作流。','P1'),
('30000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001','xws_adapter','adapter','XWS 采集脚本与 adaptive 状态局部耦合。','封装市场分析、SKU、FAQ 采集和平台观察。','refactor','XWS 平台适配。','无业务恢复状态。','["browser_worker","api_worker"]','["cursor_advance","unknown_resource_cleanup"]','长跑停滞和重复采集。','P1'),
('30000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001','feishu_adapter','adapter','现有导入 Skill 已有字段、附件和回读校验。','封装授权副本 schema、写入、回读和发布回执。','refactor','Feishu 目标适配和发布投影。','外部提交结果引用。','["api_worker","side_effect_ledger","validation_framework"]','["run_state","credential_logging"]','重复行/附件或错误目标。','P1'),
('30000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000001','evidence_store','storage','evidence/、manifest、events.jsonl 和运行产物分散。','不可变 Artifact、manifest、digest 和索引。','refactor','保存事实证据和来源。','Artifact metadata 和证据索引。','["artifact_storage","postgresql"]','["recovery_cursor","mutable_source"]','历史证据污染当前运行。','P1'),
('30000000-0000-4000-8000-000000000013','10000000-0000-4000-8000-000000000001','memory_store','storage','文档、经验表和历史 evidence 分散。','分层保存 Verified Fact、Rule/Decision 和 Experience。','add','跨会话知识检索。','作用域、来源、置信度和有效期。','["postgresql","evidence_index"]','["direct_external_action","run_state_override"]','旧经验覆盖当前事实。','P1'),
('30000000-0000-4000-8000-000000000014','10000000-0000-4000-8000-000000000001','compression_service','runtime','尚无结构化上下文压缩。','按阈值/阶段生成可校验摘要并引用原文。','add','上下文压缩和恢复摘要。','摘要版本和原文 digest。','["context_store","evidence_store"]','["state_transition","evidence_delete"]','丢失副作用或授权边界。','P1'),
('30000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000001','agent_runtime','runtime','supervisor 有规则诊断和可选 LLM hook；Temporal activity 为 fake。','受限只读证据、真实模型、proposal 持久化和独立验证。','refactor','语义解析、分类、摘要和故障提案。','Proposal，不拥有业务状态。','["evidence_store","proposal_store","proposal_validator"]','["browser_write","postgres_write","feishu_write","cursor_advance"]','模型越权或把文本当成功。','P2')
ON CONFLICT (review_id, module_name) DO NOTHING;

INSERT INTO architecture.gaps (
  gap_id, review_id, gap_code, gap_title, current_evidence, target_requirement,
  severity, priority, proposed_action, acceptance_criteria, status, owner_module, depends_on
) VALUES
('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','GAP-CONTEXT-001','统一 Context 模型缺失','Skill、收据、durable_runs 和 runtime 状态分散。','所有 Run/Step/Attempt 使用 sop-context-v1、五条状态轴和版本/CAS。','high','P0','实现 context_store 和统一读写接口。','Worker 重启后从 PG 恢复同一 run/attempt，且字段完整。','planned','context_store','[]'),
('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','GAP-CHECKPOINT-001','Checkpoint/恢复未形成闭环','Temporal POC 使用 fake adapter 和进程内 Set；真实跨进程验收未完成。','每阶段完成后有进程外 checkpoint，动作重复时依靠幂等/对账恢复。','critical','P0','以 XWS 单分片完成 Worker kill、恢复和重复回调故障注入。','独立进程终止后从最后 verified cursor 恢复，不重复提交。','planned','workflow_controller','["GAP-CONTEXT-001"]'),
('40000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','GAP-IDEMPOTENCY-001','副作用账本覆盖不完整','已有 supervisor_commit_records，但不同业务写入/上传/Provider 调用未统一。','每个外部副作用都有 effect_id、幂等键、provider reference 和 UNKNOWN 对账。','critical','P0','复用现有提交表，扩展 Commit/Reconcile 接口和测试。','commit-before-response 不产生重复业务效果，未知结果不盲写。','planned','side_effect_ledger','[]'),
('40000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','GAP-SKILL-001','Skill manifest 不完整','仅有 frontmatter 和局部读取原型，版本/依赖/权限/副作用未统一。','所有能力有可校验 manifest 和唯一版本。','high','P0','定义 manifest schema，迁移现有 SYCM/XWS/FAQ/Feishu 能力。','错误 manifest 在执行前失败，新 Skill 可通过 Registry 发现。','planned','skill_registry','[]'),
('40000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','GAP-SKILL-002','动态 Loader/Registry 缺失','Skill 主要由人工按目录和名称选择。','Registry 支持依赖解析、兼容性、权限和副作用检查，Loader 不执行任意路径。','high','P0','实现 Registry/Loader，并保留旧 CLI 兼容入口。','无核心 Runtime 修改即可注册并加载新能力。','planned','skill_loader','["GAP-SKILL-001"]'),
('40000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','GAP-VALIDATOR-001','验证器未统一','SYCM、XWS 和 Feishu 各自实现行数、字段、排名、附件和回读验证。','Validator 可组合并统一输出 evidence refs。','medium','P1','抽取身份、范围、结构、完整性、关系和发布验证器。','迁移前后业务验收结果一致，Workflow 不直接实现平台校验。','planned','validation_framework','[]'),
('40000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','GAP-ADAPTER-001','Adapter 边界不完整','runtime/ 和 skills/ 双向依赖，页面细节可能向上层泄漏。','Workflow 只依赖能力合同，DOM/API/下载关联只存在于 Adapter。','medium','P1','先冻结反向依赖，再按 SYCM/XWS 迁移 Adapter。','平台页面变化只影响能力版本，不改变 Workflow 或提交逻辑。','planned','sycm_adapter','["GAP-VALIDATOR-001"]'),
('40000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001','GAP-COMPRESS-001','上下文压缩缺失','没有阈值、摘要 schema 或压缩后完整性检查。','摘要保留身份、授权、状态、游标、副作用、阻塞、下一动作和原文 digest。','high','P1','实现 compression_service，加入摘要污染和缺字段测试。','压缩后可恢复同一 run/attempt，缺字段摘要被拒绝。','planned','compression_service','["GAP-CONTEXT-001"]'),
('40000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000001','GAP-MEMORY-001','记忆分层和检索缺失','规则、经验、文档和 evidence 没有统一作用域/有效期/冲突规则。','当前 run 证据优先，历史记忆按来源、置信度和有效期检索。','medium','P1','实现 memory_store，区分 Context/Evidence/Fact/Rule/Experience。','旧记忆不能覆盖当前验证结果，所有记忆可追溯来源。','planned','memory_store','["GAP-CONTEXT-001"]')
ON CONFLICT (review_id, gap_code) DO NOTHING;

INSERT INTO architecture.phases (
  phase_id, review_id, phase_no, phase_name, priority, objective,
  key_changes, deliverables, dependencies, risks, exit_criteria, status
) VALUES
('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',0,'架构基线和迁移落地','P0','固定审查结论、目标边界和可查询架构目录。','["新增 architecture schema","导入 review/capability/module/gap/phase/decision/evidence","发布 Spec 和交接说明"]','["004 migration","rollback","三份架构文档"]','[]','["误把架构目录当运行状态库；暂存运行产物。"]','["迁移可重复执行和回滚；文档、SQL、种子记录一致。"]','planned'),
('50000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',1,'Context、Checkpoint 和恢复','P0','统一任务上下文并证明跨进程恢复。','["sop-context-v1","Context Store/CAS","XWS 单分片故障注入"]','["schema","checkpoint store","worker kill/recovery receipt"]','["GAP-CONTEXT-001"]','["旧入口有隐式状态；动作成功后 checkpoint 丢失。"]','["杀 worker 后从最后 verified cursor 恢复且无重复提交。"]','planned'),
('50000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',2,'Side Effect Ledger、幂等和对账','P0','防止重复写入、重复附件和重复 Provider 任务。','["稳定幂等键","UNKNOWN 对账","Feishu/XWS 写入接入"]','["ledger adapter","commit/reconcile tests","provider reference"]','["GAP-IDEMPOTENCY-001"]','["外部成功但响应丢失；系统不支持原生幂等键。"]','["commit-before-response 只有一个业务效果或进入 UNKNOWN。"]','planned'),
('50000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001',3,'Skill Manifest、Registry 和 Loader','P0','支持动态发现、校验和扩展能力。','["manifest schema","registry index","loader","dependency/permission checks"]','["现有能力 manifests","registry command","loader contract tests"]','["GAP-SKILL-001"]','["版本漂移、循环依赖、动态路径逃逸。"]','["新增 Skill 无需修改核心 Runtime，错误 manifest 执行前失败。"]','planned'),
('50000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001',4,'Validator 和 Adapter 收敛','P1','降低业务流程重复和平台耦合。','["通用 validators","SYCM/XWS/Feishu adapters","错误分类统一"]','["validator package","adapter contracts","一条 SYCM/XWS 迁移"]','["GAP-VALIDATOR-001","GAP-ADAPTER-001"]','["抽象过度导致能力退化。"]','["Workflow 不依赖 DOM/API；迁移前后验收一致。"]','planned'),
('50000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001',5,'Memory 和 Context Compression','P1','支持长流程和跨会话恢复。','["记忆分层","作用域/来源/有效期","结构化摘要和完整性校验"]','["memory store","compression service","污染测试"]','["GAP-CONTEXT-001","GAP-COMPRESS-001","GAP-MEMORY-001"]','["摘要丢副作用；历史记忆污染当前事实。"]','["压缩可恢复同一 run/attempt，当前证据优先。"]','planned'),
('50000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001',6,'有限多 Agent 与高并发','P2','在资源容量证据基础上支持并行和 Agent 提案。','["proposal/tool schema","task queue/lease","resource lanes","backpressure/circuit breaker"]','["agent contract","concurrency tests","Temporal decision"]','["GAP-CHECKPOINT-001","GAP-IDEMPOTENCY-001","GAP-SKILL-002"]','["并发放大风控、额度和未知提交。"]','["同一资源无双写；重复消费无重复副作用；移除 Agent 仍可运行。"]','planned')
ON CONFLICT (review_id, phase_no) DO NOTHING;

INSERT INTO architecture.decisions (
  decision_id, review_id, decision_code, decision, rationale,
  alternatives_rejected, tradeoffs, status, effective_from
) VALUES
('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','ADR-001','采用确定性 SOP Runtime + Skill 插件 + 受限 Agent 提案层。','一致性、状态和外部副作用需要确定性代码；模型只适合语义判断。','["多 LLM 自主 swarm","Agent 直接拥有写权限"]','需要额外的 proposal/validator 边界，但可审计、可移除 Agent。','accepted','2026-09-13T00:00:00Z'),
('60000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','ADR-002','PostgreSQL 继续作为业务事实、运行索引、租约和幂等提交账本权威。','现有 XWS durable 状态、CAS cursor 和 supervisor 表已经在 PG；本地 JSON 不具备恢复可靠性。','["本地 JSON 作为恢复权威","Feishu 作为业务状态权威"]','需要继续维护迁移和查询合同。','accepted','2026-09-13T00:00:00Z'),
('60000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','ADR-003','Workflow 依赖 Capability/Skill，不直接依赖 DOM、target ID 或平台内部请求格式。','平台持续变化必须隔离在 Adapter；否则新平台模块会复制脆弱细节。','["Workflow 直接操作浏览器","Agent 自动修改 selector"]','Adapter 需要版本、probe 和 contract test。','accepted','2026-09-13T00:00:00Z'),
('60000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','ADR-004','所有外部写入、上传和付费调用必须登记稳定幂等键并支持 UNKNOWN 对账。','至少一次执行和 commit-before-response 无法通过调用次数保证单次业务效果。','["仅依赖进程内 Set","失败后盲目重试"]','部分平台需要业务唯一键和人工对账。','accepted','2026-09-13T00:00:00Z'),
('60000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','ADR-005','Skill 使用 manifest + Registry + Loader 动态挂载。','目录化 Skill 已有基础；机器合同能减少人工选择、版本漂移和依赖错误。','["硬编码 Skill 列表","任意路径动态加载"]','需要维护 manifest schema 和兼容性规则。','accepted','2026-09-13T00:00:00Z'),
('60000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','ADR-006','Context、Evidence、Memory、Commit 和 Architecture Catalog 分层存储。','不同数据的权威性、生命周期和恢复语义不同，混在一起会造成历史污染和误恢复。','["evidence 直接充当任务状态","单一万能 status 表"]','需要跨层引用和一致性检查。','accepted','2026-09-13T00:00:00Z'),
('60000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','ADR-007','多 Agent 调度和高并发后置到 Context、幂等、Registry 和故障注入稳定之后。','当前物理瓶颈是账号/profile/Proxy；增加 Agent 数量不能替代资源容量和恢复证据。','["先引入多个 Agent 框架","无故障注入直接扩容"]','短期并行速度较慢，但避免放大平台风控和副作用。','accepted','2026-09-13T00:00:00Z')
ON CONFLICT (review_id, decision_code) DO NOTHING;

INSERT INTO architecture.evidence_refs (
  evidence_ref_id, review_id, ref_type, ref_uri, label, confidence, notes
) VALUES
('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','file','docs/architecture/README.md','目标架构基线、权威数据分工和验收清单','verified','仓库架构入口。'),
('70000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','file','docs/standards/README.md','目录所有权、状态证据不变量和工程门禁','verified','跨模块工程规范。'),
('70000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','file','db/migrations/001-supervisor-tables.sql','Proposal、ActionIntent、Approval、CommitRecord 和 Experience 表','verified','现有 PostgreSQL 持久化。'),
('70000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','file','db/migrations/002-durable-run-tables.sql','Durable Run/Attempt 和 verified cursor 表','verified','现有耐久状态最小实现。'),
('70000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','file','agent-runtime/PROTOTYPE.md','Temporal fake adapter POC 边界和五项验收','verified','明确不能当生产 durable workflow。'),
('70000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','file','PROJECT-HANDOVER-ANALYSIS.md','当前模块规模、双向依赖和实现差距','observed','接手分析报告，需随代码演进复核。'),
('70000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','file','SUPERVISOR-AGENT-DESIGN.md','受限 Agent、Proposal、故障注入和迁移路线','observed','设计方案，不等同于已实现能力。'),
('70000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001','file','PROJECT-SYSTEM-DESIGN-ANALYSIS.md','第一性原理和入口调度方案','observed','设计分析，不等同于批准后的代码实现。')
ON CONFLICT (review_id, ref_uri) DO NOTHING;

