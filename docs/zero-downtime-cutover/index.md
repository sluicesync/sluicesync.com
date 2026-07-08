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

The safety net for a cutover is a reverse sync. Until you're confident in the new database, keep the old primary intact — do not drop or repurpose it. If something goes wrong after you flip traffic and you must fail back, you point the application at the old database again — but any writes the new database took while it was live need to travel back the other direction.

You can't naively cold-start a reverse sync (new → old) to carry them: the old database still holds all its original rows, so it isn't empty, and a fresh cold-start refuses loudly rather than bulk-copy into a populated target — SLUICE-E-COLDSTART-TARGET-NOT-EMPTY. That refusal is the guard working as designed; you don't want a full re-copy, you want just the delta. Two ways to be ready for it:

- Run the reverse stream from the start (recommended for true reversibility). Right after the forward cutover, start a second stream in the opposite direction with its own --stream-id, so the old database keeps tracking the new one continuously. Failing back is then just a traffic flip plus a cutover on the old side to re-prime its sequences — no re-copy, no refusal.

- Reconcile the delta manually. If you didn't keep a reverse stream running, resync the window of new-database writes back to the old database the other direction and verify before re-flipping traffic — rather than forcing a cold-start into the non-empty old database.

Why the old primary must survive the window. The reverse path only exists while the old database is still there and consistent. Dropping it immediately after cutover throws away your rollback option; keep it until the new database has proven itself, then decommission.

Schema changes during a long-running sync. By default a stream forwards unambiguous source DDL (ADD/DROP/ALTER COLUMN, CREATE/DROP INDEX, …) onto the target automatically so it stays online through schema evolution — including a destructive DROP COLUMN. To gate DDL through a separate change process, start with --schema-changes=refuse. See the warning box in the sync start reference.

---
Canonical page: https://sluicesync.com/docs/zero-downtime-cutover/ · Full docs index: https://sluicesync.com/llms.txt
