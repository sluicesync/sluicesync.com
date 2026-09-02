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

The contrast with MySQL is narrower than it first looks, and an earlier version of this note overstated it. In GTID mode the position is self-identifying: every GTID names the server_uuid that produced it, so a set from a different instance can be caught by a containment check against the new source. But "can be" is doing work in that sentence. The containment check sluice runs on that arm today is GTID_SUBSET(@@gtid_purged, resume) — "has the resume point been purged?" — which a fresh instance with an empty gtid_purged passes; it does not yet ask "did this server ever execute it?" (an open finding from the 2026-09-01 audit, recorded, not yet fixed). And in file/pos mode — gtid_mode=OFF, MySQL 8's default — a binlog filename and byte offset carry exactly as much provenance as a raw LSN: none. sluice binds those positions to the source's @@server_uuid and refuses a mismatch, and the backup-captured half of that stamp only arrived in v0.137.2, after a cross-instance resume was shown to skip rows at exit 0. So the honest statement is that neither engine hands you this for free: Postgres's raw LSN carries no self-identifying provenance, and MySQL's does only in one of its two modes — in both cases you pin the identity yourself.

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

If you persist a Postgres LSN, persist the (system_id, timeline) it belongs to alongside it, and compare on every reconnect. A stored replication position is a coordinate in a reference frame, not an absolute address — and the ordinary HA events you most want to survive (failover, restore) are exactly the ones that change the frame while leaving the slot name and the number looking valid. A bare LSN won't catch its own staleness for you — and neither will a MySQL binlog file/offset, which is why sluice stamps @@server_uuid onto those too; that check is yours to write, and its absence is a silent-loss class.

## Primary sources

- Postgres replication protocol — IDENTIFY_SYSTEM and START_REPLICATION (the identity tuple returned before streaming).

- Timelines and how promotion/PITR create them — WAL timelines.

- sluice's Postgres source preparation — Prepare a Postgres source.

---
Canonical page: https://sluicesync.com/field-notes/postgres-lsn-timeline-scoped/ · Full docs index: https://sluicesync.com/llms.txt
