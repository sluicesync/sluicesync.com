# Prepare a Postgres source

> What a Postgres source needs before it can feed a continuous sync — the required GUCs, the REPLICATION role attribute, replication-slot lifecycle, and the slot-less path for managed Postgres.

A one-shot migrate from Postgres needs only SELECT and works anywhere, including locked-down managed tiers. Continuous sync is different: sluice's default Postgres CDC engine reads changes through a logical replication slot, which needs a handful of cluster settings and a role privilege. This guide is the practical checklist — set these before sync start, and if your host forbids them, jump to the slot-less trigger path at the end.

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

    # Drop a named slot (prompts for confirmation; --yes skips it,
    # --force drops an active slot, --if-exists treats a missing slot as success)
    sluice slot drop sluice_slot --source-driver postgres --source 'postgres://user:pass@host:5432/app'

When you start a stream and setup fails partway (publication permissions, START_REPLICATION rejection, cancellation), the freshly-created slot is auto-dropped before the error returns — so failed cold-start attempts don't leave sluice_slot-named slots behind. Auto-cleanup deliberately skips a slot that pre-existed the call (it may carry someone else's progress) and a slot whose pump already emitted positioned changes (that's user data); for those, sluice slot drop is the explicit path.

## Slot survival under failover

This is the part that bites people. A logical slot is a primary-local object by default — when the primary fails over, the slot does not move to the new primary, and a slot left behind is silently lost: no error, no warning, your CDC stream just begins missing changes. Confirm one slot-preservation mechanism is actually configured before betting production on it:

- PlanetScale Postgres (Patroni): add the slot name to the "Logical slot name" field under Cluster configuration → Parameters → Failover (comma-delimited for multiple consumers). Slots not listed there are lost on failover.

- Self-hosted Patroni: declare it under slots: as a permanent logical slot (type logical, plugin pgoutput).

- PG 17+ native sync: sync_replication_slots = on plus hot_standby_feedback = on.

- Vanilla Postgres without HA: nothing to do — there's no failover — but still monitor slot health.

The idle-slot trap. Even with all three mechanisms configured, a slot that hasn't advanced during the slot-sync window can still be lost on failover: the standby's copy stays at an old LSN, and promotion leaves it pointing at recycled WAL (wal_status='lost' on resume). The durable fix is to keep the slot advancing — run sync start continuously (its CDC reader sends a standby-status keepalive every 10s), and on quiet sources inject lightweight WAL. sluice has this built in.

### Keeping an idle slot alive

Set --source-heartbeat-interval and sluice INSERTs a row into a source-owned table (default sluice_heartbeat) on each interval; the write generates WAL, advancing the consumer position against an idle source and preventing slot eviction (ADR-0061 / F17):

    sluice sync start \
        --source-driver postgres --source 'postgres://user:pass@host:5432/app' \
        --target-driver mysql    --target 'user:pass@tcp(host:3306)/app' \
        --stream-id app \
        --source-heartbeat-interval 30s

It is opt-in (0, off, by default) because the INSERT is a behaviour change on the source that regulated systems must enable explicitly. The heartbeat table is auto-created and periodically pruned (--source-heartbeat-prune-window, default 1h); on a role without CREATE TABLE the streamer WARNs once and continues without it. Rename the table with --source-heartbeat-table-name, or silence the warning with --no-source-heartbeat.

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

3. Tear down cleanly when the stream is finished — this drops every per-table trigger and (by default) the sluice_change_log table, leaving zero residue. Pass --keep-data to retain the change-log for forensics, or --yes to skip the confirmation prompt:

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
