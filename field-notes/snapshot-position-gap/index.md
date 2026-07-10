# The transaction that lands in neither the snapshot nor the binlog

> Capture the consistent snapshot and the binlog position as two separate statements, and a transaction committing between them falls into the gap: after the frozen read view, below the recorded offset. It's in neither the bulk copy nor the CDC tail. A global read lock across both closes the seam.

Observed — MySQL cold-start: freezing a consistent snapshot for the bulk copy and recording the binlog position for the CDC handoff. Internally the FTWRL-freeze fix; caught by a concurrent-writes-during-cold-start test (2299/2300 rows under -race).

## What happened

A MySQL cold-start — bulk-copy a consistent snapshot, then hand off to CDC from a recorded binlog position — intermittently lost a single row under concurrent writes. The row was in neither the snapshot copy nor the CDC tail, with no error. (It was first mis-diagnosed as a slow-apply flake and "fixed" by raising a catch-up ceiling; the row never arrived at any ceiling, because it was never in the stream at all.)

## Why (the mechanism)

The snapshot view and the start position were captured as two separate statements:

    START TRANSACTION WITH CONSISTENT SNAPSHOT;   -- freezes the read view (bulk copy)
    --   << any transaction committing HERE falls into the gap >>
    SHOW BINARY LOG STATUS;                        -- records the CDC start offset

A transaction that commits in the window between those two statements lands in neither phase: it committed after the read view froze, so the snapshot bulk-copy doesn't see it; and its binlog offset is below the position recorded a moment later, so CDC starts after it and skips it. The row exists on the source and in the binlog, but above the snapshot's cut and below the stream's cut — a silent-loss boundary exactly one transaction wide.

## What sluice does about it

Wrap the capture in FLUSH TABLES WITH READ LOCK ... UNLOCK TABLES — the mydumper/Debezium consistent-snapshot pattern — so the snapshot's read view and the recorded binlog position name the exact same logical cut, with no commit able to interleave between them. The open transaction keeps the snapshot alive after the lock is released, and writes that resume afterward are captured by CDC from the frozen position. FLUSH TABLES WITH READ LOCK needs the RELOAD privilege; without it, sluice warns and falls back to the prior lock-free capture rather than failing the run (a least-privilege single-DB user who never hits the window keeps working).

## The transferable lesson

When a cold-start hands off from a bulk snapshot to a change stream, the snapshot's consistency point and the stream's start position must be the same instant — capture them as two statements and the window between them is a silent-loss gap for any transaction that commits there (above the snapshot, below the position). The remedy is to make the two reads name one logical cut, classically by holding a global read lock across both so nothing can commit in between. This is the canonical consistent-snapshot dance — mydumper and Debezium do exactly this — and it's canonical precisely because everyone who builds snapshot-to-CDC handoff rediscovers the same one-transaction-wide hole, usually as a single mysteriously-missing row that looks like anything but a boundary bug.

## Primary sources

- MySQL consistent snapshots & FLUSH TABLES WITH READ LOCK — FLUSH and InnoDB consistent reads.

- The pattern in the wild — Debezium MySQL connector snapshot / mydumper's --trx-consistency-only.

- How sluice cold-starts and hands off to CDC — Zero-downtime migration.

---
Canonical page: https://sluicesync.com/field-notes/snapshot-position-gap/ · Full docs index: https://sluicesync.com/llms.txt
