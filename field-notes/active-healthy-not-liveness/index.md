# ACTIVE_HEALTHY through a five-minute recovery

> Flooding a 1 GB Supabase Micro instance with WAL pushed it into crash recovery — FATAL 57P03, every connection refused for five and a half minutes while it replayed — and the Supabase Management API kept reporting status=ACTIVE_HEALTHY. A control-plane status field is an assertion of intent, not a data-plane liveness signal, so it is misleading for backend readiness: probe with a real query. The finding rode a separate, concrete result: a logical replication slot's WAL runway is set by the compute tier (512 MB on Micro, 2 GB on Small), not by the PITR add-on, live-proven with a paired differential.

Observed — a live probe on a Supabase PostgreSQL 17.6.1 project (us-west-1, 2026-07-17, torn down). No data loss: the WAL was synthetic logical messages, the corpus untouched. The slot-runway advisory shipped field-validated; the ACTIVE_HEALTHY-through-crash-recovery behavior is a Supabase Management API observation, not a sluice bug. Both halves matter to anyone automating a migration against a managed provider's control plane.

## The slot's WAL runway is the compute tier's, not the PITR add-on's

A detached or slow logical replication slot survives only as long as the server is willing to retain the WAL it hasn't consumed — governed by max_slot_wal_keep_size. On Supabase that ceiling is set by compute tier: 512 MB on Micro, 2048 MB on Small, applied at the resize restart. It is not, as one might assume, a function of the point-in-time-recovery add-on. A paired differential made this concrete. A detached pgoutput slot (active=false) on a Small instance climbed to 1377 MB of retained WAL still at wal_status='reserved' — about 2.7× the Micro ceiling, safe_wal_size still +720 MB, never even reaching extended. The identical detached slot on a Micro went wal_status='unreserved' with a negative safe_wal_size at 551 MB, then wal_status='lost' with invalidation_reason='wal_removed' after the next checkpoint — a forced re-snapshot. So the lever for a wider detach or downtime window is a compute bump (~$15/mo to Small for 2 GB), not the ~$100/mo PITR add-on — which only reaches 2 GB transitively because it requires Small.

## The status field stayed green through crash recovery

The sharper finding surfaced while pushing the Micro repro. Bulk-generating multiple GB of incompressible WAL at ~150 MB/s against a 1 GB-RAM Micro drove the instance into crash recovery: FATAL 57P03: the database system is not accepting connections / Hot standby mode is disabled, every connection refused for about five and a half minutes (16:38:34→16:44:10 UTC) while it replayed WAL. Throughout that window, the Supabase Management API kept reporting status=ACTIVE_HEALTHY. The control-plane status field did not reflect the in-database outage — it is an assertion about the platform's intent for the instance, not a probe of whether the backend is accepting queries, so it is misleading if you read it as backend liveness.

There is a grim symmetry in how it ended: the checkpoint that completed crash recovery is precisely the one that flipped the over-budget slot from unreserved to lost. The slot outlived the crash and died on the checkpoint that ended it.

## What this means for a migration tool

sluice's slot-runway advisory now reflects the compute-tier ceiling rather than treating retention as a PITR property — the guidance for widening a detach window is a compute bump, stated where it matters. But the status-field lesson generalizes past any one tool: a snapshot-then-CDC migration that polls a provider's control-plane status to decide whether the source is healthy enough to proceed can be told &ldquo;healthy&rdquo; while every connection is being refused. The only trustworthy liveness signal is a real query against the backend — SELECT 1, or the slot's own pg_replication_slots row — not the dashboard's green.

## The transferable lesson

A managed provider's status endpoint is a control-plane assertion, not a data-plane liveness guarantee. An undersized or overloaded instance can be in crash recovery, refusing every connection, while the API and dashboard stay ACTIVE_HEALTHY — so probe the backend with a real query before you trust &ldquo;healthy,&rdquo; especially before a step that assumes the source is reachable. And when you reason about how long a replication slot can survive a detach or a slow consumer, find the setting that actually governs the WAL runway — here the compute tier, not the backup add-on the intuition reaches for — and validate it with a paired differential rather than inferring it from the pricing page.

## Primary sources

- PostgreSQL documentation — pg_replication_slots (wal_status reserved/extended/unreserved/lost, safe_wal_size) and max_slot_wal_keep_size; error 57P03 (cannot_connect_now) during recovery.

- Supabase — compute add-ons and per-tier max_slot_wal_keep_size (512 MB Micro / 2048 MB Small), the Management API project-status endpoint, and PITR (requires Small).

- sluice managed-services advisory (compute-tier slot runway) and the 2026-07-17 Supabase compute-tier probe — the paired Small-vs-Micro slot-survival differential and the crash-recovery-through-ACTIVE_HEALTHY incident.

- Related field notes — the alert cleared at the exact moment the slot died and replication slots don't die with your process (the same control-plane-vs-data-plane theme, at the slot).

---
Canonical page: https://sluicesync.com/field-notes/active-healthy-not-liveness/ · Full docs index: https://sluicesync.com/llms.txt
