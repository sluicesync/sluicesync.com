<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# Zero-downtime migration with continuous sync

> Cold-start the data, let CDC catch up while the app keeps writing, then cut over in a brief, controlled window.

A one-shot migrate is a point-in-time copy: rows written after it starts are missed. sync start closes that gap — it takes a consistent snapshot, bulk-copies it, then streams ongoing changes (change-data-capture) so the target tracks the source live. That lets you keep the application running on the source the whole time and flip traffic over in a short, controlled window. This is the core "sync, not just migrate" workflow; reach for it whenever downtime isn't acceptable.

Source prerequisites. CDC reads the source's native change stream. Postgres needs logical replication (a replication slot + REPLICATION role); MySQL needs the binlog (ROW format). On a managed Postgres that blocks slots (Heroku, some RDS tiers), use the slot-less trigger engine instead — sluice refuses loudly rather than silently degrading to polling.

## 1. Start the stream

A stream is identified by --stream-id so it can resume after a restart. The first launch cold-starts (snapshot → bulk copy), then transitions seamlessly into live CDC and keeps running until you stop it:

    sluice sync start \
        --source-driver mysql    --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --stream-id app-prod

Restarting with the same --stream-id warm-resumes from the persisted position — it does not re-run the snapshot. To run it as a long-lived service, add a health endpoint with --metrics-listen :9090. A connected stream keeps its position moving through quiet periods by itself on Postgres (v0.156.8+) and on MySQL/MariaDB binlog sources (v0.156.9+, outside two residual shapes); --source-heartbeat-interval 30s adds a source-side heartbeat for those shapes and older releases; see running as a service and the sync start reference.

## 2. Watch it catch up

From another shell, check the stream's position and freshness. sync health returns a cron-friendly exit code so you can script "are we caught up yet?":

    sluice sync status --stream-id app-prod --target-driver postgres --target "$SLUICE_TARGET"

    # exit non-zero if the last apply was more than 5s ago
    sluice sync health --stream-id app-prod --target-driver postgres --target "$SLUICE_TARGET" \
        --max-stale-seconds 5

Once sync health reports fresh under a tight threshold, the target is tracking the source within seconds — you're ready to cut over. (On a PG→PG pair, also pass --source-driver/--source to expose --max-lag-bytes for byte-distance lag.)

## 3. Quiesce and drain

At your chosen cutover moment, stop writes to the source application (the brief window), then drain the last in-flight changes. sync stop --wait blocks until the streamer has applied everything queued and exited cleanly:

    sluice sync stop --stream-id app-prod \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --wait --timeout 10m

On timeout the CLI exits non-zero and the stop request stays in place — so a scripted cutover fails safe rather than proceeding on a half-drained target.

## 4. Prime sequences (cutover)

CDC replicates row changes, not catalog-level sequence positions. So after the drain, the target's SERIAL / AUTO_INCREMENT counters can lag behind the IDs that already exist in its rows — and the first post-cutover INSERT would collide on the primary key. cutover closes that gap: it re-reads the source sequence state and applies it to the target with a safety margin:

    sluice cutover \
        --source-driver mysql    --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --sequence-margin 1000

cutover is idempotent and fails safe: a re-run within the margin reports every table as noop, and if the target's sequence is already ahead of the source by more than the margin it refuses (exit code 2) rather than risk a collision — the signal that something already wrote to the target. Run it after the drain and before pointing application traffic at the target.

## 5. Verify, then flip traffic

Confirm the data agrees, then point your application at the target:

    sluice verify --source-driver mysql --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" --depth count

The full sequence: start the stream → wait for fresh → freeze source writes → sync stop --wait → cutover → verify → repoint the app. Only the last three steps fall inside the write-freeze window, so downtime is measured in seconds-to-minutes, not the length of the copy.

## 6. Rolling back a cutover

sluice does not ship a one-button rollback. Until you're confident in the new database, keep the old primary intact — do not drop or repurpose it. If something goes wrong after you flip traffic and you must fail back, you point the application at a database that is still current — and there are two procedural ways to have one.

### Option 1: a reverse re-copy into a separate, EMPTY standby, armed before the flip

A reverse-direction sluice instance (new target → a standby) can keep a rollback database continuously fresh after the flip. It cannot be pointed at the old source as it stands. sluice's migrate is built for a target it fills: against a database whose tables already hold the data it refuses — SLUICE-E-COLDSTART-TARGET-NOT-EMPTY — and both ways past that refusal defeat the purpose. --force-cold-start skips the probe and the copy then collides with every row already present, while --reset-target-data drops every table on the old source and re-copies it from the new target — a full bulk rewrite of the one database you are keeping so you can fall back to it, during which no rollback path exists at all. There is no supported way today to start a reverse CDC stream from the drain point without a copy; that design is ADR-0188, proposed and not built.

So the supported shape is a reverse re-copy into a separate, empty standby, and it is only a rollback path once that copy has completed and the reverse stream has caught up — arm it well before the flip:

    # Before the traffic flip, on a second machine / process, into an EMPTY standby:
    sluice migrate --config reverse-direction.yaml   # cold-start the standby from new-target
    sluice sync start --config reverse-direction.yaml
    # Wait for the copy to finish and the stream to report zero lag (sync health) BEFORE flipping traffic.

    # After the flip:
    # - Forward (sluice-1): old-source -> new-target  (stopped and drained)
    # - Reverse (sluice-2): new-target -> standby     (the rollback path; standby is hot)

If something goes wrong post-flip (the target hits a bug, query plans regress, unexpected behavior surfaces), stop sluice-2, run sluice cutover in the reverse direction to prime the standby's sequences, and flip traffic to the standby. Once you commit to the new target, stop sluice-2 and decommission the standby. The forward stream must be stopped before the reverse starts, or a change echoes new-target → standby → new-target; sluice does not detect that loop.

Cross-engine caveat. A reverse stream is a fresh translation of values the application now writes natively on the new engine. A value the old engine cannot hold (a Postgres jsonb, array or uuid written after a MySQL → Postgres cutover) is refused loudly by the reverse stream rather than coerced — which halts the rollback path exactly when it is needed. For a cross-engine cutover, option 2 is the honest rollback plan unless the application is known to stay inside both type systems.

### Option 2: a periodic snapshot of the new target

A coarser-grained rollback: take a pg_dump / mysqldump of the new target periodically post-flip. If a rollback is needed, restore the dump on the old source and switch traffic back. The window-of-loss is the time between the last dump and the rollback decision. Less load on both endpoints than option 1, but recovery is bulk-replay rather than incremental.

Why the old primary must survive the window. Either rollback path only exists while the old database is still there and consistent. Dropping it immediately after cutover throws away your rollback option; keep it until the new database has proven itself, then decommission.

## If the stream crashes in the middle of a source transaction

A restart re-delivers everything after the stream's persisted position, and the position only advances at a source transaction's commit. When the process dies partway through applying a source transaction, the target already holds part of it, and the restart replays the whole transaction on top. Most changes replay harmlessly, because sluice's apply is an idempotent upsert. Three shapes do not: a transaction that frees a unique value and reuses it, one that swaps values through a temporary, and one that changes a primary key. Through v0.156.4 those collided (23505 / Error 1062) on every restart, and the only recovery was --restart-from-scratch.

Since v0.156.5 (ADR-0190), sluice writes an apply mark for every change whose replay is not idempotent, in the same target transaction as the row, into the sluice_cdc_apply_marks control table. A mark names the source transaction and the change's position within it. On a restart, a change a mark proves already landed is skipped, so the restart converges exactly. On a target that commits a transaction atomically, a mark and its row commit together or not at all.

Not on a Vitess/PlanetScale target with a sidecar control keyspace. When the control tables live in a sidecar keyspace (--control-keyspace, or the unsharded keyspace sluice auto-detects on a sharded target), vtgate's default transaction_mode=MULTI commits the rows' shard and the control keyspace separately, with no two-phase commit. Since v0.156.7 sluice sends every row before any control-table write, so a torn commit leaves rows without their marks and the position behind them, never marks or a position past rows that did not land. The restart then re-applies those rows with no mark to skip them. There, the marked classes are at-least-once or loud, not exactly-once: a unique collision stops the stream, and a keyless table can gain a duplicate row. A change is never silently skipped. A transaction whose rows span two data shards can still tear between them; that is not covered. Details: sharded → sharded.

- Which changes write a mark: changes to a table with a UNIQUE index or constraint besides its primary key, primary-key changes (old and new key), and every change to a table with no key. A table with only a primary key writes none, so an ordinary primary-key workload pays nothing. Keyless tables on MySQL/MariaDB binlog and Postgres logical sources now land exactly once across such a crash on a target that commits atomically; before, they duplicated rows. With a sidecar control keyspace they remain at-least-once across a torn commit (above).

- Which sources: MySQL and MariaDB binlog (GTID and file/position), Postgres logical replication, PlanetScale/Vitess VStream, and the trigger-CDC sources (postgres-trigger, sqlite-trigger, d1-trigger, where each change is its own transaction). VStream COPY-phase rows carry no identity and replay as before. To support this, a VStream source is now a transaction-marker stream: the reader passes each shard transaction's BEGIN/COMMIT to the applier, so the stream saves its position at transaction commits, and the serial batched path (--apply-concurrency 1) commits once per source transaction, as it does for a MySQL binlog source — position-write cadence and batch shapes on PlanetScale/Vitess sources change accordingly. On a sharded Vitess/PlanetScale keyspace, exactly-once across a crash is best-effort: a restart may deliver another shard's transaction first, and the interrupted one then replays as before (APPLY-MARK-UNTRUSTED, below).

- Which apply paths: by default the serial paths (--apply-concurrency 1, --apply-batch-size 1) and the concurrent lanes' barrier (keyless tables, primary-key changes). Changes the lanes apply to a table with a secondary UNIQUE index are marked only with sync start --exactly-once-lanes, which is off by default because it costs a lane drain per such transaction. Without it, a crash there can still stop every restart on a loud collision, as before v0.156.5. If that matters more than lane throughput, turn the flag on or apply serially.

- Clean-up: a transaction's marks are deleted by the same target transaction that persists a position past it, and every cold start deletes the stream's marks before copying anything.

Marker · Severity · What it means, and what to do ·

APPLY-MARK-MISMATCH · terminal · A replayed change and the mark that should vouch for it disagree: the mark names the same position in the same transaction but a different change, or it was written under a different --where row filter than the stream runs with now. sluice refuses rather than skip on doubtful evidence. For a changed --where, re-run with the filter the stream was established with; otherwise re-copy with sync start --restart-from-scratch, which also clears the stream's marks. ·

APPLY-MARKS-UNAVAILABLE · WARN, at the start of an apply run · The mark table cannot be used: it could not be created (a PlanetScale branch with safe migrations, a role without CREATE), it is absent on a --schema-already-applied target, or the role lacks SELECT, INSERT, UPDATE or DELETE on it. Since v0.156.6 these role-based causes reach this WARN on a Postgres target too: every Postgres control-table ensure reads the catalog first and runs only the DDL that is missing, so a role without CREATE on the control schema, or one that does not own sluice_cdc_state, no longer stops the start earlier while sluice ensures sluice_cdc_state (on v0.156.5 it did, Bug 291). When the WARN fires, the stream runs as it did before v0.156.5: a restart after a crash mid-transaction replays the interrupted transaction, which may stop loudly on a unique collision, and a table with no usable unique key may gain a duplicate of a replayed row. Since v0.156.7 a probe of the mark table that fails with a transient error (a dropped connection, a timeout) does not produce this WARN: the apply retry loop retries it, and only a definite answer that the table cannot be used disables the marks. To enable marks, let sluice create the table, or have a role that may create it run the statements control-tables ddl --engine <target engine> prints (on a MySQL-family safe-migrations branch, ship them through deploy-ddl), and grant the apply role those four privileges. On a PlanetScale Neki target, a mark table that is created but cannot be placed in an unsharded shard group refuses with SLUICE-E-TARGET-CONTROL-TABLE-PLACEMENT instead. ·

APPLY-MARK-UNTRUSTED · WARN, at most once per apply run · A restart met a mark of a transaction that was not the first one it re-delivered, so the position had moved behind it. sluice treats the mark as no evidence and applies the change. A unique collision then stops the stream, but on a keyless table the re-apply can add a duplicate row, so compare that table against the source. Expected after a crash on a sharded Vitess/PlanetScale keyspace; on any other source it is a safety net, so please report it with the surrounding log. ·

An older sluice binary ignores the mark table and replays as it always has. Full detail: CDC streaming and ADR-0190.

### Tables without a key: a change reaches exactly one of several identical rows (v0.156.8+)

For a table with no primary key and no NOT NULL unique index, the applier names a row by its whole before-image, and a whole-row WHERE matches every identical copy. Through v0.156.7, when the source deleted or updated one of several identical rows — a Postgres table under REPLICA IDENTITY FULL, a trigger-CDC source, a MySQL binlog full image — the target deleted or rewrote every copy, at exit 0, on every apply path (every release since v0.1.0, Postgres and MySQL-family targets). Since v0.156.8 such a write reaches exactly one of the identical rows: on Postgres by (tableoid, ctid) from a LIMIT 1 sub-select, so a partitioned table's repeated ctids cannot widen it; on MySQL with LIMIT 1. The same holds for what the broker and a backup chain's restore replay, since they apply through the same appliers. The one-row addressing is used only when the target table has no key and the before-image covers every non-generated target column; a key-narrowed image instead falls to the refusal below. On a MySQL target under STATEMENT binlog format the LIMIT 1 statement is flagged unsafe for statement-based replication (warning 1592), and a sharded Vitess keyspace may refuse it — both loud, and limited to tables without a key. The (tableoid, ctid) addressing has not been tested on PlanetScale Neki (sharded Postgres).

Check after upgrading. If you have replicated a table without a primary key or NOT NULL unique index whose source can hold identical rows (an append-only log or event table, a join table without a key), and the source deleted or updated rows of it, compare the count of each distinct row between source and target — SELECT <all columns>, count(*) FROM t GROUP BY <all columns> on both sides, or a per-row hash and count — and re-copy any table whose counts differ. A target fed by a restored backup chain with incrementals is in scope too.

### Deferrable keys: KEY-SCOPED-WRITE-MATCHED-MULTIPLE-ROWS, DEFERRED-KEY-CHECK-OFF-IN-REPLICA-MODE, DEFERRED-KEY-CHECK-FAILED-AT-COMMIT

Every UPDATE and DELETE the applier issues names its row by the change's before-image. When a source sends only the row's key there — a table under REPLICA IDENTITY FULL (sluice narrows it to the primary key), or a postgres-trigger source set up with --capture-payload minimal — and the target's primary key is DEFERRABLE, a source transaction that moves key values through each other (UPDATE t SET id = id + 1, a swap) can leave two target rows sharing a key value until it commits, and the next change for that key names both. Since v0.156.8 any UPDATE or DELETE that matches more than one row is refused with KEY-SCOPED-WRITE-MATCHED-MULTIPLE-ROWS (SLUICE-E-CDC-KEY-MATCHED-MULTIPLE-ROWS, exit 3) and the target transaction holding it is rolled back, instead of changing rows the source never touched. That rollback is not always the whole source transaction: an apply batch boundary, a lane, a key change applied alone as a lane barrier, or --apply-batch-size 1 can split one source transaction across target transactions, and its earlier statements are then already committed and stay, so the table can hold a state the source never had (under a DEFERRABLE key, two rows on one key). Since v0.156.9 the message says the source transaction was split when the apply path knows it, and otherwise that earlier parts of it may already be committed; v0.156.8 said nothing was written on every path (Bug 294). The re-copy below replaces whatever part was committed. Through v0.156.7 (from v0.103.1, the first release that carried a DEFERRABLE primary key from a Postgres source), UPDATE s SET id = 2 WHERE id = 1; DELETE FROM s WHERE u = 'b' on the source deleted both rows with key 2 on the target, at exit 0. The same refusal catches a before-image narrowed to columns the target does not hold unique (a source under REPLICA IDENTITY USING INDEX whose index the target lacks), and a key-narrowed before-image against a target table without a key. A write that matches zero rows is still tolerated for resume idempotency. A key change in an order that makes keys collide cannot be applied from a key-only stream: recover with sluice sync start --reset-target-data, and keep such transactions off a replicated table. A source under REPLICA IDENTITY USING INDEX names rows by that index, which stays unique, so its key shifts apply. Under sluice sync run a leg that stops on this refusal is marked failed and not restarted.

REPLICA IDENTITY FULL on a source table whose only key is DEFERRABLE. It clears the SLUICE-E-SOURCE-REPLICA-IDENTITY refusal, but sluice still addresses each UPDATE and DELETE by that key: it narrows the published old row to the primary key, because comparing every column would miss rows whose values do not round-trip exactly. A DEFERRABLE key may be shared by two rows in the middle of a source transaction that shifts or swaps key values (UPDATE orders SET id = id + 1), so a change in that transaction can match two target rows. Since v0.156.8 the stream stops there with SLUICE-E-CDC-KEY-MATCHED-MULTIPLE-ROWS, rolls back the target transaction holding the change (earlier parts of a source transaction split across target transactions may already be committed; above), and needs a re-copy (sync start --reset-target-data) to continue; through v0.156.7 the change was applied and a row was silently lost or overwritten. If your application shifts keys, make the source key immediate instead (ALTER TABLE t DROP CONSTRAINT t_pkey; ALTER TABLE t ADD CONSTRAINT t_pkey PRIMARY KEY (...);): an immediate key is never shared by two rows, even mid-transaction, so every change names exactly one row. Check first that the application's key-shifting statements still succeed without DEFERRABLE.

DEFERRED-KEY-CHECK-OFF-IN-REPLICA-MODE (WARN). Postgres implements the deferred check of a DEFERRABLE primary key, unique constraint or exclusion constraint as an internal trigger, so session_replication_role = replica — the foreign-key bypass sluice's Postgres apply uses — switches it off too. sluice keeps replica mode, since leaving it for such a table would fire the target's own triggers on replicated rows, so during apply such a constraint holds only what the source sends. The applied rows still match the source; what can go wrong is a target constraint stricter than the source's (one the source does not have), which can end up holding duplicates it forbids. Since v0.156.8 the first time a run touches such a table it logs this WARN once, naming the table and constraint; it never stops the apply. REINDEX TABLE <table> fails if a violating row has landed. The remedy is to give the target the source's constraint: drop one the source does not have, or make it NOT DEFERRABLE so a violating row is refused at its statement.

DEFERRED-KEY-CHECK-FAILED-AT-COMMIT. With an apply role that may not set replica mode, the deferred check runs at the end of each target transaction. A source transaction that is valid only as a whole — a swap of two unique values — then applies when it lands in one target transaction and is refused at COMMIT when it is split across two, with this marker naming the constraint; nothing in that target transaction is written. A split happens on the per-change path (--apply-batch-size 1), when a key change is applied alone as a lane barrier, and wherever the batch loop flushes mid-transaction — its row cap, its byte cap, its 100 ms idle timer, a keyless-table change — so no batch size guarantees one target transaction. Because one of its causes depends on arrival timing, a restart can clear it, and sluice sync run still restarts a leg that stops on it.

### Idle MySQL and MariaDB binlog sources: the position is persisted at every binlog rotation (v0.156.9+)

The target persists a position only at a source transaction's commit, and three kinds of binlog traffic carry none: a rotation, a heartbeat event, and a standalone GTID group (a DDL, CREATE USER / GRANT, OPTIMIZE TABLE). Through v0.156.8, a connected stream that saw only those kept its persisted position in a binlog file the source then rotated past, though it had read every event and missed nothing (GC-43 (r)). Once binlog retention purged that file, the next sync start failed the resume check, and the automatic re-snapshot dropped the target's tables and copied them again (since v0.99.71; earlier releases failed the same restart loudly). In file/pos mode a fully idle source was enough; in GTID mode it took standalone groups as the last GTIDs before the purge. On MariaDB the lineage anchor also never moved past its purged file, so the restart could only proceed under UNVERIFIED-INSTANCE-IDENTITY. A source that kept committing transactions on any database was not affected, because an out-of-scope transaction still persists a position.

Since v0.156.9 the binlog reader emits an empty transaction at each rotation it reads from the binlog, whenever no source transaction is open, and the target persists it like a commit: the next file's start in file/pos mode, the executed GTID set in GTID mode, and on MariaDB the re-anchored lineage. A file can only be purged after the server rotates past it, so a connected stream persists a position past it first, and a restart after the purge resumes. Before persisting, the boundary settles every table an earlier DDL left owing a schema change, exactly as that table's next row would; if any cannot be settled at that moment, no position is persisted at that rotation. It is the binlog counterpart of the Postgres keepalive boundary, and it covers every stream that reads a MySQL/MariaDB binlog: sync (including each database of a multi-database stream) and backup stream. An idle stream now costs one position-only target transaction per binlog file. VStream sources (--source-driver planetscale / vitess) use a different reader and are not covered.

Two shapes are unchanged, and both are named in the code:

- A source server restart. The server ends its file with a stop event, not a rotation, so no position is persisted at that crossing. An idle stream whose source restarts, then purges the pre-restart file before the next rotation, still resumes from the purged file.

- An XA PREPARE as the last group of a file, on an otherwise idle GTID-mode MySQL source. sluice folds that group into the executed set only at the next group, so the rotation that follows it is skipped rather than persisted early.

For those two, --source-heartbeat-interval still helps on a MySQL-family source: each heartbeat commits a row on the source, which persists the position like any transaction. Outside them, a connected stream no longer needs the heartbeat to survive binlog retention. --no-auto-resnapshot turns any remaining drop-and-re-copy into a loud refusal instead.

Schema changes during a long-running sync. By default (--schema-changes=forward) a stream applies every unambiguous source schema change on the target — ADD/DROP COLUMN, ALTER COLUMN TYPE, and, on a MySQL source, ALTER NULLABILITY — so it stays online through routine schema evolution, including a destructive DROP COLUMN. CREATE/DROP INDEX and ADD/DROP/MODIFY CHECK reach the target on no source: the MySQL reader's boundary projection carries neither and pgoutput carries neither (ADR-0091 §1d). Indexes are a silent gap — add them on the target out-of-band. Since v0.156.0, on Postgres and MySQL/MariaDB binlog sources, a CHECK change — like any constraint, row-level-security, policy, DEFAULT or (Postgres) NOT NULL change — instead stops the stream with UNFORWARDED-SCHEMA-CHANGE at the next write to that table and stays stopped until you apply it to the target and acknowledge it (recovery); plan such DDL for a drained window. PlanetScale/Vitess sources are not covered and still pass it silently. To gate all DDL through a separate change process, start with --schema-changes=refuse. See the warning box in the sync start reference. Known open issue (GC-44): after a warm resume, the first schema change per table is not forwarded to the target, which can silently narrow values on a column type widen; until it is fixed, apply a column type change to the target yourself before running it on the source (who is exposed, how to check).

---
Canonical page: https://sluicesync.com/docs/zero-downtime-cutover/ · Full docs index: https://sluicesync.com/llms.txt
