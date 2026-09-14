-- 004-rollback.sql
-- Rollback for 004-architecture-catalog.sql.
-- Only removes objects created by migration 004. Keep the schema itself so
-- later architecture catalog migrations are not deleted accidentally.

DROP TABLE IF EXISTS architecture.evidence_refs;
DROP TABLE IF EXISTS architecture.decisions;
DROP TABLE IF EXISTS architecture.phases;
DROP TABLE IF EXISTS architecture.gaps;
DROP TABLE IF EXISTS architecture.modules;
DROP TABLE IF EXISTS architecture.capabilities;
DROP TABLE IF EXISTS architecture.reviews;

