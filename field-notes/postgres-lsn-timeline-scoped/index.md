# A Postgres LSN means nothing without its timeline

> A logical-replication LSN is only comparable within a (system_id, timeline) tuple. Resume after a PITR or a promotion and the same slot name and same stored LSN point into a different WAL reference frame — the source streams from it happily, and events are silently skipped or replayed.

Observed — Postgres logical-replication (slot-based) source, resume after a source-side PITR / standby promotion / base-backup clone. Internally ADR-0051 (a severity-A finding from a Postgres-internals audit).

## What happened

A CDC stream resumed against a source that had been point-in-time-restored, picked up from its persisted (slot, lsn) position, and silently diverged. No error, no gap in the logs. The slot still existed by name; the stored LSN was still a valid-looking number; the source streamed WAL from it without complaint. But the rows that landed were not the rows that should have.

## Why (the mechanism)

A Postgres LSN is not a global coordinate. It is only meaningful within a (system_id, timeline) tuple: the system_id identifies a specific cluster, the timeline identifies a specific branch of its WAL history. LSN values from one timeline are simply not comparable to LSN values from another. Three ordinary operational events change that reference frame out from under a stored position:

- a standby promotion increments the timeline (same system_id, new timeline);

- a PITR can produce a new timeline within the same cluster, or a fresh cluster from a base backup (new system_id);

- pointing the tool at a different instance that happens to share the DSN host:port shape (a clone) — new system_id entirely.

The replication protocol hands you the identity on a plate — IDENTIFY_SYSTEM returns (systemid, timeline, xlogpos, dbname) before START_REPLICATION — but it is easy to call it only on cold-start to read xlogpos and discard the rest. Do that, and on resume you send the old LSN into the new timeline's WAL and the server obliges. The divergence is silent because nothing on either side is looking at the mismatch.

The sharp contrast is MySQL: a GTID set from a different server_uuid simply fails GTID_SUBSET against the new source's executed set, so the same class refuses itself for free. Postgres's raw LSN carries no such self-identifying provenance — you have to pin it yourself.

## The repro

    -- capture the identity the LSN belongs to, before you trust the LSN:
    IDENTIFY_SYSTEM;
    --  systemid            | timeline | xlogpos   | dbname
    --  7382...             |        1 | 0/1A2B3C4 | app

    -- promote a standby (timeline -> 2), or PITR, then reconnect and:
    IDENTIFY_SYSTEM;
    --  systemid            | timeline | xlogpos   | dbname
    --  7382...             |        2 | 0/95F00A0 | app
    --            same slot name, same stored LSN 0/1A2B3C4 — but timeline 2's
    --            WAL frame. Streaming from it is silently wrong.

## What sluice does about it

sluice pins (SystemID, Timeline) from IDENTIFY_SYSTEM onto the persisted position token and re-issues IDENTIFY_SYSTEM on every reconnect — before the slot-existence check, so a diverged source surfaces "source identity has changed" rather than a misleading "slot missing." On divergence it names both the old and new (systemid, timeline) so an operator can confirm the change matches their intended PITR/promotion, and refuses by wrapping the same position-invalid sentinel that routes a missing slot to a loud cold-start fall-through. There is deliberately no --ignore-source-identity-change flag: the old LSN is by definition meaningless against the new source, so "stay strict" is the only honest semantic. (Legacy tokens with no pin are accepted once, with an INFO line, then pinned going forward.)

## The transferable lesson

If you persist a Postgres LSN, persist the (system_id, timeline) it belongs to alongside it, and compare on every reconnect. A stored replication position is a coordinate in a reference frame, not an absolute address — and the ordinary HA events you most want to survive (failover, restore) are exactly the ones that change the frame while leaving the slot name and the number looking valid. Unlike a GTID, a bare LSN won't catch its own staleness for you; that check is yours to write, and its absence is a silent-loss class.

## Primary sources

- Postgres replication protocol — IDENTIFY_SYSTEM and START_REPLICATION (the identity tuple returned before streaming).

- Timelines and how promotion/PITR create them — WAL timelines.

- sluice's Postgres source preparation — Prepare a Postgres source.

---
Canonical page: https://sluicesync.com/field-notes/postgres-lsn-timeline-scoped/ · Full docs index: https://sluicesync.com/llms.txt
