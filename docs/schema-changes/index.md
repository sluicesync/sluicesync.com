# Schema changes during a live sync

> How sluice keeps a running sync online while the source schema evolves — what forwards automatically, what refuses loudly, and how to recover.

A source schema rarely stands still. Columns get added, types get widened, indexes come and go while a continuous sync is running. sluice does not manage those migrations for you — tools like Atlas, sqitch, Flyway, and liquibase do that — but it does keep the stream online through them. By default it forwards the operator's own committed DDL onto the target, so a routine ALTER TABLE no longer wedges the sync. This page covers what forwards automatically, the narrow set of changes that still refuse loudly, and the drained-migrate recovery when one does.

## The control: --schema-changes

A single tristate flag on sync start (and per-sync in a sync run fleet spec) governs the behavior, introduced in ADR-0091:

Mode · Behavior ·

--schema-changes=forward (default) · Apply every unambiguous source schema change on the target automatically, logging each applied DDL at INFO. The sync stays online through routine schema evolution. ·

--schema-changes=refuse · The conservative pre-v0.92 behavior: any source DDL surfaces loudly with a structured drift diff and the drained-model recovery hint. For operators who gate DDL through a separate change-management process. ·

This is a behavior change on upgrade. A stream that previously refused on source DDL now forwards it. Set --schema-changes=refuse to keep the old drained-model default. Note also that --schema-changes is a no-op under Shape A (--inject-shard-column): the multi-shard boundary router already forwards every shape via its lease. The older --forward-schema-add-column boolean is deprecated — forwarding is on by default and covers every shape, so the flag is subsumed; setting it logs a deprecation warning and forwards.

## What forwards, by source engine

Under forward, the intercept can emit any shape's DDL, but a change only reaches the target if the source's CDC stream actually carries its detail on the wire. Postgres logical replication (pgoutput) carries less than MySQL's information_schema re-read, so the honest matrix differs by source engine. This is the ground-truth table from ADR-0091 §1d — do not assume a shape forwards without checking it:

Shape · MySQL source · Postgres source ·

ADD COLUMN · forwards · forwards ·

DROP COLUMN · forwards · forwards ·

ALTER COLUMN TYPE (same- or cross-engine) · forwards5 · forwards5 ·

ALTER NULLABILITY · forwards · refuses1 ·

Column REORDER · no-op2 · no-op2 ·

CREATE / DROP INDEX · refuses3 · never signaled on the wire — cannot forward; mirror manually1 ·

ADD / DROP / MODIFY CHECK · refuses3 · never signaled on the wire — cannot forward; mirror manually1 ·

RENAME COLUMN · refuses (§rename) · forwards via attnum4 ·

RENAME TABLE / multi-shape combo · refuses · refuses ·

1 pgoutput's relation message carries only column name + type + the replica-identity key flag — no nullability flag, no secondary-index or CHECK metadata. The wire never signals these on a Postgres source, so they produce no boundary to forward. A resulting incompatibility surfaces as a loud apply error on the next affected row, not silent corruption.
2 sluice decodes rows by column name, never by position, so a pure reorder needs no DDL — it is a safe no-op.
3 MySQL's CDC projection reads only {schema, name, columns, primary key} on a DDL boundary; it does not project secondary indexes or CHECK constraints. Forwarding them would need a new catalog projection (perf-only for indexes; cross-engine expression-translation-hazardous for checks), so both are deferred.
4 A Postgres RENAME is proven via the stable pg_attribute.attnum — see RENAME COLUMN.
5 With two carve-outs, both below: a cast to or from a session-normalised timestamp always refuses (session-normalised timestamp), and on a Postgres source a change your projected type cannot express refuses under both modes (projection-invisible changes).

Every forwarded DDL is logged at INFO as it lands, so the applied change is visible in the sync's log stream. Cross-engine type ALTERs are retargeted through the same translation path a cold-start CREATE TABLE uses; a widening ALTER forwards cleanly, while a narrowing or incompatible one is rejected by the target engine and surfaces as a loud, retryable refuse (position not advanced).

## What always refuses, even under forward

Five shapes never auto-apply, because forwarding them would silently change or lose stored data:

### A cast to or from a session-normalised timestamp

An ALTER COLUMN TYPE where either side is a session-normalised timestamp — MySQL TIMESTAMP, Postgres timestamptz — refuses, in either direction and at any precision. Those types store UTC, so the server has to resolve them through the executing session's zone to render them as anything else (and to read anything else into them), and nothing on the binlog or the pgoutput wire carries which zone that was. The source operator's ALTER ran under their own session — MySQL's shipped default is time_zone=SYSTEM, the host zone — while sluice pins UTC on every connection it opens, so forwarding the same statement re-casts the target's pre-existing rows against a different zone. Row counts stay equal, every row applied after the ALTER is correct, and the sync exits 0: exactly the silent shape the refusals on this page exist for.

The original refusal was the TIMESTAMP ↔ DATETIME swap alone. Since v0.139.0 it covers the wider measured class. On MySQL 8.0.46 and PostgreSQL 16, a value stored at 2026-06-15 20:00:00 UTC and altered under a +09:00 session read back as 2026-06-16 05:00:00 through VARCHAR, 2026-06-16 through DATE (across midnight), 05:00:00 through TIME and 20260616050000 through BIGINT; the reverse casts into TIMESTAMP shifted the stored instant by the same nine hours, and PG timestamptz to text / date behaved identically. All of them forwarded unrefused before. The time and timetz pair is MEASURED asymmetric but currently refused in both directions. time to timetz genuinely is session-dependent: an offset is invented from the executing session. timetz to time is not — it stores its offset per value, and its casts measured byte-identical under two different session zones — but the refusal does not yet distinguish them, so that direction is refused too and will halt a stream you would expect to forward. Narrowing it is a behaviour change on shipped code and is not yet made. A precision-only change within one type (DATETIME(3) → DATETIME(6)) and a cast with no zoned side at all (DATETIME → VARCHAR) carry no zone conversion and keep forwarding.

Scope, stated precisely. The widened class is enforced at the pipeline door, which is reached when a boundary is forwarded — the mode that re-casts the target's existing rows, and so where the widening does its work. The reader-side checks that refuse at a table's first boundary after a cold start or a warm resume still carry only the original TIMESTAMP/DATETIME pair. Either way the remedy is the drained model below: stop with --wait, run the same ALTER on source and target from your own client so both casts happen under a session zone you chose, then restart with the same --stream-id.

### RENAME COLUMN

A column rename and a DROP x + ADD y of the same type are indistinguishable from the replication stream alone — both present as exactly one dropped column and one added column. Guessing RENAME when the truth is drop+add keeps stale data under the new name; guessing drop+add when the truth is RENAME drops the column's data on the target. The only safe disambiguation is a stable column identity that survives a rename:

- Postgres has one — pg_attribute.attnum is stable across a rename. The PG CDC reader carries it as the column's stable id; the intercept forwards a rename only when the before and after columns share the same non-zero attnum (proven rename, data preserved) and refuses otherwise. Because the proof is definitive, a bug here can only ever refuse safely, never mis-forward.

- MySQL has no equivalent — ORDINAL_POSITION changes on reorder and there is no creation id, so a MySQL-source rename is fundamentally unprovable from catalog state. It refuses, permanently. Drain and rename on both ends explicitly.

### ADD COLUMN with a computed / volatile DEFAULT

An ADD COLUMN whose DEFAULT is a non-deterministic function is refused, because evaluating it in the target's session diverges from the per-row values the source already inserted (ADR-0058 §2a). The refused functions include NOW() / CURRENT_TIMESTAMP / clock_timestamp(), nextval(), gen_random_uuid(), random(), and MySQL's UUID() / RAND() — matched schema-qualified or bare, and detected even when wrapped (e.g. COALESCE(NULL, NOW())). A constant DEFAULT forwards normally. If the probe of a column's default can't be read at all, sluice refuses on uncertainty rather than risk a wrong value.

### A change your projected type cannot express (Postgres source)

A consumer of pgoutput holds two representations of a column's type — the raw wire pair (type OID, typmod) and the projected IR type sluice maps engines into — and they can disagree about whether anything changed. interval precision/field restrictions and array-element modifiers are visible to the raw compare and vanish in projection, so the change classifies and there is no projected boundary to forward, while the source has already rewritten every stored value underneath it. Since v0.132.1 a detected change whose projected type is unchanged refuses under both modes, per column and keyed on column name (a middle-column DROP shifts every later ordinal, and pgoutput coalesces DML-quiet back-to-back DDL into one relation message of final state), with a catalog-derived enumeration gate holding the class closed. The refusal text is shape-aware: the two catalog-only shapes PostgreSQL applies without a rewrite — an unbounded varchar↔text swap, and an interval precision widening with the same range bits — say so instead of warning about divergence that did not happen.

### Which DDL halts the stream (postgres-trigger source)

A Postgres event trigger is database-wide. There is no such thing as a schema-scoped one. Through v0.139.0 the DDL tier filtered by command tag alone, so it recorded a marker for an ALTER TABLE, CREATE TABLE or CREATE INDEX anywhere in the database — and a marker halts the stream with the restart-from-scratch remedy. A colleague creating an unrelated table, in a schema sluice never touches, stopped your sync.

Since v0.140.0 the tier asks the question the drop arm has asked since v0.136.0: does the command's relation carry this install's row-capture trigger? What that resolves to was measured on Postgres 16.15 rather than assumed, because it differs by shape and one shape could have failed quietly — an ALTER reports the table directly, ADD CONSTRAINT included, while a CREATE INDEX reports the index and has to resolve through it to the table.

- Still halts: ALTER TABLE on a captured table (ADD COLUMN, ALTER COLUMN TYPE, DROP COLUMN, ADD CONSTRAINT, RENAME COLUMN) and CREATE INDEX on one.

- No longer halts: anything on a table this install does not capture — another schema entirely, an uncaptured neighbour in the same schema, or a brand-new table. A table with no capture trigger emits no change rows, so it cannot make the applier write a wrong one; sluice schema add-table is how it joins the stream.

This changes a capture-function body, so an install created by an earlier release will warn STALE-CAPTURE-FUNCTION until sluice trigger setup is re-run once. The re-run is non-destructive: the change log, the watermark and the consumer registry are all preserved.

### A DROP of a synced table (postgres-trigger source)

Dropping a table a postgres-trigger install captures — directly, or through DROP SCHEMA … CASCADE / DROP OWNED BY — refuses the stream at the next poll since v0.136.0, naming the relation and carrying a drop-specific remedy (the usual one would be useless: sluice migrate reads the source schema and cannot land a drop). Through v0.135.x nothing recorded it at all — the ddl_command_end event trigger named DROP TABLE in its tag filter, and pg_event_trigger_ddl_commands() returns zero rows for a drop — so the stream carried on at exit 0 with the target holding the table's last-synced rows forever. An install created before v0.136.0 has no sql_drop arm and warns DROP-CAPTURE-ABSENT at every CDC open until sluice trigger setup is re-run. Two deliberate non-events: a DROP INDEX records nothing (sluice never forwards index DDL, so an index drop cannot change any row the applier writes), and a drop elsewhere in the database records nothing — the capture is scoped to tables carrying this install's own sluice_capture trigger.

Multi-shape combos (more than one structural change in a single boundary) also refuse — the IR delta can't be unambiguously ordered — as does a target DDL apply that fails on lock contention, permissions, or an unrecognized type. Every one of these leaves the CDC position un-advanced, so a retry replays the boundary once you've reconciled by hand.

## The refusal message

When a change refuses, the error is deliberately greppable and names the specific offending object plus the operator action. It carries three parts: the classify error (which shape / how many changes), a structured drift diff that names the exact columns / indexes / constraints that differ, and a recovery hint. The hint spells out the drained model:

- Run sluice sync stop --wait to drain in-flight changes.

- Apply the schema change on the target — manually, or through a governed channel such as sluice deploy-ddl (PlanetScale deploy requests) or sluice schema add-table when the change is a whole new table.

- Resume by re-running sluice sync start with the same --stream-id — it warm-resumes from the persisted position.

- It also notes that --schema-changes=refuse keeps the drained model as the default for any subsequent source DDL.

## Operator runbook: recovering a refused change

When a change refuses — or when you run --schema-changes=refuse deliberately — the recovery is the drained-schema-migrate sequence. Stop the stream with --wait so the CLI blocks until the streamer confirms a graceful drain (the in-flight batch is committed and the CDC position is persisted past the last applied event), apply the DDL to whichever side needs it, then resume from the persisted position:

    # 1. Drain and stop — --wait blocks until the drain is confirmed
    sluice sync stop --wait \
        --stream-id app-prod \
        --target-driver postgres --target 'postgres://...target...'

    # 2. Apply the schema change on source and/or target as appropriate
    psql "$SOURCE_DSN" -c 'ALTER TABLE accounts RENAME COLUMN label TO name;'
    psql "$TARGET_DSN" -c 'ALTER TABLE accounts RENAME COLUMN label TO name;'

    # 3. Resume — the same --stream-id warm-resumes from the persisted CDC position
    sluice sync start \
        --stream-id app-prod \
        --source-driver mysql    --source 'root:rootpw@tcp(localhost:3306)/app' \
        --target-driver postgres --target 'postgres://...target...'

There is no resume flag to pass: re-invoking sync start with the same --stream-id finds that stream's persisted CDC position (source LSN / GTID set / VStream cursor) and continues from it, so pre-stop events apply cleanly and the first event after resume sees the new shape on both sides. It does not re-run the snapshot, and it never bulk-copies into the populated target. The order "stop → ALTER source → ALTER target → start" is robust regardless of which side commits the DDL first, as long as both sides carry the new shape before resume. On a Postgres source the persisted position is the last committed transaction's end LSN — the first byte after its commit record — so the resumed stream begins at the next transaction rather than re-delivering the one it closed (v0.138.0; through v0.137.4 a Postgres warm resume replayed the last applied transaction with its pre-DDL relation shape, and a refusal re-fired on the restart this runbook prescribes). The corollary is that a schema change applied to the source only, while the stream was stopped, is not classified at resume — which is why this sequence applies it on both sides before restarting.

Plan the target-side change first. sluice schema diff runs the source schema through sluice's translation pipeline and reports drift against the target's actual schema — apply the ALTER on the source, run the diff, and it surfaces the missing-on-target columns / type mismatches with suggested ALTER statements as a starting point. It does not know your data volume or lock duration, so review them before running.

## Next steps

- sync start reference — the --schema-changes row and the full sync flag set.

- Migrate MySQL to Postgres — the one-shot migration the drained model resumes onto.

- schema preview / diff — pre-flight the drift, then apply the target-side change yourself (or via deploy-ddl).

---
Canonical page: https://sluicesync.com/docs/schema-changes/ · Full docs index: https://sluicesync.com/llms.txt
