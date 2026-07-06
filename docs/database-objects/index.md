# Objects sluice creates in your databases

> The full inventory of sluice's bookkeeping tables, slots, publications, and triggers — what each is for, when it appears, and how to remove it.

To make migrations resumable and continuous sync durable, sluice creates a small, predictable set of bookkeeping objects in your source and target databases. Every one is prefixed sluice_ so you can always find them, and the schema readers exclude them from schema diff and verify (ADR-0029) so they never register as drift or count against a row comparison. Nothing here is hidden — this page is the complete list of what sluice writes, which command writes it, why, and how to clean it up.

Where they live. On Postgres targets the bookkeeping tables are created in the target DSN's schema parameter (default public) — they follow --target-schema, they are not hardcoded to public. On MySQL targets they live in the connection's default database. The source-side object names (sluice_slot, sluice_pub, sluice_heartbeat) are defaults and all overridable. Every object below is created idempotently (IF NOT EXISTS / CREATE OR REPLACE), so a re-run never errors on an existing one.

## Target database — bookkeeping tables

These hold the state that makes migrate --resume and sync start warm-resume work. They persist between runs by design (that's the durable resume frontier); the only built-in way to drop them is the destructive --reset-target-data recovery path, which clears the relevant state and the tables sluice manages.

Object · Created by · When & why · Cleaned up by ·

sluice_cdc_state · sync start · At CDC stream open. One row per --stream-id: the durable CDC source position, slot name, source-DSN fingerprint, and stop flag — the warm-resume frontier. · --reset-target-data (clears the row); otherwise persists. ·

sluice_migrate_state · migrate · At bulk-copy start. One header row per --migration-id for resumable bulk migration (ADR-0082). · --reset-target-data; otherwise persists. ·

sluice_migrate_table_progress · migrate · At bulk-copy start. One row per table — per-table progress / keyset checkpoint so --resume picks up mid-copy (ADR-0082). · --reset-target-data; otherwise persists. ·

sluice_cdc_schema_history · sync start · At CDC stream open; rows written only at a real DDL/schema-delta boundary. Position-anchored schema versions so each event decodes in the schema in effect at its position — resume-after-DDL without a re-snapshot (ADR-0049). Grows with DDL count (tiny). · Compacted on demand below the retention floor by backup prune; --reset-target-data. ·

sluice_target_metrics_history · sync start (telemetry only) · Only when PlanetScale telemetry is configured (--planetscale-org). A bounded rolling history of polled target-health snapshots (CPU/mem/storage/lag) so diagnose can show the recent trend (ADR-0107). Advisory — never affects the sync. · Rows auto-pruned to a rolling window; table via --reset-target-data. Disable with --suppress-target-metrics-history. ·

sluice_shard_consolidation_lease · sync start (consolidation only) · Only when consolidating a multi-shard Vitess/PlanetScale source onto one target with cross-shard DDL coordination (ADR-0054). One row per consolidated table records which shard-stream owns applying a coordinated DDL. · Lease rows GC-swept automatically; table via --reset-target-data. ·

--reset-target-data is destructive: it clears the relevant state row(s) and drops every source-schema table sluice manages on that target, then cold-starts. Other tables on the target are untouched. See the migrate reference and ADR-0023.

## Source database — Postgres logical CDC

The native postgres CDC engine reads the WAL through a logical replication slot. It creates two persistent server objects plus two optional/transient ones. Full operational detail — failover, slot invalidation, sizing — is in the Postgres source-prep guide.

Object · Kind · When & why · Cleaned up by ·

sluice_slot · replication slot · Created lazily on the first CDC connect (cold-start). Pins WAL and holds the resume LSN (confirmed_flush_lsn). pgoutput plugin; failover-aware on PG 17+. · Never auto-dropped — explicit sluice slot drop <name>. (Auto-dropped only if cold-start setup itself fails.) ·

sluice_pub · publication · Ensured on demand when missing, by migrate and sync start. Defines the table set pgoutput streams — scoped FOR TABLE … by default (ADR-0021), FOR ALL TABLES for multi-schema CDC. · No dedicated command — manual DROP PUBLICATION (a DROP SCHEMA won't remove it). sluice rescopes/recreates it itself. ·

sluice_heartbeat · table · Opt-in via --source-heartbeat-interval (default off). A periodic INSERT generates WAL so the consumer position keeps advancing on an idle source — preventing slot-invalidation / binlog-purge silent loss. Also created on a MySQL source under the same flag. · Rows auto-pruned (--source-heartbeat-prune-window, default 1h); the table itself is left in place — drop manually. ·

sluice_backup_anchor_<ts> · temporary slot · Created by backup at snapshot start to pin a consistent export point for the run. · Transient — the server auto-drops it when the session closes (even on crash). Legacy leaked anchors are auto-swept on the next backup. ·

MySQL source: native MySQL CDC reads the binlog and creates nothing on the source except the opt-in sluice_heartbeat table above — there is no slot or publication concept.

## Source database — trigger-based CDC

The slot-less trigger engines capture changes with database triggers instead of a log stream. trigger setup installs every object below; trigger teardown removes all of them (pass --keep-data to retain the change-log for forensics), and trigger prune reaps applied change-log rows. They live in the source schema (--schema, default public on Postgres).

### Postgres trigger engine (postgres-trigger, ADR-0066)

Object · Kind · Why ·

sluice_change_log + sluice_change_log_meta · tables (+ indexes) · Append-only captured-change log (txid, op, PK + before/after JSONB) and a singleton schema-version pin. ·

sluice_capture_change(), sluice_capture_truncate_fn(), sluice_capture_ddl() · functions · Row-capture (payload mode set by --capture-payload), TRUNCATE companion, and the DDL event-trigger handler. ·

sluice_capture, sluice_capture_truncate (per table); sluice_capture_ddl_trg · triggers · One combined AFTER INSERT/UPDATE/DELETE trigger and a TRUNCATE trigger per table, plus one cluster DDL event trigger. ·

### SQLite / Cloudflare-D1 trigger engines (sqlite-trigger / d1-trigger, ADR-0135/0136)

Object · Kind · Why ·

sluice_change_log + sluice_change_log_meta · tables · Captured-change log with a monotonic id watermark, and a schema-version pin. ·

sluice_change_log_columns · table · Captured-column fingerprint — since SQLite/D1 have no DDL triggers, a source ALTER is caught here and sync start refuses loudly rather than dropping a new column silently. ·

sluice_capture_<table>_<ins|upd|del> · triggers · Three per table (SQLite has no combined-event trigger form), each writing into the change-log. ·

The two families differ in trigger naming: postgres-trigger uses one combined trigger literally named sluice_capture per table, whereas sqlite-trigger/d1-trigger use three separate sluice_capture_<table>_<op> triggers. Both are fully removed by trigger teardown.

## Cleanup quick reference

Command · Removes ·

sluice slot drop <name> · The PG source replication slot (the one object sluice never drops on its own). ·

sluice trigger teardown · Every trigger-engine object on the source; --keep-data retains the change-log. ·

sluice trigger prune / backup prune · Old change-log rows / below-floor sluice_cdc_schema_history rows (the tables stay). ·

sluice sync start --reset-target-data · The target bookkeeping state + every source-schema table sluice manages on the target (destructive recovery). ·

manual · sluice_pub (DROP PUBLICATION), and the sluice_heartbeat table once heartbeats are no longer needed. ·

---
Canonical page: https://sluicesync.com/docs/database-objects/ · Full docs index: https://sluicesync.com/llms.txt
