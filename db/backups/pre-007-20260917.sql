--
-- PostgreSQL database dump
--

\restrict sHyaDbyFVSS1suM8BMZiheFgYa3ljwjUX0G1Swm5Lk2qja9p7vxNIOfOgwA2oZg

-- Dumped from database version 17.10 (Debian 17.10-1.pgdg13+1)
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: architecture; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA architecture;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: capabilities; Type: TABLE; Schema: architecture; Owner: -
--

CREATE TABLE architecture.capabilities (
    capability_id uuid NOT NULL,
    review_id uuid NOT NULL,
    capability_code text NOT NULL,
    status text NOT NULL,
    current_implementation text NOT NULL,
    advantages text DEFAULT ''::text NOT NULL,
    gaps text DEFAULT ''::text NOT NULL,
    new_module_impact text DEFAULT ''::text NOT NULL,
    recommendations text DEFAULT ''::text NOT NULL,
    evidence_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    priority text NOT NULL,
    CONSTRAINT capabilities_priority_check CHECK ((priority = ANY (ARRAY['P0'::text, 'P1'::text, 'P2'::text]))),
    CONSTRAINT capabilities_status_check CHECK ((status = ANY (ARRAY['已具备'::text, '部分具备'::text, '缺失'::text])))
);


--
-- Name: decisions; Type: TABLE; Schema: architecture; Owner: -
--

CREATE TABLE architecture.decisions (
    decision_id uuid NOT NULL,
    review_id uuid NOT NULL,
    decision_code text NOT NULL,
    decision text NOT NULL,
    rationale text NOT NULL,
    alternatives_rejected jsonb DEFAULT '[]'::jsonb NOT NULL,
    tradeoffs text DEFAULT ''::text NOT NULL,
    status text NOT NULL,
    effective_from timestamp with time zone DEFAULT now() NOT NULL,
    superseded_by uuid,
    CONSTRAINT decisions_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'provisional'::text, 'superseded'::text])))
);


--
-- Name: evidence_refs; Type: TABLE; Schema: architecture; Owner: -
--

CREATE TABLE architecture.evidence_refs (
    evidence_ref_id uuid NOT NULL,
    review_id uuid NOT NULL,
    ref_type text NOT NULL,
    ref_uri text NOT NULL,
    label text NOT NULL,
    evidence_time timestamp with time zone,
    confidence text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    CONSTRAINT evidence_refs_confidence_check CHECK ((confidence = ANY (ARRAY['verified'::text, 'observed'::text, 'inferred'::text, 'unverified'::text]))),
    CONSTRAINT evidence_refs_ref_type_check CHECK ((ref_type = ANY (ARRAY['file'::text, 'run'::text, 'decision'::text, 'external_plan'::text, 'command_output'::text])))
);


--
-- Name: gaps; Type: TABLE; Schema: architecture; Owner: -
--

CREATE TABLE architecture.gaps (
    gap_id uuid NOT NULL,
    review_id uuid NOT NULL,
    gap_code text NOT NULL,
    gap_title text NOT NULL,
    current_evidence text NOT NULL,
    target_requirement text NOT NULL,
    severity text NOT NULL,
    priority text NOT NULL,
    proposed_action text NOT NULL,
    acceptance_criteria text NOT NULL,
    status text NOT NULL,
    owner_module text,
    depends_on jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT gaps_priority_check CHECK ((priority = ANY (ARRAY['P0'::text, 'P1'::text, 'P2'::text]))),
    CONSTRAINT gaps_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT gaps_status_check CHECK ((status = ANY (ARRAY['open'::text, 'planned'::text, 'in_progress'::text, 'done'::text, 'deferred'::text])))
);


--
-- Name: modules; Type: TABLE; Schema: architecture; Owner: -
--

CREATE TABLE architecture.modules (
    module_id uuid NOT NULL,
    review_id uuid NOT NULL,
    module_name text NOT NULL,
    module_layer text NOT NULL,
    current_state text NOT NULL,
    target_state text NOT NULL,
    change_type text NOT NULL,
    responsibility text NOT NULL,
    owns_state text DEFAULT ''::text NOT NULL,
    dependencies jsonb DEFAULT '[]'::jsonb NOT NULL,
    forbidden_dependencies jsonb DEFAULT '[]'::jsonb NOT NULL,
    risk text DEFAULT ''::text NOT NULL,
    priority text NOT NULL,
    CONSTRAINT modules_change_type_check CHECK ((change_type = ANY (ARRAY['retain'::text, 'add'::text, 'refactor'::text, 'replace'::text]))),
    CONSTRAINT modules_priority_check CHECK ((priority = ANY (ARRAY['P0'::text, 'P1'::text, 'P2'::text])))
);


--
-- Name: phases; Type: TABLE; Schema: architecture; Owner: -
--

CREATE TABLE architecture.phases (
    phase_id uuid NOT NULL,
    review_id uuid NOT NULL,
    phase_no integer NOT NULL,
    phase_name text NOT NULL,
    priority text NOT NULL,
    objective text NOT NULL,
    key_changes jsonb DEFAULT '[]'::jsonb NOT NULL,
    deliverables jsonb DEFAULT '[]'::jsonb NOT NULL,
    dependencies jsonb DEFAULT '[]'::jsonb NOT NULL,
    risks jsonb DEFAULT '[]'::jsonb NOT NULL,
    exit_criteria jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text NOT NULL,
    CONSTRAINT phases_priority_check CHECK ((priority = ANY (ARRAY['P0'::text, 'P1'::text, 'P2'::text]))),
    CONSTRAINT phases_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'in_progress'::text, 'done'::text, 'blocked'::text, 'deferred'::text])))
);


--
-- Name: reviews; Type: TABLE; Schema: architecture; Owner: -
--

CREATE TABLE architecture.reviews (
    review_id uuid NOT NULL,
    project_key text NOT NULL,
    review_version integer NOT NULL,
    review_scope text NOT NULL,
    conclusion_status text NOT NULL,
    can_start_simple_sop boolean DEFAULT false NOT NULL,
    can_start_multi_agent_sop boolean DEFAULT false NOT NULL,
    summary text NOT NULL,
    source_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    supersedes_review_id uuid,
    CONSTRAINT reviews_conclusion_status_check CHECK ((conclusion_status = ANY (ARRAY['complete'::text, 'partial'::text, 'incomplete'::text])))
);


--
-- Name: durable_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.durable_attempts (
    attempt_id text NOT NULL,
    run_id uuid NOT NULL,
    attempt_no integer NOT NULL,
    lease_owner text,
    lease_state text DEFAULT 'WAITING'::text NOT NULL,
    lease_expires_at timestamp with time zone,
    status text DEFAULT 'RUNNING'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    last_heartbeat_at timestamp with time zone,
    stage text,
    step_id text,
    failure_class text,
    result jsonb,
    CONSTRAINT durable_attempts_failure_class_check CHECK (((failure_class IS NULL) OR (failure_class = ANY (ARRAY['TRANSIENT_EXTERNAL'::text, 'RESOURCE_BUSY'::text, 'HUMAN_REQUIRED'::text, 'CAPABILITY_DEGRADED'::text, 'EVIDENCE_INVALID'::text, 'POLICY_DENIED'::text, 'COMMIT_UNKNOWN'::text, 'BUG'::text])))),
    CONSTRAINT durable_attempts_lease_state_check CHECK ((lease_state = ANY (ARRAY['WAITING'::text, 'HELD'::text, 'EXPIRED'::text, 'RELEASED'::text])))
);


--
-- Name: durable_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.durable_runs (
    run_id uuid NOT NULL,
    identity jsonb NOT NULL,
    execution_status text DEFAULT 'QUEUED'::text NOT NULL,
    verified_cursor integer DEFAULT 0 NOT NULL,
    cursor_version bigint DEFAULT 0 NOT NULL,
    target_end integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    task_id text,
    workflow text,
    capability text,
    stage text,
    step_id text,
    lane text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    context_version bigint DEFAULT 0 NOT NULL,
    evidence_status text DEFAULT 'NONE'::text NOT NULL,
    human_gate_status text DEFAULT 'NONE'::text NOT NULL,
    publication_status text DEFAULT 'NOT_REQUESTED'::text NOT NULL,
    blocker jsonb,
    next_action text,
    retry_used jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT durable_runs_evidence_status_check CHECK ((evidence_status = ANY (ARRAY['NONE'::text, 'CANDIDATE'::text, 'VALIDATED'::text, 'REJECTED'::text]))),
    CONSTRAINT durable_runs_execution_status_check CHECK ((execution_status = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'RETRY_WAIT'::text, 'PAUSED'::text, 'SUCCEEDED'::text, 'FAILED'::text]))),
    CONSTRAINT durable_runs_human_gate_status_check CHECK ((human_gate_status = ANY (ARRAY['NONE'::text, 'WAITING_HUMAN'::text, 'APPROVED'::text, 'DENIED'::text, 'EXPIRED'::text]))),
    CONSTRAINT durable_runs_publication_status_check CHECK ((publication_status = ANY (ARRAY['NOT_REQUESTED'::text, 'READY'::text, 'COMMITTED'::text, 'VERIFIED'::text, 'UNKNOWN'::text])))
);


--
-- Name: supervisor_action_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supervisor_action_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intent_key text NOT NULL,
    proposal_id uuid,
    run_id uuid NOT NULL,
    attempt_id text,
    action text NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    policy_decision text NOT NULL,
    idempotency_key text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    executed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT supervisor_action_intents_policy_decision_check CHECK ((policy_decision = ANY (ARRAY['APPROVED'::text, 'HUMAN_REQUIRED'::text, 'DENIED'::text])))
);


--
-- Name: supervisor_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supervisor_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intent_id uuid,
    run_id uuid NOT NULL,
    decision text NOT NULL,
    operator text NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    note text,
    CONSTRAINT supervisor_approvals_decision_check CHECK ((decision = ANY (ARRAY['APPROVED'::text, 'DENIED'::text, 'EXPIRED'::text])))
);


--
-- Name: supervisor_commit_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supervisor_commit_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    commit_key text NOT NULL,
    run_id uuid NOT NULL,
    attempt_id text,
    target text NOT NULL,
    status text DEFAULT 'READY'::text NOT NULL,
    artifact_digest text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    business_key text,
    provider_ref text,
    CONSTRAINT supervisor_commit_records_status_check CHECK ((status = ANY (ARRAY['NOT_REQUESTED'::text, 'READY'::text, 'COMMITTING'::text, 'COMMITTED'::text, 'VERIFIED'::text, 'UNKNOWN'::text, 'FAILED'::text])))
);


--
-- Name: supervisor_experience; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supervisor_experience (
    id text NOT NULL,
    signature jsonb NOT NULL,
    symptom text,
    root_cause text,
    remedy text,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    evidence_digest text,
    capability_version text,
    env_fingerprint text,
    confidence real DEFAULT 0.5 NOT NULL,
    occurrences integer DEFAULT 0 NOT NULL,
    retired boolean DEFAULT false NOT NULL,
    needs_review boolean DEFAULT false NOT NULL,
    history jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supervisor_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supervisor_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    proposal_key text NOT NULL,
    run_id uuid NOT NULL,
    step_id text,
    attempt_id text,
    task_type text NOT NULL,
    schema_version text DEFAULT 'agent-proposal-v1'::text NOT NULL,
    prompt_version text NOT NULL,
    model text NOT NULL,
    model_version text,
    risk_class text NOT NULL,
    requested_action text NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    evidence_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    reason text,
    confidence real,
    expires_at timestamp with time zone NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    rejection_reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT supervisor_proposals_risk_class_check CHECK ((risk_class = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text, 'HUMAN_REQUIRED'::text]))),
    CONSTRAINT supervisor_proposals_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'VALIDATED'::text, 'REJECTED'::text, 'APPROVED'::text, 'EXPIRED'::text])))
);


--
-- Name: xws_adaptive_manifests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.xws_adaptive_manifests (
    run_id uuid NOT NULL,
    artifact_kind text NOT NULL,
    path text NOT NULL,
    sha256 text NOT NULL,
    size_bytes bigint NOT NULL,
    metadata jsonb NOT NULL
);


--
-- Name: xws_adaptive_parts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.xws_adaptive_parts (
    run_id uuid NOT NULL,
    part_id text NOT NULL,
    start_page integer NOT NULL,
    end_page integer NOT NULL,
    completed_end integer NOT NULL,
    status text NOT NULL,
    metadata jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: xws_adaptive_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.xws_adaptive_runs (
    id uuid NOT NULL,
    lock_key bigint NOT NULL,
    identity jsonb NOT NULL,
    identity_hash text NOT NULL,
    pages_start integer NOT NULL,
    pages_end integer NOT NULL,
    completed_end integer NOT NULL,
    status text DEFAULT 'RUNNING'::text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    checkpoint jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: capabilities capabilities_pkey; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.capabilities
    ADD CONSTRAINT capabilities_pkey PRIMARY KEY (capability_id);


--
-- Name: capabilities capabilities_review_id_capability_code_key; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.capabilities
    ADD CONSTRAINT capabilities_review_id_capability_code_key UNIQUE (review_id, capability_code);


--
-- Name: decisions decisions_pkey; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.decisions
    ADD CONSTRAINT decisions_pkey PRIMARY KEY (decision_id);


--
-- Name: decisions decisions_review_id_decision_code_key; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.decisions
    ADD CONSTRAINT decisions_review_id_decision_code_key UNIQUE (review_id, decision_code);


--
-- Name: evidence_refs evidence_refs_pkey; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.evidence_refs
    ADD CONSTRAINT evidence_refs_pkey PRIMARY KEY (evidence_ref_id);


--
-- Name: evidence_refs evidence_refs_review_id_ref_uri_key; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.evidence_refs
    ADD CONSTRAINT evidence_refs_review_id_ref_uri_key UNIQUE (review_id, ref_uri);


--
-- Name: gaps gaps_pkey; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.gaps
    ADD CONSTRAINT gaps_pkey PRIMARY KEY (gap_id);


--
-- Name: gaps gaps_review_id_gap_code_key; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.gaps
    ADD CONSTRAINT gaps_review_id_gap_code_key UNIQUE (review_id, gap_code);


--
-- Name: modules modules_pkey; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.modules
    ADD CONSTRAINT modules_pkey PRIMARY KEY (module_id);


--
-- Name: modules modules_review_id_module_name_key; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.modules
    ADD CONSTRAINT modules_review_id_module_name_key UNIQUE (review_id, module_name);


--
-- Name: phases phases_pkey; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.phases
    ADD CONSTRAINT phases_pkey PRIMARY KEY (phase_id);


--
-- Name: phases phases_review_id_phase_no_key; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.phases
    ADD CONSTRAINT phases_review_id_phase_no_key UNIQUE (review_id, phase_no);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (review_id);


--
-- Name: reviews reviews_project_key_review_version_key; Type: CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.reviews
    ADD CONSTRAINT reviews_project_key_review_version_key UNIQUE (project_key, review_version);


--
-- Name: durable_attempts durable_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_attempts
    ADD CONSTRAINT durable_attempts_pkey PRIMARY KEY (attempt_id);


--
-- Name: durable_runs durable_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_runs
    ADD CONSTRAINT durable_runs_pkey PRIMARY KEY (run_id);


--
-- Name: supervisor_action_intents supervisor_action_intents_intent_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_action_intents
    ADD CONSTRAINT supervisor_action_intents_intent_key_key UNIQUE (intent_key);


--
-- Name: supervisor_action_intents supervisor_action_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_action_intents
    ADD CONSTRAINT supervisor_action_intents_pkey PRIMARY KEY (id);


--
-- Name: supervisor_approvals supervisor_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_approvals
    ADD CONSTRAINT supervisor_approvals_pkey PRIMARY KEY (id);


--
-- Name: supervisor_commit_records supervisor_commit_records_commit_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_commit_records
    ADD CONSTRAINT supervisor_commit_records_commit_key_key UNIQUE (commit_key);


--
-- Name: supervisor_commit_records supervisor_commit_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_commit_records
    ADD CONSTRAINT supervisor_commit_records_pkey PRIMARY KEY (id);


--
-- Name: supervisor_experience supervisor_experience_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_experience
    ADD CONSTRAINT supervisor_experience_pkey PRIMARY KEY (id);


--
-- Name: supervisor_proposals supervisor_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_proposals
    ADD CONSTRAINT supervisor_proposals_pkey PRIMARY KEY (id);


--
-- Name: supervisor_proposals supervisor_proposals_proposal_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_proposals
    ADD CONSTRAINT supervisor_proposals_proposal_key_key UNIQUE (proposal_key);


--
-- Name: xws_adaptive_manifests xws_adaptive_manifests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xws_adaptive_manifests
    ADD CONSTRAINT xws_adaptive_manifests_pkey PRIMARY KEY (run_id, artifact_kind, path);


--
-- Name: xws_adaptive_parts xws_adaptive_parts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xws_adaptive_parts
    ADD CONSTRAINT xws_adaptive_parts_pkey PRIMARY KEY (run_id, part_id);


--
-- Name: xws_adaptive_runs xws_adaptive_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xws_adaptive_runs
    ADD CONSTRAINT xws_adaptive_runs_pkey PRIMARY KEY (id);


--
-- Name: idx_arch_capabilities_priority; Type: INDEX; Schema: architecture; Owner: -
--

CREATE INDEX idx_arch_capabilities_priority ON architecture.capabilities USING btree (priority, status);


--
-- Name: idx_arch_evidence_type; Type: INDEX; Schema: architecture; Owner: -
--

CREATE INDEX idx_arch_evidence_type ON architecture.evidence_refs USING btree (ref_type, confidence);


--
-- Name: idx_arch_gaps_open_priority; Type: INDEX; Schema: architecture; Owner: -
--

CREATE INDEX idx_arch_gaps_open_priority ON architecture.gaps USING btree (priority, status) WHERE (status <> 'done'::text);


--
-- Name: idx_arch_modules_layer; Type: INDEX; Schema: architecture; Owner: -
--

CREATE INDEX idx_arch_modules_layer ON architecture.modules USING btree (module_layer, priority);


--
-- Name: idx_arch_phases_status; Type: INDEX; Schema: architecture; Owner: -
--

CREATE INDEX idx_arch_phases_status ON architecture.phases USING btree (status, priority);


--
-- Name: idx_arch_reviews_project; Type: INDEX; Schema: architecture; Owner: -
--

CREATE INDEX idx_arch_reviews_project ON architecture.reviews USING btree (project_key, review_version DESC);


--
-- Name: idx_commit_records_unknown; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commit_records_unknown ON public.supervisor_commit_records USING btree (commit_key) WHERE (status = 'UNKNOWN'::text);


--
-- Name: idx_durable_attempts_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_durable_attempts_run ON public.durable_attempts USING btree (run_id, attempt_no DESC);


--
-- Name: idx_durable_runs_lane_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_durable_runs_lane_active ON public.durable_runs USING btree (lane) WHERE (execution_status = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'RETRY_WAIT'::text, 'PAUSED'::text]));


--
-- Name: idx_durable_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_durable_runs_status ON public.durable_runs USING btree (execution_status, updated_at DESC);


--
-- Name: idx_supervisor_intents_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supervisor_intents_run ON public.supervisor_action_intents USING btree (run_id, created_at DESC);


--
-- Name: idx_supervisor_proposals_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supervisor_proposals_run ON public.supervisor_proposals USING btree (run_id, created_at DESC);


--
-- Name: capabilities capabilities_review_id_fkey; Type: FK CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.capabilities
    ADD CONSTRAINT capabilities_review_id_fkey FOREIGN KEY (review_id) REFERENCES architecture.reviews(review_id) ON DELETE CASCADE;


--
-- Name: decisions decisions_review_id_fkey; Type: FK CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.decisions
    ADD CONSTRAINT decisions_review_id_fkey FOREIGN KEY (review_id) REFERENCES architecture.reviews(review_id) ON DELETE CASCADE;


--
-- Name: decisions decisions_superseded_by_fkey; Type: FK CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.decisions
    ADD CONSTRAINT decisions_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES architecture.decisions(decision_id);


--
-- Name: evidence_refs evidence_refs_review_id_fkey; Type: FK CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.evidence_refs
    ADD CONSTRAINT evidence_refs_review_id_fkey FOREIGN KEY (review_id) REFERENCES architecture.reviews(review_id) ON DELETE CASCADE;


--
-- Name: gaps gaps_review_id_fkey; Type: FK CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.gaps
    ADD CONSTRAINT gaps_review_id_fkey FOREIGN KEY (review_id) REFERENCES architecture.reviews(review_id) ON DELETE CASCADE;


--
-- Name: modules modules_review_id_fkey; Type: FK CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.modules
    ADD CONSTRAINT modules_review_id_fkey FOREIGN KEY (review_id) REFERENCES architecture.reviews(review_id) ON DELETE CASCADE;


--
-- Name: phases phases_review_id_fkey; Type: FK CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.phases
    ADD CONSTRAINT phases_review_id_fkey FOREIGN KEY (review_id) REFERENCES architecture.reviews(review_id) ON DELETE CASCADE;


--
-- Name: reviews reviews_supersedes_review_id_fkey; Type: FK CONSTRAINT; Schema: architecture; Owner: -
--

ALTER TABLE ONLY architecture.reviews
    ADD CONSTRAINT reviews_supersedes_review_id_fkey FOREIGN KEY (supersedes_review_id) REFERENCES architecture.reviews(review_id);


--
-- Name: durable_attempts durable_attempts_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_attempts
    ADD CONSTRAINT durable_attempts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.durable_runs(run_id);


--
-- Name: supervisor_action_intents supervisor_action_intents_proposal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_action_intents
    ADD CONSTRAINT supervisor_action_intents_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES public.supervisor_proposals(id);


--
-- Name: supervisor_approvals supervisor_approvals_intent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_approvals
    ADD CONSTRAINT supervisor_approvals_intent_id_fkey FOREIGN KEY (intent_id) REFERENCES public.supervisor_action_intents(id);


--
-- Name: xws_adaptive_manifests xws_adaptive_manifests_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xws_adaptive_manifests
    ADD CONSTRAINT xws_adaptive_manifests_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.xws_adaptive_runs(id) ON DELETE CASCADE;


--
-- Name: xws_adaptive_parts xws_adaptive_parts_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xws_adaptive_parts
    ADD CONSTRAINT xws_adaptive_parts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.xws_adaptive_runs(id) ON DELETE CASCADE;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT ALL ON SCHEMA public TO xws_agent;


--
-- Name: TABLE xws_adaptive_manifests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.xws_adaptive_manifests TO xws_agent;


--
-- Name: TABLE xws_adaptive_parts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.xws_adaptive_parts TO xws_agent;


--
-- Name: TABLE xws_adaptive_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.xws_adaptive_runs TO xws_agent;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE xws_runner IN SCHEMA public GRANT ALL ON SEQUENCES TO xws_agent;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE xws_runner IN SCHEMA public GRANT ALL ON TABLES TO xws_agent;


--
-- PostgreSQL database dump complete
--

\unrestrict sHyaDbyFVSS1suM8BMZiheFgYa3ljwjUX0G1Swm5Lk2qja9p7vxNIOfOgwA2oZg

