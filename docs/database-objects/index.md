<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# Objects sluice creates in your databases

> The full inventory of sluice's bookkeeping tables, slots, publications, and triggers — what each is for, when it appears, and how to remove it.

To make migrations resumable and continuous sync durable, sluice creates a small, predictable set of bookkeeping objects in your source and target databases. Every one is prefixed sluice_ so you can always find them, and the schema readers exclude them from schema diff and verify (ADR-0029) so they never register as drift or count against a row comparison. Nothing here is hidden — this page is the complete list of what sluice writes, which command writes it, why, and how to clean it up.

Where they live. On Postgres targets the bookkeeping tables are created in the target DSN's schema parameter (default public) — they follow --target-schema, they are not hardcoded to public. On MySQL targets they live in the connection's default database. The source-side object names (sluice_slot, sluice_pub, sluice_heartbeat) are defaults and all overridable. Every object below is created idempotently (IF NOT EXISTS / CREATE OR REPLACE), so a re-run never errors on an existing one.

## Target database — bookkeeping tables

These hold the state that makes migrate --resume and sync start warm-resume work. They persist between runs by design (that's the durable resume frontier); the only built-in way to drop them is the destructive --reset-target-data recovery path, which clears the relevant state and the tables sluice manages.

Object · Created by · When & why · Cleaned up by ·

sluice_cdc_state · sync start · At CDC stream open. One row per --stream-id: the durable CDC source position, slot name, source-DSN fingerprint, and stop flag — the warm-resume frontier. Since v0.156.0 also a recorded UNFORWARDED-SCHEMA-CHANGE refusal (column unforwarded_refusal, TEXT NULL), which every later start replays until --accept-unforwarded-schema-change clears it. The column is added on the next start after upgrading; a PlanetScale safe-migrations target or a Postgres role that does not own the table must add it by hand. · --reset-target-data (clears the row); otherwise persists. ·

sluice_migrate_state · migrate · At bulk-copy start. One header row per --migration-id for resumable bulk migration (ADR-0082). · --reset-target-data; otherwise persists. ·

sluice_migrate_table_progress · migrate · At bulk-copy start. One row per table — per-table progress / keyset checkpoint so --resume picks up mid-copy (ADR-0082). · --reset-target-data; otherwise persists. ·

sluice_cdc_schema_history · sync start · At CDC stream open; rows written only at a real DDL/schema-delta boundary. Position-anchored schema versions so each event decodes in the schema in effect at its position — resume-after-DDL without a re-snapshot (ADR-0049). Grows with DDL count (tiny). · Compacted on demand below the retention floor by backup prune; --reset-target-data. ·

sluice_target_metrics_history · sync start (telemetry only) · Only when PlanetScale telemetry is configured (--planetscale-org). A bounded rolling history of polled target-health snapshots (CPU/mem/storage/lag) so diagnose can show the recent trend (ADR-0107). Advisory — never affects the sync. · Rows auto-pruned to a rolling window; table via --reset-target-data. Disable with --suppress-target-metrics-history. ·

sluice_shard_consolidation_lease · sync start (consolidation only) · Only when consolidating a multi-shard Vitess/PlanetScale source onto one target with cross-shard DDL coordination (ADR-0054). One row per consolidated table records which shard-stream owns applying a coordinated DDL. · Lease rows GC-swept automatically; table via --reset-target-data. ·

sluice_cdc_skipped_tables · sync start (MySQL and Postgres targets) · At CDC stream open. One row per (stream, table) the stream carried changes for but the target does not have: a cumulative skip count plus the first and last skipped position tokens (v0.123.0). Rendered by sync status and the sync stop summary; sync health exits 1 while any count is nonzero. See sync start. · Persists — no built-in cleanup, including --reset-target-data. Delete a stream's rows by hand once its skips are resolved. ·

sluice_cdc_apply_marks · sync start, sync from-backup (MySQL and Postgres targets) · Alongside sluice_cdc_state, only when absent (v0.156.5, ADR-0190). One row per marked key: which source transaction and position within it last wrote that key, written in the same target transaction as the row itself, so a restart after a crash in the middle of a source transaction can tell which of its changes already landed (how it works). A transaction's marks are deleted by the same target transaction that persists a position past it. If it cannot be created or used, the stream logs APPLY-MARKS-UNAVAILABLE and runs without marks — on a Postgres target as well since v0.156.6 (on v0.156.5 a role without CREATE on the control schema, or one that did not own sluice_cdc_state, stopped the start first). To create it where sluice's role cannot, run the statements control-tables ddl --engine <target engine> prints as a role that can (on a PlanetScale safe-migrations branch, through deploy-ddl). · Rows auto-cleared: as the position passes their transaction, at every cold start, and by --reset-target-data. The table stays in place. ·

sluice_cdc_query_timeout_raise · sync start (MySQL-family targets) · Created at CDC stream open alongside sluice_cdc_state; a row is written only when --planetscale-raise-query-timeout raises the keyspace's query timeout for the cold-start copy (ADR-0182). It records the previous value, keyed by stream-id, so the timeout is restored even after a crash; the row is deleted on revert. · Row deleted when the timeout is restored; the table stays in place. ·

Keyset store. sluice_keysets is not created on the migration target unless you point it there: it lives wherever a --keyset-source=db:<dsn> points (MySQL or Postgres), and is created there if absent. It holds the named, generation-versioned HMAC / tokenize keys for PII redaction (ADR-0041), shared across streams. sluice never drops it — rotating or retiring a key is a row operation you own.

### Running with a DML-only role on Postgres (CONTROL-TABLE-DDL-REQUIRED)

Since v0.156.6 every Postgres control-table ensure reads the catalog first and runs only the CREATE, ADD COLUMN, CREATE INDEX or UTC-default statement whose object is actually missing, so a current target sees no DDL at all. Once the owner has pre-created the tables — sluice control-tables ddl --engine postgres prints the whole idempotent set — a sync role holding only SELECT, INSERT, UPDATE and DELETE on them, plus USAGE on the control schema, starts and streams. (Through v0.156.5 every start ran CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS; PostgreSQL checks schema CREATE and table ownership before it looks at IF NOT EXISTS, so the role had to own the tables.) The same detect-first rule now applies to the MySQL family's sluice_keysets, sluice_target_metrics_history and heartbeat ensures.

DDL that is genuinely needed and that the role cannot run still stops the start, marked CONTROL-TABLE-DDL-REQUIRED. The error names the missing table, column or index and, where a statement fixes it, that exact statement, and is worded from the actual cause:

- Table absent on a path that never creates control tables (the --schema-already-applied refusal-record door): have the owner create it with the named statement, or apply the full printed set.

- 42501 (insufficient privilege): run the statement as the table's owner or a role with CREATE on the schema, or apply the full printed set.

- 3F000: the control schema itself does not exist — check the target DSN's schema= parameter, or create the schema.

- Any other failure (a lock timeout, say): the raw cause and the statement, with no claim about privileges.

A role without USAGE on the control schema cannot even look the tables up; that start fails with an error saying exactly that and naming the GRANT USAGE ON SCHEMA … TO <role> to run.

Legacy migrate-state DEFAULTs on a non-UTC session. sluice_migrate_state / sluice_migrate_table_progress tables created before v0.99.263 default started_at / updated_at to CURRENT_TIMESTAMP, which stores the session zone's local time. sluice now re-points those defaults with ALTER TABLE … ALTER COLUMN … SET DEFAULT (pg_catalog.timezone('utc', pg_catalog.now())). If the connecting role may not alter the table and its session TimeZone is not UTC all year (a zone like Europe/London, UTC only in winter, counts as not UTC), sluice refuses with CONTROL-TABLE-DDL-REQUIRED, naming the column and the statement: migrate and backfill stop, while a sync cold start only disables cold-start progress recording with a WARN (the copy proceeds, but sync status shows the stream as absent until the CDC anchor is written). On a UTC session the same role gets a WARN and runs. Remedy: have the table owner run the printed statements once (sluice control-tables ddl --engine postgres, or just its ALTER COLUMN … SET DEFAULT lines), or run sluice once as the owner, which applies them automatically.

--reset-target-data is destructive: it clears the relevant state row(s) and drops every source-schema table sluice manages on that target, then cold-starts. Other tables on the target are untouched. See the migrate reference and ADR-0023.

## Source database — Postgres logical CDC

The native postgres CDC engine reads the WAL through a logical replication slot. It creates two persistent server objects plus two optional/transient ones. Full operational detail — failover, slot invalidation, sizing — is in the Postgres source-prep guide.

Object · Kind · When & why · Cleaned up by ·

sluice_slot · replication slot · Created lazily on the first CDC connect (cold-start). Pins WAL and holds the resume LSN (confirmed_flush_lsn). pgoutput plugin; failover-aware on PG 17+. · Never auto-dropped — explicit sluice slot drop <name>. (Auto-dropped only if cold-start setup itself fails.) ·

sluice_pub · publication · Ensured on demand when missing, by migrate and sync start. Defines the table set pgoutput streams — scoped FOR TABLE … by default (ADR-0021), FOR ALL TABLES for multi-schema CDC. A MISSING publication is recreated at every stream open, warm resume included, and when no table scope is supplied it comes back FOR ALL TABLES — so dropping it by hand and resuming can silently widen a scoped stream to the whole database. The scope-conflict refusal does not catch this: it guards a rescope that REMOVES tables, not a create-from-absent. · No dedicated command — manual DROP PUBLICATION (a DROP SCHEMA won't remove it). sluice rescopes/recreates it itself. ·

sluice_heartbeat · table · Opt-in via --source-heartbeat-interval (default off). A periodic INSERT generates WAL so the consumer position keeps advancing on an idle source — preventing slot-invalidation / binlog-purge silent loss. Also created on a MySQL source under the same flag. Since v0.156.6 the ensure detects the table first, so a source role holding only INSERT / DELETE on a table an owner pre-created writes heartbeats; on Postgres that role also needs USAGE on the table's id sequence (BIGSERIAL, normally sluice_heartbeat_id_seq). Without it sluice WARNs at startup naming the GRANT USAGE ON SEQUENCE to run and writes no heartbeats, so idle-source protection is off for that stream. · Rows auto-pruned (--source-heartbeat-prune-window, default 1h); the table itself is left in place — drop manually. ·

sluice_backup_anchor_<ts> · temporary slot · Created by backup at snapshot start to pin a consistent export point for the run. · Transient — the server auto-drops it when the session closes (even on crash). Legacy leaked anchors are auto-swept on the next backup. ·

MySQL source: native MySQL CDC reads the binlog and creates nothing on the source except the opt-in sluice_heartbeat table above — there is no slot or publication concept.

## Source database — trigger-based CDC

The slot-less trigger engines capture changes with database triggers instead of a log stream. trigger setup installs every object below; trigger teardown removes all of them (pass --keep-data to retain the change-log for forensics), and trigger prune reaps applied change-log rows. They live in the source schema (--schema, default public on Postgres).

### Postgres trigger engine (postgres-trigger, ADR-0066)

Object · Kind · Why ·

sluice_change_log + sluice_change_log_meta · tables (+ indexes) · Append-only captured-change log (txid, op, PK + before/after JSONB) and a singleton per-install record. The meta table started as a bare schema-version pin and has since grown the rest of the install's identity: the capture_replicated_writes posture (v3, ADR-0185), the three setup-evidence columns the DDL-suppression privilege boundary is bound to (v4 &mdash; the firing backend's PID, a nonce, and a timestamp, armed and disarmed inside setup's own transaction), and capture_fn_digest (v5), the provenance that lets a CDC open tell an old capture function from an edited one. Every column is added by ADD COLUMN IF NOT EXISTS, so re-running trigger setup is the migration and older installs read fine until then. ·

sluice_change_log_consumers · table · Per-stream applied-frontier registry (roadmap item 115) — every sync records how far it has consumed the shared change log, so the auto-prune / trigger prune cut is taken at the minimum across registered consumers. ·

sluice_capture_change(), sluice_capture_truncate_fn(), sluice_capture_ddl(), sluice_capture_drop() · functions · Row-capture (payload mode set by --capture-payload), TRUNCATE companion, the ddl_command_end handler, and &mdash; since v0.136.0 &mdash; the sql_drop handler. The last two are installed only on the event-trigger tier (an --allow-polled-fingerprint install has neither). ·

sluice_capture, sluice_capture_truncate (per table); sluice_capture_ddl_trg, sluice_capture_drop_trg · triggers · One combined AFTER INSERT/UPDATE/DELETE trigger and a TRUNCATE trigger per table, plus two database-wide event triggers. Two, because PostgreSQL reports DDL through two mutually exclusive context functions: pg_event_trigger_ddl_commands() returns zero rows for a DROP, so a ddl_command_end trigger alone fires on DROP TABLE and records nothing &mdash; the stream carries on as though the table still existed. The dedicated sql_drop pair records it instead, filtered on the dropped-object set rather than a command-tag list (so DROP SCHEMA &hellip; CASCADE over a synced table is caught too; DROP INDEX stays deliberately uncaptured). Installs predating v0.136.0 have only the ddl_command_end half and warn DROP-CAPTURE-ABSENT at every CDC open until trigger setup is re-run. ·

### SQLite / Cloudflare-D1 trigger engines (sqlite-trigger / d1-trigger, ADR-0135/0136)

Object · Kind · Why ·

sluice_change_log + sluice_change_log_meta · tables · Captured-change log with a monotonic id watermark, and a schema-version pin. ·

sluice_change_log_consumers · table · Per-stream applied-frontier registry (roadmap item 115) — every sync records how far it has consumed the shared change log, so the auto-prune / trigger prune cut is taken at the minimum across registered consumers and no stream is ever starved of its resume window. ·

sluice_change_log_columns · table · Captured-column fingerprint — since SQLite/D1 have no DDL triggers, a source ALTER is caught here and sync start refuses loudly rather than dropping a new column silently. ·

sluice_capture_<table>_<ins|upd|del> · triggers · Three per table (SQLite has no combined-event trigger form), each writing into the change-log. ·

The two families differ in trigger naming: postgres-trigger uses one combined trigger literally named sluice_capture per table, whereas sqlite-trigger/d1-trigger use three separate sluice_capture_<table>_<op> triggers. Both are fully removed by trigger teardown.

## Cleanup quick reference

Command · Removes ·

sluice slot drop <name> · The PG source replication slot (the one object sluice never drops on its own). ·

sluice trigger teardown · Every trigger-engine object on the source; --keep-data retains the change-log. ·

sluice trigger prune / backup prune · Old change-log rows / below-floor sluice_cdc_schema_history rows (the tables stay). ·

sluice sync start --reset-target-data · The target bookkeeping state + every source-schema table sluice manages on the target (destructive recovery). ·

manual · sluice_pub (DROP PUBLICATION — but see the warning below), and the sluice_heartbeat table once heartbeats are no longer needed. Do not drop sluice_pub while any stream over that source still exists. The next open recreates it, and with no table scope to hand it recreates it FOR ALL TABLES — which stops Postgres accepting UPDATE and DELETE on every table in the database that has no replica identity, including ones the stream never touched. Retire the stream first with sluice sync decommission --stream-id <id> --yes, which drops the slot and the per-stream publication together. ·

---
Canonical page: https://sluicesync.com/docs/database-objects/ · Full docs index: https://sluicesync.com/llms.txt
