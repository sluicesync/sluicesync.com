# Every HA knob on, and the slot still vanished at failover

> Patroni slot-sync on, sync_replication_slots on, hot_standby_feedback on — and a logical slot that hadn't advanced during the sync window was still lost on promotion. “HA-replicated” means the slot's LSN is copied on a timer, not that the slot can't be lost.

Observed — Postgres HA (Patroni / PG 17 native slot sync) source, failover during a quiet-source window. Operator-confirmed in production. See Prepare a Postgres source.

## What happened

Every mechanism for surviving a failover was configured: Patroni slots: (the permanent logical slot), sync_replication_slots = on, and hot_standby_feedback = on. A failover promoted the standby, and the CDC stream came back with wal_status = 'lost' — the slot was present but invalid, pointing at WAL that no longer existed. Nothing in Postgres's logs named the dropped slot at failover time; it surfaced only when the consumer reconnected.

## Why (the mechanism)

Slot sync — Patroni's, and PG 17's native equivalent gated by logical_slot_sync_timeout (default 300s) — is a primary→standby pull on a timer. The standby periodically copies the slot's LSN from the primary. The copy is therefore only ever as fresh as the last time the primary's slot advanced. If the primary's slot has not moved for the duration of the sync window — because the source is quiet, the consumer is paused, or the consumer's host is down — the standby's replica copy stays pinned at an old LSN. Promote that standby, and the new primary's slot points at WAL that has already been recycled: wal_status = 'lost' on the next resume.

The counter-intuitive part: the fragile case is the idle slot, not the busy one. A slot that isn't advancing can't be synced fresh, so “no traffic” — which feels safe — is exactly the condition that lets a failover strand it.

## The diagnostic

A failover is hard to stage on demand, but the precondition is observable: watch whether the slot's confirmed_flush_lsn advances on your workload.

    SELECT slot_name, wal_status, active, confirmed_flush_lsn
    FROM pg_replication_slots
    WHERE slot_type = 'logical';

    -- On a quiet source, sample confirmed_flush_lsn over time. If it does
    -- NOT advance for hours, the standby's synced copy is frozen at that
    -- LSN — and a failover during that window will surface wal_status='lost'
    -- on resume. Advancement rate is the pre-production check.

## What sluice does about it

Keep the slot advancing, two ways, and fall through cleanly if it's lost anyway:

- Keep the consumer active. sluice's PG CDC reader sends pg_send_standby_status_update every 10 seconds whether or not events are flowing, so the slot reads as active from the primary's perspective and the standby's sync keeps pace. The operational rule: run sync start continuously, not as a one-shot during low-traffic windows.

- Make a quiet source advance on purpose. For genuinely idle databases, inject WAL activity with SELECT pg_logical_emit_message(false, 'sluice-heartbeat', '') on a timer — it writes to WAL without modifying any user data (sluice's reader sees and discards it), guaranteeing the slot moves even if the active consumer briefly disconnects.

- Backstop. If the slot is lost regardless, sync start --resume detects it, drops it, and falls through to a fresh cold-start rather than silently stalling.

## The transferable lesson

“HA-replicated” for a logical replication slot means the slot's LSN is copied to the standby on a timer — not that the slot cannot be lost. Because the sync copies a position, a slot that doesn't advance can't be synced fresh, which inverts the usual intuition: the idle slot is the fragile one, not the busy one. On a quiet source, don't rely on the slot's position drifting forward on its own — make it advance, with an active consumer or an explicit WAL heartbeat. This is a specific instance of a broader Postgres-slot truth we hit from the other side too: a slot's lifetime is the server's to manage, not your process's.

## Primary sources

- PG 17 logical replication slot synchronization & logical_slot_sync_timeout — logical replication failover.

- pg_logical_emit_message (a WAL write with no user-data change) — logical decoding message functions.

- Patroni permanent slots & slot failover — Patroni dynamic configuration.

- sluice's Postgres source prep and the idle-slot mitigations — Prepare a Postgres source.

---
Canonical page: https://sluicesync.com/field-notes/postgres-idle-slot-failover/ · Full docs index: https://sluicesync.com/llms.txt
