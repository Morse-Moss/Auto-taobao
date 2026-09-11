# Agent runtime prototype rules

Scope: backend first. No user frontend in this stage.

Structure:
- `temporal/`: workflow and activity prototypes. Current browser, commit and lease activities are fake adapters.
- `tests/`: local contract and Temporal integration tests.
- `run-local-task.mjs`: temporary Temporal server demonstration only, not a real XWS entrypoint.
- `local-vertical-slice.mjs`: in-memory demonstration, not crash recovery evidence.
- Generated test state must live in an OS temporary directory unique to each test. Clean it after owned workers and server exit; retain explicit failure evidence when needed. Never place credentials or live collection artifacts here.

Acceptance before real XWS use:
1. Independent worker process termination and recovery, with persisted side-effect receipts.
2. Duplicate invocation after commit-before-response failure produces exactly one persisted effect.
3. Human gates survive worker replacement and reject invalid resume decisions.
4. Actual Agent runtime invocation with restricted tools and validated proposals; hardcoded decisions do not count as Agents.
5. Real CSV/XLSX validation, authoritative PostgreSQL cursor and resource ownership integration.

No fake task result proves real page completion. Real resume must read PostgreSQL authority and continue the authorized existing run from page 21 only when completedEnd is 20. No Feishu writes, credential-file reads, trial activation, browser tab closure, git commit or push are authorized by this stage.

Temporal worker replacement within one Node process is not a process-crash test. In-memory Temporal test-server state does not prove server restart durability. SDK tool handler calls and JavaScript resume option objects do not prove model execution or session recovery.
