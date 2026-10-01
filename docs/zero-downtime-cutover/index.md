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

Restarting with the same --stream-id warm-resumes from the persisted position — it does not re-run the snapshot. To run it as a long-lived service with a health endpoint and an idle-source heartbeat (so the slot/binlog can't be evicted past the consumer during quiet periods), add --metrics-listen :9090 and --source-heartbeat-interval 30s; see running as a service and the sync start reference.

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

Schema changes during a long-running sync. By default (--schema-changes=forward) a stream applies every unambiguous source schema change on the target — ADD/DROP COLUMN, ALTER COLUMN TYPE, and, on a MySQL source, ALTER NULLABILITY — so it stays online through routine schema evolution, including a destructive DROP COLUMN. CREATE/DROP INDEX and ADD/DROP/MODIFY CHECK reach the target on no source: the MySQL reader's boundary projection carries neither and pgoutput carries neither (ADR-0091 §1d). Indexes are a silent gap — add them on the target out-of-band. Since v0.156.0, on Postgres and MySQL/MariaDB binlog sources, a CHECK change — like any constraint, row-level-security, policy, DEFAULT or (Postgres) NOT NULL change — instead stops the stream with UNFORWARDED-SCHEMA-CHANGE at the next write to that table and stays stopped until you apply it to the target and acknowledge it (recovery); plan such DDL for a drained window. PlanetScale/Vitess sources are not covered and still pass it silently. To gate all DDL through a separate change process, start with --schema-changes=refuse. See the warning box in the sync start reference.

---
Canonical page: https://sluicesync.com/docs/zero-downtime-cutover/ · Full docs index: https://sluicesync.com/llms.txt
