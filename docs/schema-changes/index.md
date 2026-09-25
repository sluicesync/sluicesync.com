<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# Schema changes during a live sync

> How sluice keeps a running sync online while the source schema evolves — what forwards automatically, what refuses loudly, and how to recover.

A source schema rarely stands still. Columns get added, types get widened, indexes come and go while a continuous sync is running. sluice does not manage those migrations for you — tools like Atlas, sqitch, Flyway, and liquibase do that — but it does keep the stream online through them. By default it forwards the operator's own committed DDL onto the target, so a routine ALTER TABLE no longer wedges the sync. This page covers what forwards automatically, the narrow set of changes that still refuse loudly, and the drained-migrate recovery when one does.

## The control: --schema-changes

A single tristate flag on sync start (and per-sync in a sync run fleet spec) governs the behavior, introduced in ADR-0091:

Mode · Behavior ·

--schema-changes=forward (default) · Apply every unambiguous source schema change on the target automatically — ADD/DROP COLUMN, ALTER COLUMN TYPE, and, on a MySQL source, ALTER NULLABILITY — logging each applied DDL at INFO. The sync stays online through routine schema evolution. CREATE/DROP INDEX and ADD/DROP/MODIFY CHECK are not among them on any source: see the matrix below. Nor are constraint, row-level-security, policy or DEFAULT changes — since v0.156.0 those stop the stream on Postgres and MySQL/MariaDB binlog sources. ·

--schema-changes=refuse · The conservative pre-v0.92 behavior: any source DDL surfaces loudly with a structured drift diff and the drained-model recovery hint. For operators who gate DDL through a separate change-management process. ·

This is a behavior change on upgrade. A stream that previously refused on source DDL now forwards it. Set --schema-changes=refuse to keep the old drained-model default. Note also that --schema-changes is a no-op under Shape A (--inject-shard-column): the multi-shard boundary router already forwards every shape via its lease. The older --forward-schema-add-column boolean is deprecated — forwarding is on by default and covers every shape, so the flag is subsumed; setting it logs a deprecation warning and forwards.

## What forwards, by source engine

Under forward, the intercept can emit any shape's DDL, but a change only reaches the target if the source's CDC stream actually carries its detail on the wire. Postgres logical replication (pgoutput) carries less than MySQL's information_schema re-read, so the honest matrix differs by source engine. This is the ground-truth table from ADR-0091 §1d — do not assume a shape forwards without checking it:

Shape · MySQL / MariaDB source · Postgres source ·

ADD COLUMN · forwards, with its DEFAULT; pre-existing target rows backfilled from the source7 · forwards, with its DEFAULT; pre-existing target rows backfilled from the source7 ·

DROP COLUMN · forwards · forwards ·

ALTER COLUMN TYPE (same- or cross-engine) · forwards5 · forwards5 ·

ALTER NULLABILITY · forwards · not forwarded — stops the stream (UNFORWARDED-SCHEMA-CHANGE)1,6 ·

Column REORDER · no-op2 · no-op2 ·

CREATE / DROP plain (non-unique) INDEX · no boundary — never reaches the target and is not detected; mirror manually3 · never signaled on the wire — cannot forward and is not detected; mirror manually1 ·

ADD / DROP / MODIFY CHECK · not forwarded — stops the stream (UNFORWARDED-SCHEMA-CHANGE)3,6 · not forwarded — stops the stream (UNFORWARDED-SCHEMA-CHANGE)1,6 ·

PRIMARY KEY / UNIQUE / FOREIGN KEY (add, drop, change) · not forwarded — stops the stream6 (a UNIQUE index counts, including a prefix-length change) · not forwarded — stops the stream6 (constraints, EXCLUDE included; a bare CREATE UNIQUE INDEX with no constraint is a plain index here) ·

DEFAULT / identity / generated change on an existing column · not forwarded — stops the stream6 (DEFAULT, EXTRA such as AUTO_INCREMENT / ON UPDATE, generation expression) · not forwarded — stops the stream6 (SET/DROP DEFAULT, identity, generated column) ·

Row-level security / CREATE/ALTER/DROP POLICY · — · not forwarded — stops the stream6 ·

RENAME COLUMN · refuses (§rename) · forwards via attnum4 ·

RENAME TABLE / multi-shape combo · refuses · refuses ·

1 pgoutput's relation message carries only column name + type + the replica-identity key flag — no nullability flag, no secondary-index or CHECK metadata. The wire never signals these on a Postgres source, so they produce no boundary to forward. Nullability and CHECK changes are caught by the v0.156.0 door instead (6); a plain index change is not caught by anything.
2 sluice decodes rows by column name, never by position, so a pure reorder needs no DDL — it is a safe no-op.
3 MySQL's CDC projection reads only {schema, name, columns, primary key} on a DDL boundary; it does not project secondary indexes or CHECK constraints. An index-only or CHECK-only DDL therefore produces no boundary at all and is never forwarded. For a plain index that is still the whole story — it is not refused and nothing is logged about it; the change simply never reaches the target, and you add it there out-of-band. A CHECK change, since v0.156.0, is caught by the door in 6 on a binlog source. Forwarding either would need a new catalog projection (perf-only for indexes; cross-engine expression-translation-hazardous for checks), so both are deferred.
4 A Postgres RENAME is proven via the stable pg_attribute.attnum — see RENAME COLUMN.
5 With two carve-outs, both below: a cast to or from a session-normalised timestamp always refuses (session-normalised timestamp), and on a Postgres source a change your projected type cannot express refuses under both modes (projection-invisible changes).
6 v0.156.0+, Postgres and MySQL/MariaDB binlog sources. Neither change stream describes these objects, so they never forward; through v0.155.1 they were dropped with no log line and the target stayed weaker than the source. Now the stream stops at the next write to that table with UNFORWARDED-SCHEMA-CHANGE, the refusal is recorded, and every later start refuses again until acknowledged — see below. Not covered: PlanetScale / Vitess (VStream) sources, where these changes are still silent, and the trigger-CDC engines (postgres-trigger, sqlite-trigger, d1-trigger), whose own readers this door does not reach (for postgres-trigger's DDL handling see below).
7 v0.156.1+. The column's DEFAULT is carried on the target's ADD COLUMN: a MySQL/MariaDB binlog source carries it in-band, and on a Postgres or PlanetScale/Vitess source — whose change streams have no field for it — the forward reads it through the source schema reader, the same value a cold-start migrate emits, and refuses if that read fails (through v0.156.0 it was dropped, so the target filled its pre-existing rows with NULL, NOT NULL columns included). The DEFAULT is read when the boundary reaches sluice, though, so it can differ from what the source filled its own rows with — hence the backfill, on by default. A non-constant DEFAULT the source still declares at that point refuses. The same applies under Shape A (--inject-shard-column). Toward a MySQL-family target a TEXT/BLOB/JSON/GEOMETRY DEFAULT that cannot be carried refuses the ADD COLUMN (LOB-DEFAULT-NOT-CARRIED).

Every forwarded DDL is logged at INFO as it lands, so the applied change is visible in the sync's log stream. Cross-engine type ALTERs are retargeted through the same translation path a cold-start CREATE TABLE uses; a widening ALTER forwards cleanly, while a narrowing or incompatible one is rejected by the target engine and surfaces as a loud, retryable refuse (position not advanced).

## What always refuses, even under forward

Five shapes never auto-apply, because forwarding them would silently change or lose stored data:

### A cast to or from a session-normalised timestamp

An ALTER COLUMN TYPE where either side is a session-normalised timestamp — MySQL TIMESTAMP, Postgres timestamptz — refuses, in either direction and at any precision. Those types store UTC, so the server has to resolve them through the executing session's zone to render them as anything else (and to read anything else into them), and nothing on the binlog or the pgoutput wire carries which zone that was. The source operator's ALTER ran under their own session — MySQL's shipped default is time_zone=SYSTEM, the host zone — while sluice pins UTC on every connection it opens, so forwarding the same statement re-casts the target's pre-existing rows against a different zone. Row counts stay equal, every row applied after the ALTER is correct, and the sync exits 0: exactly the silent shape the refusals on this page exist for.

The original refusal was the TIMESTAMP ↔ DATETIME swap alone. Since v0.139.0 it covers the wider measured class. On MySQL 8.0.46 and PostgreSQL 16, a value stored at 2026-06-15 20:00:00 UTC and altered under a +09:00 session read back as 2026-06-16 05:00:00 through VARCHAR, 2026-06-16 through DATE (across midnight), 05:00:00 through TIME and 20260616050000 through BIGINT; the reverse casts into TIMESTAMP shifted the stored instant by the same nine hours, and PG timestamptz to text / date behaved identically. All of them forwarded unrefused before. The time and timetz pair is MEASURED asymmetric, and since v0.142.0 the refusal matches the measurement instead of covering both halves. time to timetz is session-dependent and still refuses: an offset is invented, and Postgres takes it from the executing session. timetz to time is not, and now forwards — timetz stores its offset alongside each value, so dropping it consults no session zone, measured byte-identical under UTC and Asia/Tokyo across negative and fractional offsets, 1-D arrays with NULL elements, and 2-D arrays checked with array_dims. Before v0.142.0 that direction was refused too, halting a stream you would expect to forward. The array shapes follow the scalars (time[] to timetz[] refuses, timetz[] to time[] forwards), and the timestamp family is unchanged and still refuses both ways, because timestamptz is stored normalised to UTC and re-renders through the session zone whichever way the cast runs. A precision-only change within one type (DATETIME(3) → DATETIME(6)) and a cast with no zoned side at all (DATETIME → VARCHAR) carry no zone conversion and keep forwarding.

Scope, stated precisely. The widened class is enforced at the pipeline door, which is reached when a boundary is forwarded — the mode that re-casts the target's existing rows, and so where the widening does its work. The reader-side checks that refuse at a table's first boundary after a cold start or a warm resume still carry only the original TIMESTAMP/DATETIME pair. Either way the remedy is the drained model below: stop with --wait, run the same ALTER on source and target from your own client so both casts happen under a session zone you chose, then restart with the same --stream-id.

### RENAME COLUMN

A column rename and a DROP x + ADD y of the same type are indistinguishable from the replication stream alone — both present as exactly one dropped column and one added column. Guessing RENAME when the truth is drop+add keeps stale data under the new name; guessing drop+add when the truth is RENAME drops the column's data on the target. The only safe disambiguation is a stable column identity that survives a rename:

- Postgres has one — pg_attribute.attnum is stable across a rename. The PG CDC reader carries it as the column's stable id; the intercept forwards a rename only when the before and after columns share the same non-zero attnum (proven rename, data preserved) and refuses otherwise. Because the proof is definitive, a bug here can only ever refuse safely, never mis-forward.

- MySQL has no equivalent — ORDINAL_POSITION changes on reorder and there is no creation id, so a MySQL-source rename is fundamentally unprovable from catalog state. It refuses, permanently. Drain and rename on both ends explicitly.

### ADD COLUMN with a computed / volatile DEFAULT

An ADD COLUMN whose DEFAULT is a non-deterministic function is refused, because evaluating it in the target's session diverges from the per-row values the source already inserted (ADR-0058 §2a). The refused functions include NOW() / CURRENT_TIMESTAMP / clock_timestamp(), nextval(), gen_random_uuid(), random(), and MySQL's UUID() / RAND() — matched schema-qualified or bare, and detected even when wrapped (e.g. COALESCE(NULL, NOW())). A constant DEFAULT forwards normally. If the probe of a column's default can't be read at all, sluice refuses on uncertainty rather than risk a wrong value.

The refusal looks at the DEFAULT the source still declares when the ADD COLUMN reaches sluice. A volatile DEFAULT that was dropped or changed before then — Django's AddField drops its default in the very next statement — is not refused: the forward carries whatever the source declares at that point, and the added-column backfill (on by default since v0.156.1) then overwrites the target's pre-existing rows with the values the source actually filled them with. Through v0.156.0, without the opt-in backfill, those rows kept the target's own fill. Since v0.156.1 the Shape A router (--inject-shard-column) applies the same refusal; before, on a MySQL-family source, it forwarded such a DEFAULT and every pre-existing row got the target's own evaluation of it.

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

Multi-shape combos (more than one structural change in a single boundary) also refuse — the IR delta can't be unambiguously ordered — as does a target DDL apply that fails on lock contention, permissions, or an unrecognized type. Every one of these leaves the CDC position un-advanced, so a retry replays the boundary once you've reconciled by hand. One exception since v0.156.1: a target ALTER that fails for a forwarded ADD COLUMN — even transiently — stops the stream with ADD-COLUMN-BACKFILL-INCOMPLETE unless the backfill is switched off, because the owed backfill was recorded before the ALTER ran; the automatic retry and every restart refuse until you check the column and acknowledge.

## After a forwarded ADD COLUMN: the backfill from the source

v0.156.1+, on by default. When sync forwards a source ADD COLUMN, the target fills every row it already holds with the column's DEFAULT as the forward carried it, and that DEFAULT is read when the boundary reaches sluice. It is not what the source filled its own rows with whenever the DEFAULT was dropped or changed in between (Django emits ADD COLUMN c … NOT NULL DEFAULT 'v' then ALTER COLUMN c DROP DEFAULT for every field with a default), or when a non-constant DEFAULT was dropped or changed before the ADD COLUMN reached sluice. So after the ALTER lands, sluice pages the table on the source by primary key, reading only the key and the added columns, and writes each row's value to the target, ahead of every change that follows the ALTER — a row the source updates after the ALTER still ends at its updated value. It covers Postgres, MySQL, MariaDB and PlanetScale/Vitess sources, single-stream and Shape A (each shard's stream fills only its own shard's rows, from its own source). A --where filter applies to its read. The trigger-CDC sources forward no ADD COLUMN, and a multi-database stream does not forward DDL, so neither has anything to backfill.

- The stream waits for it. The cost is one pass over the table on the source plus one UPDATE per pre-existing row on the target. On a Postgres target the updates are pipelined; on a MySQL, MariaDB or PlanetScale target each is its own round trip, so a large table over a slow link can put the stream far behind. It logs forward-add-column: backfilling the added columns … when it starts, forward-add-column: backfill in progress with the row count every 30 seconds, and forward-add-column: backfill complete with rows_backfilled at the end.

- It needs a primary key, read from the source catalog rather than the change stream (under Postgres REPLICA IDENTITY FULL the stream's key is every column; a VStream field event carries no key). Without one it refuses. It also refuses if the added column, or a primary-key column, has been renamed or dropped on the source by the time it reads; a later change to any other column does not affect it.

- Opting out: --no-backfill-added-column (fleet key no-backfill-added-column: true). The pre-existing rows then keep the target's fill, and a WARN (forward-add-column: backfill suppressed) names each column. --backfill-added-column, the old opt-in, is a deprecated no-op.

If you opted into --backfill-added-column on an earlier release against a Postgres table with REPLICA IDENTITY FULL — which every filtered --where sync requires — that backfill keyed its UPDATEs on every column including the one being filled, matched no row, and left the pre-existing rows NULL at exit 0. Compare the column against the source.

### An interrupted backfill stops the stream: ADD-COLUMN-BACKFILL-INCOMPLETE

A backfill does not resume: a restarted stream never sees the ADD COLUMN again, so the rows it had not reached would keep the target's fill with nothing to report it. So a run that ends before the backfill provably reached the target — a sync stop or Ctrl-C during it, a failed source read, an apply error, or a target ALTER that failed, even transiently — ends with ADD-COLUMN-BACKFILL-INCOMPLETE, naming the table and columns. It is an UNFORWARDED-SCHEMA-CHANGE refusal (the message begins UNFORWARDED-SCHEMA-CHANGE: ADD-COLUMN-BACKFILL-INCOMPLETE: …), recorded on the stream's sluice_cdc_state row the same way, so every restart refuses; like it, it exits 1 with no error code, and a fleet supervisor does not restart the leg. A process killed without running its exit path (SIGKILL, an OOM kill, power loss) is covered too: the owed backfill is written to that record before the ALTER is applied, and cleared (compare-and-clear, so it never removes a different refusal) only once the backfill is confirmed on the target — checked every 10 seconds while the stream runs and again at stop. If the record cannot be written, the ADD COLUMN is refused rather than forwarded without it.

The remedy differs from a plain UNFORWARDED-SCHEMA-CHANGE, where you apply a DDL to the target. Here the column is already there; its pre-existing rows may be wrong:

- Copy the added column's values from the source to the target for the rows that predate the ADD COLUMN, keyed by primary key.

- Start once with --accept-unforwarded-schema-change=<fingerprint>, using the fingerprint the refused start prints — or, instead of step 1, re-copy by passing --restart-from-scratch on that same acknowledged start.

The record is deliberately conservative, so it can also appear when nothing was lost: after a kill in the seconds between a backfill completing and being confirmed, after a kill between the record being written and the ALTER, or after an ALTER that failed. Check the column against the source before you acknowledge. On a PlanetScale/Vitess source the confirmation arrives with the next change whose position has advanced, so on an idle source a stop before one arrives refuses. Not covered: on the Shape A fan-in, a hard kill after a peer shard's ALTER has filled this shard's rows and before this stream has seen its own ADD COLUMN; and a hard kill before sluice reaches the ADD COLUMN at all. After a crash that follows a source schema change, compare the added column against the source (sluice verify compares real rows). Plan schema changes so a stream is not stopped mid-backfill: wait for the backfill complete line.

Downgrading. v0.156.0 replays a recorded ADD-COLUMN-BACKFILL-INCOMPLETE like any other recorded refusal; a binary older than v0.156.0 ignores the record and resumes past the owed backfill silently. Repair and acknowledge it before downgrading that far.

## A change the stream cannot carry stops it: UNFORWARDED-SCHEMA-CHANGE

v0.156.0+, Postgres and MySQL/MariaDB binlog sources. Some source DDL cannot reach the target through any change stream, because neither stream describes the object: pgoutput's relation message carries column names, type OIDs and key flags only, and after a DDL the binlog reader rebuilds a table from information_schema as columns plus primary key only. Through v0.155.1 these changes were dropped with no log line, so the target stayed weaker than the source — for a policy, that is a security boundary. The sharpest shape was a single statement, ALTER TABLE t ADD COLUMN x int, ADD CONSTRAINT fk FOREIGN KEY (x) REFERENCES p(id), which forwarded the column and silently dropped the foreign key, on both engines.

- Postgres: ADD/DROP CONSTRAINT (primary key, UNIQUE, foreign key, EXCLUDE, CHECK), ENABLE/FORCE ROW LEVEL SECURITY, CREATE/ALTER/DROP POLICY, SET/DROP NOT NULL, SET/DROP DEFAULT, and identity or generated-column changes.

- MySQL and MariaDB: primary key and UNIQUE changes (a prefix-length change included), foreign key changes (columns, referenced table and columns, ON UPDATE/ON DELETE), CHECK changes (NOT ENFORCED included, on MySQL), and DEFAULT, EXTRA (AUTO_INCREMENT, ON UPDATE) or generation-expression changes on an existing column. Nullability is not compared there, because the column forward already carries it.

When the stream starts, sluice records these objects for every table in scope (the baseline). At the next write to a table after such a DDL it re-reads that table's catalog and compares; on any difference sync and backup stream end with UNFORWARDED-SCHEMA-CHANGE, naming each change, before the post-DDL row lands. It is never retried automatically, and an automatic retry after some other transient error keeps the baseline it started with, so a change made just before a dropped connection is still refused. What does not refuse, because the pipeline already handles it: the attributes of a column added in the same statement (but a constraint added with a new column does refuse — that is the foreign-key shape above), a constraint that disappears because its column was dropped, and ADD … NOT VALID followed by VALIDATE (validity is not compared).

### It is recorded, and every restart refuses again

A restarted reader would take its baseline from a catalog that already holds the change, so without a record a systemd Restart=on-failure, a pod restart or a supervisor would accept it silently, forever. So the refusal is persisted: sync writes it on the stream's row of the target's sluice_cdc_state table (column unforwarded_refusal), and backup stream writes it in the destination's stream_state.json (key unforwarded_schema_change_refusal). Every later start reads it before any change stream opens and refuses again — warm resume, multi-database resume, --restart-from-scratch and --reset-target-data included — replaying the recorded refusal with its fingerprint <12 hex> (the first 12 hex digits of the SHA-256 of the recorded text) and the exact flag to pass.

Exit status 1, no error code. The refusal carries no SLUICE-E-* code yet, so it exits 1, not 3, and a JSON log line or envelope has no code or hint to branch on. Alert on the marker UNFORWARDED-SCHEMA-CHANGE in the log, not on the exit status — automation that treats a codeless exit 1 as "retry" will just see it refuse again. Since v0.156.1 the same marker also leads an interrupted added-column backfill (UNFORWARDED-SCHEMA-CHANGE: ADD-COLUMN-BACKFILL-INCOMPLETE: …), which is recorded and replayed the same way but has a different remedy.

### Recovering: apply it to the target, then acknowledge once

The drained-migrate runbook below does not clear this refusal — a plain restart with the same --stream-id just replays it. Instead:

- Apply the same change to the target yourself. For backup stream, take a new full backup instead: a chain restored from the old full would lack the change.

- Start the stream without the flag once if you do not have the fingerprint yet — the replayed refusal prints it.

- Start once with the same --stream-id and --accept-unforwarded-schema-change=<fingerprint> (the same flag exists on backup stream run). It clears that record, logs a WARN naming what was accepted, and takes a fresh baseline.

    # the replayed refusal names the change and prints: ... fingerprint 3f9a0c1b7e22
    sluice sync start \
        --stream-id app-prod \
        --source-driver postgres --source 'postgres://...source...' \
        --target-driver postgres --target 'postgres://...target...' \
        --accept-unforwarded-schema-change=3f9a0c1b7e22

The acknowledgement takes a fresh baseline, so passing it without step 1 accepts the difference permanently and nothing reports it again.

The acknowledgement is bound to one refusal. Only the fingerprint of the refusal recorded now clears it; a value naming any other refusal is refused ("names a different refusal than the one recorded"), and an empty value keeps refusing. The recorded text is stamped with the moment it was recorded, so the same change recurring later gets a new fingerprint. On sync, once the flag has cleared the record it is spent for the rest of the process. That is what makes a copy left in a systemd ExecStart line or a wrapper script harmless — it cannot accept the next, different refusal on the next automatic restart — but take it out anyway: it belongs on a single manual start. It is deliberately not a syncs.yaml key, because standing config would pre-accept refusals. Fleet legs have their own procedure: acknowledging a fleet leg.

To avoid the refusal altogether, make such changes through the drained model: sluice sync stop --wait, apply the change on source and target, restart. A change made while the stream is stopped is part of the next start's baseline, so it does not refuse.

### What it does not catch

- A change made while the stream was not watching — while it was stopped, during the cold-start copy, a DDL a lagging stream had not reached when it stopped, or anything before you upgraded to v0.156.0. It is already in the baseline. Upgrading does not find an old gap: if a Postgres or MySQL/MariaDB binlog stream ran through such DDL on an earlier release, audit those tables by hand (on Postgres compare pg_constraint, pg_policy, pg_class.relrowsecurity/relforcerowsecurity, pg_attribute.attnotnull and pg_attrdef; on MySQL/MariaDB information_schema.table_constraints, check_constraints, referential_constraints and columns.COLUMN_DEFAULT/EXTRA), and for backup stream take a new full.

- A table nobody writes to again — detection needs a later write to the same table. A change reverted before that read is missed (net no change).

- On MySQL, a DDL run under an out-of-scope default database (USE other; ALTER TABLE db.t …), which does not clear the reader's schema cache.

- Plain (non-constraint) indexes, Postgres column collation, and policies or RLS on a partitioned Postgres root.

- backup incremental, which opens a fresh reader every run, so a change between two incrementals is in the next run's baseline.

- PlanetScale / Vitess (VStream) sources, and the postgres-trigger, sqlite-trigger and d1-trigger engines, which this door does not reach. On VStream the whole gap is still silent — audit the target by hand after such DDL.

Known false refusals, each costing one acknowledgement: on MySQL, a DROP COLUMN b shrinks a composite UNIQUE (a, b) to UNIQUE (a) while Postgres drops the whole index, and the reader cannot see which the target did; on Postgres, a constraint rename refuses as a drop plus an add.

Upgrading an existing stream to v0.156.0. The control table gains a column, sluice_cdc_state.unforwarded_refusal (TEXT NULL), added automatically on the next start. Two setups cannot add it themselves and must do it by hand before restarting streams: a PlanetScale safe-migrations target (ship ALTER TABLE `sluice_cdc_state` ADD COLUMN `unforwarded_refusal` TEXT NULL through sluice deploy-ddl), and a Postgres role that does not own an existing control table (the owner runs ALTER TABLE sluice_cdc_state ADD COLUMN unforwarded_refusal TEXT NULL). Every start checks for the column and refuses to stream if it is missing and cannot be added, because a stream that could not record a refusal would have it accepted silently by the next restart. A downgrade to an older binary ignores a recorded refusal and accepts the change on restart, so apply any recorded change to the target before downgrading.

## The refusal message

When a change refuses, the error is deliberately greppable and names the specific offending object plus the operator action. It carries three parts: the classify error (which shape / how many changes), a structured drift diff that names the exact columns / indexes / constraints that differ, and a recovery hint. The hint spells out the drained model:

- Run sluice sync stop --wait to drain in-flight changes.

- Apply the schema change on the target — manually, or through a governed channel such as sluice deploy-ddl (PlanetScale deploy requests) or sluice schema add-table when the change is a whole new table.

- Resume by re-running sluice sync start with the same --stream-id — it warm-resumes from the persisted position.

- It also notes that --schema-changes=refuse keeps the drained model as the default for any subsequent source DDL.

## Operator runbook: recovering a refused change

When a change refuses — or when you run --schema-changes=refuse deliberately — the recovery is the drained-schema-migrate sequence. Stop the stream with --wait so the CLI blocks until the streamer confirms a graceful drain (the in-flight batch is committed and the CDC position is persisted past the last applied event), apply the DDL to whichever side needs it, then resume from the persisted position. (One refusal is the exception: UNFORWARDED-SCHEMA-CHANGE is recorded on the target, so this sequence alone just replays it — apply the change to the target and acknowledge it with --accept-unforwarded-schema-change instead.)

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
