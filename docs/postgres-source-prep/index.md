<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# Prepare a Postgres source

> What a Postgres source needs before it can feed a continuous sync — the required GUCs, the REPLICATION role attribute, replication-slot lifecycle, and the slot-less path for managed Postgres.

A one-shot migrate from Postgres needs only SELECT and works anywhere, including locked-down managed tiers. Continuous sync is different: sluice's default Postgres CDC engine reads changes through a logical replication slot, which needs a handful of cluster settings and a role privilege. This guide is the practical checklist — set these before sync start, and if your host forbids them, jump to the slot-less trigger path at the end.

Postgres schema reads need PostgreSQL 12 or newer. The schema reader references PG-12 catalog columns (pg_collation.collisdeterministic, pg_attribute.attgenerated) unconditionally, so migrate, sync, backup, schema preview and schema diff against a PG 10/11 source fail at the column read with SQLSTATE 42703 rather than degrading. The CDC lane's own floor (pgoutput, PG 10) is lower and does not help — nothing runs before the schema read. cutover carries the same 12–18 floor for the same reason.

An identity column with no backing sequence is refused at schema read. A Postgres GENERATED … AS IDENTITY column whose identity-owned sequence is absent from the catalog refuses loudly, naming the shape and --exclude-table as the remedy — rather than carrying zero-valued options that would render START WITH 0 on the target. A partition child of an identity-bearing partitioned table is not this shape: on PG 17+ information_schema reports the child's column as identity while the only identity-owned sequence belongs to the root, and sluice resolves the child's identity through its partition root exactly as Postgres does.

## Required GUCs

Logical replication is gated by a small set of server parameters. Check them as a superuser on the source:

    SHOW wal_level;                  -- must be 'logical'
    SHOW max_replication_slots;      -- >= 2 x replicas
    SHOW max_wal_senders;            -- >= 2 x replicas, and >= max_replication_slots
    SHOW max_slot_wal_keep_size;     -- '> 4GB' recommended; '-1' = unlimited (risky)

- wal_level = logical — required. Changing it needs a cluster restart; it cannot be set live.

- max_replication_slots and max_wal_senders — sized for your replica count; both need a restart to change.

- max_slot_wal_keep_size — strongly recommended > 4GB (live-reloadable). The default -1 means "retain WAL until the disk fills," which is its own bad day; a bounded cap lets a slot recover from a short consumer outage without one stuck slot filling the disk.

- For PG 17+ HA, also enable sync_replication_slots = on and hot_standby_feedback = on — see slot survival under failover.

If wal_level is not logical, sluice's CDC reader fails the precondition check at startup — before it touches any slot — with a clear message rather than a mid-stream surprise:

    postgres: cdc: wal_level is "replica"; must be 'logical' for logical replication
    (set wal_level=logical in postgresql.conf and restart)

Logical WAL costs more. Flipping wal_level from replica to logical raises the WAL byte-rate — roughly 1.2x–1.6x on a typical OLTP workload, more on wide TEXT/JSONB rows under REPLICA IDENTITY FULL. That multiplier also applies to WAL a lagging slot retains, so budget max_slot_wal_keep_size (and your backup/replica bandwidth) accordingly. Measure your own workload at logical before depending on it in production.

## The REPLICATION role attribute

The role sluice connects as must be a superuser or carry the REPLICATION attribute — creating a logical slot requires it:

    ALTER ROLE sluice_user WITH REPLICATION;

sluice does not silently degrade to polling when this is missing. A preflight probe (reading the world-readable pg_roles.rolsuper OR rolreplication) runs before the CDC reader opens, and refuses loudly — naming the role and every recovery path — rather than letting slot creation fail opaquely mid-cold-start with a raw ERROR: permission denied to create replication slot (SQLSTATE 42501):

    the source connecting role "app_user" is not a superuser and lacks the
    REPLICATION attribute. Slot-based Postgres CDC (--source-driver=postgres) creates
    a logical replication slot at cold start ... Recovery: (a) grant the attribute:
    ALTER ROLE app_user REPLICATION; (b) re-run with a superuser or replication-enabled
    role; (c) on managed Postgres that forbids the REPLICATION attribute (Heroku
    Postgres Essential, Render Basic, Supabase free), use --source-driver=postgres-trigger

There is deliberately no --allow-missing-replication escape hatch: the role genuinely cannot create a slot, so the honest choices are to grant the attribute, swap roles, or use the slot-less engine. This refusal fires only on the slot-based CDC path — a pure bulk migrate is unaffected.

## The replication slot

sluice creates one logical slot per stream, named sluice_slot by default. Override it with --slot-name; sluice prepends sluice_ if your value doesn't already start with it (so --slot-name shard_a creates sluice_shard_a). The convention lets you find every sluice-owned slot with WHERE slot_name LIKE 'sluice\_%'. Give concurrent sluice instances against the same source distinct slot names — without them they collide on the default.

List and drop slots from the CLI without dropping to psql:

    # List every slot on the source (columns mirror pg_replication_slots)
    sluice slot list --source-driver postgres --source 'postgres://user:pass@host:5432/app'

    # Drop a named slot. It NEVER prompts: without --yes it refuses with
    # SLUICE-E-CONFIRMATION-REQUIRED (exit 3), at a terminal as well as anywhere else.
    # The name is positional and LITERAL (--force drops an active slot,
    # --if-exists treats a missing slot as success)
    sluice slot drop sluice_slot --yes --source-driver postgres --source 'postgres://user:pass@host:5432/app'

When you start a stream and setup fails partway (publication permissions, START_REPLICATION rejection, cancellation), the freshly-created slot is auto-dropped before the error returns — so failed cold-start attempts don't leave sluice_slot-named slots behind. Auto-cleanup deliberately skips a slot that pre-existed the call (it may carry someone else's progress) and a slot whose pump already emitted positioned changes (that's user data); for those, sluice slot drop is the explicit path.

## Slot survival under failover

This is the part that bites people. A logical slot is a primary-local object by default — when the primary fails over, the slot does not move to the new primary, and a slot left behind is silently lost: no error, no warning, your CDC stream just begins missing changes. Confirm one slot-preservation mechanism is actually configured before betting production on it:

- PlanetScale Postgres (Patroni): add the slot name to the "Logical slot name" field under Cluster configuration → Parameters → Failover (comma-delimited for multiple consumers). Slots not listed there are lost on failover.

- Self-hosted Patroni: declare it under slots: as a permanent logical slot (type logical, plugin pgoutput).

- PG 17+ native sync: sync_replication_slots = on plus hot_standby_feedback = on.

- Vanilla Postgres without HA: nothing to do — there's no failover — but still monitor slot health.

The idle-slot trap. Even with all three mechanisms configured, a slot that hasn't advanced during the slot-sync window can still be lost on failover: the standby's copy stays at an old LSN, and promotion leaves it pointing at recycled WAL (wal_status='lost' on resume). The durable fix is to keep the slot advancing — run sync start continuously. Since v0.156.8 a connected stream does that by itself: whenever none of its source transactions is open, it persists the walsender's keepalive position as a boundary (at most one per 10 s) and the slot is released to it, so the slot follows the server's WAL even while your own tables are idle (see below). A server that writes no WAL at all leaves nothing to advance to.

### Keeping an idle slot alive

On a PostgreSQL source you do not need the heartbeat for this since v0.156.8 — the stream keeps the slot following the server's WAL by itself while it is connected (see the note below). On a MySQL or MariaDB binlog source it is no longer needed to survive binlog retention either, since v0.156.9: a connected idle stream persists its position at every binlog rotation, and the heartbeat matters there only across a source server restart or an XA PREPARE that ends a binlog file (details). Set --source-heartbeat-interval and sluice INSERTs a row into a source-owned table (default sluice_heartbeat) on each interval; the write generates WAL (ADR-0061 / F17):

    sluice sync start \
        --source-driver postgres --source 'postgres://user:pass@host:5432/app' \
        --target-driver mysql    --target 'user:pass@tcp(host:3306)/app' \
        --stream-id app \
        --source-heartbeat-interval 30s

It is opt-in (0, off, by default) because the INSERT is a behaviour change on the source that regulated systems must enable explicitly. The heartbeat table is auto-created and periodically pruned (--source-heartbeat-prune-window, default 1h); on a role without CREATE TABLE the streamer WARNs once and continues without it. Since v0.156.6 an owner can pre-create the table and grant the source role only INSERT and DELETE on it — plus, on Postgres, USAGE on its id sequence, which every heartbeat INSERT draws from; a missing sequence grant is named at startup (GRANT USAGE ON SEQUENCE) on the same WARN-and-continue path. Rename the table with --source-heartbeat-table-name, or silence the warning with --no-source-heartbeat. A pre-created table must have exactly sluice's columns (id, ts, stream_id, with sluice's types); since v0.156.9 an existing table of any other shape under the heartbeat's name stops sync start with HEARTBEAT-TABLE-NOT-SLUICES before anything is written to it.

Idle PostgreSQL sources: the slot follows the server's WAL (v0.156.8+; GC-41 (j)). The slot is released only to a position the target has persisted, and through v0.156.7 a position was persisted only at a decoded commit on one of the stream's tables. PostgreSQL 15 and later skip a transaction that touches no published table — the heartbeat's included, since its table is outside the publication — so while your tables were idle the slot stayed at their last commit and the server retained every byte of WAL written since, however busy the rest of the server was (measured: 5.69 MB retained after 135 s at about 40 KB/s of other WAL, on PostgreSQL 15 and 16, to Postgres and MySQL targets). PostgreSQL 14 and earlier advanced only when something wrote in the stream's own database. Since v0.156.8, whenever none of the stream's source transactions is open, the reader takes the walsender's keepalive position as a transaction boundary: it emits an empty one there, at most one per 10 s and only when that position has moved, which every apply path persists like a commit, and the slot is released to it once the target holds it — the rule PostgreSQL's own subscriber follows. So while sync is connected the slot trails the server's WAL by tens of seconds (measured 10–21 s on PostgreSQL 14 and 16, every apply path, Postgres and MySQL targets), on every PostgreSQL version, with or without the heartbeat. A server that then goes fully quiet still keeps the WAL written since its last activity, because restart_lsn advances only when decoding reaches a running-transactions record; it adds nothing more. The acknowledgement rule is unchanged: the slot still never passes the target's persisted position. Side effects: an idle Postgres-source stream now costs at most one position-only target transaction per 10 s, which refreshes the control row's updated_at, so sluice_seconds_since_last_apply stays low on an idle stream while the server writes WAL — re-check any alert that used it to detect an idle source (sync lag stays unknown on an idle stream rather than reporting zero). After upgrading, check that pg_replication_slots.confirmed_flush_lsn follows pg_current_wal_lsn() during idle periods; if you ran the heartbeat only for this, you can turn it off on Postgres sources.
KEEPALIVE-BOUNDARY-PASSED-COMMIT (ERROR). Safety rests on one walsender behaviour, cited from the PostgreSQL source rather than measured: a keepalive never reports a position past the commit of a transaction the walsender sends afterwards. If a delivered transaction is ever seen to commit below a boundary already emitted, the reader logs this marker at ERROR, applies the transaction anyway (stopping there could skip it on resume), and stops emitting boundaries for the rest of that connection. It is a tripwire, not a guard: it only observes an uninterrupted connection, and in the window where a violation would lose data — the boundary persisted and acknowledged, then a stop, crash or reconnect before the late commit arrives — it never fires. If you see it, verify the target against the source for changes committed near the two LSNs the line names, and report it.

## A slot acknowledged past the target's position is refused: SLOT-ACKED-PAST-TARGET-POSITION

When a sync resumes, it starts from the position the target recorded in sluice_cdc_state. PostgreSQL decodes from the later of that position and the slot's confirmed_flush_lsn. So if the slot has been acknowledged past the target's position, every change committed in between is skipped and never reaches the target. Since v0.156.7 a warm resume compares the two first and refuses with SLOT-ACKED-PAST-TARGET-POSITION, naming the slot, both LSNs and the remedy. That covers single-schema and multi-schema resumes, and the resume that finishes a stopped cold start. The refusal carries no SLUICE-E-* code, so it exits 1, and it is not retried.

How a slot gets there:

- A stop on v0.156.6 or earlier of a Postgres → MySQL-family sync (MySQL, MariaDB, PlanetScale, Vitess). Those releases acknowledged the slot at the position the reader had streamed, ahead of the target's writes. A Ctrl-C, crash, kill or apply error that ended the run while changes sat in an apply batch left the slot past them. A graceful sync stop that drained its batch did not.

- A target restored from a backup, or failed over to a replica, holding an older sluice_cdc_state row than the slot has been acknowledged to.

- A slot dropped and recreated after the stream wrote its position. One example is a --restart-from-scratch interrupted before its copy finished, which leaves the old row next to a slot created at "now".

A stream written by v0.156.7 or later does not trip it: the slot is only released to the position read back from the target, and that position never moves backward.

What to do: re-copy with sluice sync start &hellip; --restart-from-scratch, or re-copy the affected tables. If you have verified the target already holds every change up to the slot's position (for instance, every change in the gap was to a table outside this stream's filter), start once with --accept-slot-acked-past-position=<confirmed_flush_lsn>, using the LSN the refusal prints. The stream then resumes and the gap is skipped. The flag is bound to that LSN, so a slot that has moved since refuses again. It is a command-line flag only, not a syncs.yaml key, so it cannot pre-accept a later refusal. One legitimate upgrade shape can also trip the check: a Postgres → Postgres stream last written by an older release whose final persisted position was a mid-transaction schema-change anchor. Its resume was lossless, and the acknowledgement is the right answer there.

The same door on the other resume paths (v0.156.9 wording). The check runs inside the Postgres CDC reader, so every caller that resumes a slot reaches it, and since v0.156.9 the refusal names the position it was given and the remedy that fits:

- sync start --position-from-manifest resumes from the end position of the backup chain the target was restored from, and the refusal names that chain. The remedy is to restore from a fresh full backup and hand off from its chain, or to re-copy with --restart-from-scratch; --accept-slot-acked-past-position applies here as it does on a warm resume.

- backup stream and backup incremental resume from the end position of the chain's last committed manifest. Their chain preflight refuses a slot that is already past it before the stream opens; this door is the backstop for a slot that moves after that check, and the only guard when backup stream reopens its pump after a transient error. There the refusal names the chain's end position and says no link of the chain holds the skipped changes. The remedy is a new chain from a full backup (backup full --chain-slot anchors a slot at the backup's own position). There is no acknowledgement for a chain, by design: the chain preflight that refuses the same shape has none, and a chain that skipped the gap would restore without it on every restore that crossed it.

Check after upgrading. Upgrading stops new loss; it does not restore rows an older release already lost. A stream that already resumed on v0.156.6 or earlier after such a stop skipped its gap at that resume, and this check cannot see it any more, because the target has since persisted positions past the slot. For each Postgres → MySQL-family stream stopped by Ctrl-C, a crash, a kill or an apply error on one of those releases, compare pg_replication_slots.confirmed_flush_lsn with the LSN in the target's sluice_cdc_state.source_position before its first resume on v0.156.7. If the slot is past it, re-copy. For a stream that has already resumed, compare row counts per table (or run sluice verify) against the source, and re-copy what differs.

Under sluice sync run, a leg that stops on this refusal is marked failed and not restarted.

## Slot health and telemetry

A logical slot moves through these states, visible in pg_replication_slots.wal_status:

wal_status · Meaning ·

reserved · Healthy — all required WAL is on disk. ·

extended · Healthy but the consumer is behind; the slot holds more WAL than max_wal_size. ·

unreserved · Required WAL has left pg_wal but is still recoverable. ·

lost · Required WAL is gone. The slot exists but cannot be used — silent-loss-class for CDC. ·

When sluice sees a slot in unreserved or lost state it refuses to start replication and points at the recovery path — sluice slot drop on the source, then restart with an empty position to force a fresh snapshot, and raise max_slot_wal_keep_size to prevent recurrence. After dropping the slot, get past the cold-start refusal on the (partially-streamed) target with sync start --reset-target-data --yes (clears sluice's state and drops the source-schema tables it manages, then re-snapshots; see ADR-0023).

For proactive monitoring, sluice surfaces PG 14+ per-slot decode-spill counters (large transactions spilling the ReorderBuffer to disk — sustained spill is what can fill pg_replslot/ and invalidate a slot) in two places:

    # sync health prints them when the source is PG 14+ and the slot has decoded
    sluice sync health --source-driver postgres --source ... \
        --target-driver postgres --target ... --stream-id app
      ...
      spill_txns: 17
      spill_bytes: 5242880

    # Prometheus /metrics (when --metrics-listen is set on sync start)
    sluice_pg_slot_spill_txns_total{stream_id="app",slot="sluice_slot"} 17
    sluice_pg_slot_spill_bytes_total{stream_id="app",slot="sluice_slot"} 5242880

Both counters are cumulative since slot creation, so alert on the rate (rate(sluice_pg_slot_spill_bytes_total[5m])). sluice deliberately omits the lines — rather than printing 0 — when it can't tell (PG < 14, the slot hasn't decoded yet, or a non-Postgres source), so "no signal" is never mistaken for "no spill." If they climb, raise logical_decoding_work_mem on the source (live-reloadable) and split oversized application transactions.

## Managed / locked-down Postgres: the slot-less trigger engine

When the host forbids logical replication — Heroku Postgres, RDS without the right grants, Supabase / Crunchy starter tiers — you cannot get a replication slot at all. sluice's answer is the postgres-trigger engine: per-table plpgsql triggers write every change into a capture table (sluice_change_log) and the engine tails it — Bucardo-style CDC with no slot and no REPLICATION attribute (ADR-0066). The lifecycle is explicit — setup → run → teardown — so the source-side DDL is visible at the CLI, never silently applied on first sync.

1. Install the capture triggers. --tables is required. On a tier that also denies event-trigger creation (needed for automatic DDL detection), add --allow-polled-fingerprint to opt into the weaker polled schema-fingerprint fallback — the command refuses loudly without it so you acknowledge the trade-off:

    sluice trigger setup \
        --source-driver postgres-trigger \
        --dsn 'postgres://user:pass@host:5432/app' \
        --tables orders,customers,line_items \
        --allow-polled-fingerprint

2. Stream with the trigger engine. The source driver is postgres-trigger; everything else is an ordinary sync start:

    sluice sync start \
        --source-driver postgres-trigger --source 'postgres://user:pass@host:5432/app' \
        --target-driver postgres         --target 'postgres://user:pass@target:5432/app?sslmode=require' \
        --stream-id app

3. Tear down cleanly when the stream is finished — this drops every per-table trigger and (by default) the sluice_change_log table, leaving zero residue. Pass --keep-data to retain the change-log for forensics. --yes skips the confirmation prompt, and is required anywhere stdin is not a terminal &mdash; a script, a CI job or an agent gets SLUICE-E-CONFIRMATION-REQUIRED (exit 3) with nothing torn down:

    sluice trigger teardown \
        --source-driver postgres-trigger \
        --dsn 'postgres://user:pass@host:5432/app' --yes

The connecting role needs CREATE on the target schema, TRIGGER on each replicated table, and INSERT on sluice_change_log — a much smaller ask than REPLICATION. Tune how much of each row the capture writes with --capture-payload (full / changed / minimal), and reap durably-applied change-log rows while the sync runs with sluice trigger prune. The full command surface is in the trigger reference, and the trigger-CDC walkthrough lives in Getting started.

## Next steps

- sync start — every flag for the continuous-sync command, including --metrics-listen and the notify thresholds.

- trigger setup / teardown — the slot-less engine's full reference.

- Getting started: trigger-based CDC — a worked slot-less walkthrough.

---
Canonical page: https://sluicesync.com/docs/postgres-source-prep/ · Full docs index: https://sluicesync.com/llms.txt
