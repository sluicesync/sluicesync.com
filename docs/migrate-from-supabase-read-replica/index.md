# Migrating from a Supabase read replica with sluice

> A Supabase read replica (an -rr- endpoint) is a fine bulk-migrate source that offloads the copy's read load from your primary — PG 16+ standby parallel snapshots engage unreduced — but CDC is refused: a replica can't host the sluice publication, so continuous sync must point at the primary. Plus the corrected CDC-preflight facts and how to verify safely against a lagging replica.

A Supabase read replica is managed Postgres running as a streaming-replication standby, so sluice drives it with the vanilla postgres engine. Live-probed 2026-07-17 (PG 17 replica, same region as its primary): it works as a bulk sluice migrate source with the full consistency story, and it is refused as a CDC source with a coded steer to the primary. This guide covers both, plus verifying safely against a replica. For the primary-endpoint essentials (IPv6-only direct host, Supavisor pooler modes, TLS, float display), start with the main Supabase guide.

## Bulk migrate: a first-class source

A read replica is a full bulk-migration source, and the reason to use one is load: it offloads the snapshot's read cost from the production primary. The consistency story is not reduced. pg_export_snapshot() is legal on a PG &ge; 16 standby, so sluice's parallel, snapshot-pinned copy engages unreduced on the replica — one shared snapshot across every table and chunk reader, byte-exact (float8send-proven), evaluated at the replica's replay position.

    sluice migrate \
        --source-driver postgres \
        --source 'postgres://postgres.abcdefghijkl-rr-us-east-1-xyz:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --dry-run

## Reaching the replica: DSN shapes

A replica has its own hostnames, and the routing differs by whether you use the direct endpoint or the pooler:

Path · How the replica is addressed ·

Direct · db.<ref>-rr-<region>-<suffix>.supabase.co:5432 — its own hostname, IPv6-only exactly like the primary. The IPv4 add-on covers replicas too (one PATCH gives both endpoints A records), but Supabase bills IPv4 per database, so it costs 2&times; while a replica exists. ·

Pooler · Same host/port as the primary — routing is by username: postgres.<ref> reaches the primary, postgres.<ref>-rr-<region>-<suffix> reaches the replica (session mode :5432 for sluice). ·

The password is identical to the primary (the role catalog replicates physically). Sanity-check which end you're on with SELECT pg_is_in_recovery() — t means you're on the replica.

## CDC: point at the primary, never the replica

CDC has to manage the sluice publication on the source, and CREATE/ALTER PUBLICATION cannot run on a standby. sluice refuses up front with the coded SLUICE-E-CDC-STANDBY-SOURCE steer (before the fix this surfaced as a raw SQLSTATE 25006 &ldquo;read-only transaction&rdquo; at publication ensure). PG 16+ standbys can technically host logical slots, but creation blocks on the primary's next running-xacts record and Supabase denies the pg_log_standby_snapshot() nudge that would unblock it — so the primary is the supported CDC source. Point sync start (and backup CDC chains) at db.<ref>.supabase.co, not the -rr- host.

## The CDC preflight facts (on the primary)

Once you're on the primary, three preconditions are worth knowing precisely — the first two are commonly mis-stated:

- Slots and senders default to 10 on a fresh Micro project (max_replication_slots=10, max_wal_senders=10) — plenty for one stream, but a shared budget if Realtime or ETL also consume the project. An earlier probe recorded 5/5; Supabase raised the platform default, so treat the exact number as observed in-band, not fixed.

- max_slot_wal_keep_size scales with the COMPUTE tier, not PITR — 512 MB on Micro, 2048 MB on Small+ (field-validated 2026-07-17, PG 17.6). This is the real WAL runway a detached or lagging stream has, not a paper setting: in a paired probe a detached logical slot on Small survived 1377 MB of retained WAL still wal_status='reserved' (~2.7&times; the Micro bound), while the identical slot on Micro was invalidated once retained WAL crossed ~512 MB — wal_status='unreserved' at 551 MB, then wal_status='lost' (invalidation_reason='wal_removed') after the next checkpoint, forcing a re-snapshot. The lever for a wider window is a compute-tier bump (Small → 2 GB, ~$15/mo), not the PITR add-on (~$100/mo) — PITR only reaches 2 GB transitively because it requires Small compute. sluice's slot-health probe pages at 70/85% of whatever the live bound is; keep detach windows short.

- PITR is CDC-benign. Unlike Cloud SQL's binlog toggle (which destroys positions), enabling Supabase PITR leaves wal_level, max_wal_senders, max_replication_slots, and the logical-slot LSN untouched, adds no platform slot, and never rewinds a slot's position — it only extends archived-WAL retention. A sluice CDC stream behaves identically with PITR on or off.

## Verifying against a replica: gate on replay lag

sluice verify against a lagging replica compares the target with the replica's past — it can false-flag rows the copy correctly took from the primary moments earlier, or false-clean a stale target. Prefer verifying against the endpoint you copied from (self-consistent), and treat the primary as the authoritative sign-off target. If you must verify against a replica, first confirm pg_stat_replication.replay_lag on the primary is &asymp; 0 (or that receive-LSN == replay-LSN on the replica). Two operator traps:

- now() - pg_last_xact_replay_timestamp() on the replica reads minutes of &ldquo;lag&rdquo; on an idle primary — it timestamps the last replayed transaction, not the true lag. Check replay_lag on the primary instead.

- A long copy from a replica under primary write load can be cancelled by WAL-replay recovery conflicts once it outlives max_standby_streaming_delay. sluice fails loudly; re-run, or copy from the primary.

## What sluice checks for you

- SLUICE-E-CDC-STANDBY-SOURCE — a CDC source that is a read-only standby (pg_is_in_recovery() = true) is refused up front with the primary-endpoint remedy, instead of surfacing later as a raw read-only-transaction error at publication ensure.

- Unreduced parallel snapshot on the standby — because pg_export_snapshot() works on a PG 16+ standby, sluice does not silently downgrade to a single-reader copy; the shared-snapshot parallel copy engages, byte-exact.

- Slot-health paging on the live bound — the probe reads the actual max_slot_wal_keep_size and pages at 70/85% of it, so the alert reflects your compute tier rather than a hardcoded assumption.

## Next steps

- Migrating from Supabase — the primary-endpoint guide: IPv6-only direct host, Supavisor pooler modes, TLS, and float display vs identity.

- Verify & reconcile — the verification sluice runs, and why it compares values, not display text.

- Prepare a Postgres source — the slot lifecycle and retention story for the CDC leg on the primary.

---
Canonical page: https://sluicesync.com/docs/migrate-from-supabase-read-replica/ · Full docs index: https://sluicesync.com/llms.txt
