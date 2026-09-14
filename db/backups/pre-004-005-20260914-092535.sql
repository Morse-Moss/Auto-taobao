--
-- PostgreSQL database dump
--

\restrict KgAdhjf72DawRy0zjjMmqVSjwYFhGLSudq93ukT1zPf5KTmBqH4cgfuINtWnqG7

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

SET default_tablespace = '';

SET default_table_access_method = heap;

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
    CONSTRAINT durable_runs_execution_status_check CHECK ((execution_status = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'RETRY_WAIT'::text, 'PAUSED'::text, 'SUCCEEDED'::text, 'FAILED'::text])))
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
    CONSTRAINT supervisor_commit_records_status_check CHECK ((status = ANY (ARRAY['NOT_REQUESTED'::text, 'READY'::text, 'COMMITTING'::text, 'COMMITTED'::text, 'VERIFIED'::text, 'UNKNOWN'::text])))
);


--
-- Data for Name: durable_attempts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.durable_attempts (attempt_id, run_id, attempt_no, lease_owner, lease_state, lease_expires_at, status, started_at, ended_at, last_heartbeat_at) FROM stdin;
\.


--
-- Data for Name: durable_runs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.durable_runs (run_id, identity, execution_status, verified_cursor, cursor_version, target_end, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: supervisor_commit_records; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.supervisor_commit_records (id, commit_key, run_id, attempt_id, target, status, artifact_digest, created_at, verified_at) FROM stdin;
\.


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
-- Name: idx_durable_attempts_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_durable_attempts_run ON public.durable_attempts USING btree (run_id, attempt_no DESC);


--
-- Name: durable_attempts durable_attempts_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.durable_attempts
    ADD CONSTRAINT durable_attempts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.durable_runs(run_id);


--
-- PostgreSQL database dump complete
--

\unrestrict KgAdhjf72DawRy0zjjMmqVSjwYFhGLSudq93ukT1zPf5KTmBqH4cgfuINtWnqG7

