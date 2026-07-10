# REPLICA IDENTITY FULL silently ate our UPDATEs

> Build a CDC UPDATE's WHERE clause over every old column and it works forever on int and varchar. Then a jsonb column rides along unchanged, its old value fails the equality round-trip, the UPDATE matches zero rows, and idempotency tolerance swallows the miss.

Observed — Postgres logical-replication (slot-based) source, tables set to REPLICA IDENTITY FULL. Internally Bug 92 (CRITICAL silent loss, fixed v0.85.2).

## What happened

A Postgres-to-Postgres CDC stream silently diverged on the core, most-tested engine. An UPDATE that changed a cheap column on a table with REPLICA IDENTITY FULL never landed on the target — the applier logged zero rows affected op=update at INFO and moved on. Exit 0, no error, no lag. The target kept the stale row indefinitely. Every prior test on this path had passed, for months.

## Why (the mechanism)

With REPLICA IDENTITY FULL, Postgres ships the entire old row image in each UPDATE's pgoutput old-tuple. The tempting thing for a CDC applier to do is build the UPDATE's WHERE clause over every old column — it's right there, and it's a superset of the key. That works perfectly as long as every column's old value survives the pgoutput decode → rebind round-trip as an exact = match. Integers and varchar always do. A rich type does not: a jsonb value (or timestamptz, bytea, high-precision numeric) that rides along unchanged in the old tuple can fail the = predicate after the decode&ndash;rebind round-trip — semantically equal, not byte-equal in the way the equality operator sees. The WHERE matches zero rows, and the idempotency tolerance that makes replay safe (a zero-row UPDATE is normal during re-apply) swallows the miss. Silent UPDATE loss on the engine you trust most.

The asymmetry is the tell: the DELETE path had narrowed its WHERE to identity-key columns since an earlier fix; the UPDATE path never got the symmetric narrowing, and the entire prior FULL-plus-UPDATE test corpus used only int and varchar columns, which round-trip exactly, so the = always matched and the loss never surfaced.

## The repro

Set a table to REPLICA IDENTITY FULL, give it a jsonb column, and update a different column while CDC tails it:

    CREATE TABLE ledger (
      id     bigint PRIMARY KEY,
      seq    bigint,
      doc    jsonb,          -- rides along unchanged in the FULL old-tuple
      note   text
    );
    ALTER TABLE ledger REPLICA IDENTITY FULL;
    INSERT INTO ledger VALUES (1, 1, '{"k":"v"}', 'a');

    -- with a CDC stream tailing the slot, on the source:
    UPDATE ledger SET seq = 30000 WHERE id = 1;   -- doc untouched

    -- source: seq = 30000.  target (before the fix): still seq = 1,
    --   applier logs "zero rows affected op=update", exit 0, no error.

What surfaced it in practice was a differential test: the same workload run through two independent CDC implementations — the slot-based engine and a trigger-based variant — with the two targets diffed. The brand-new variant was correct; the proven engine was wrong.

## What sluice does about it

The fix narrows the UPDATE's Before image to the identity-key columns under FULL, so the WHERE becomes id = $1 — mirroring the DELETE path's existing narrowing. It is pinned with a family matrix in the spirit of the pin-the-class rule: numeric / jsonb / bytea / temporal columns &times; FULL + UPDATE, because a green test on one representative rich type proves nothing about the others.

## The transferable lesson

Treat rich types — jsonb, timestamptz, bytea, high-precision numeric — as radioactive in equality predicates: a value that is semantically unchanged is not guaranteed to compare = after a decode&ndash;rebind round-trip. Narrow replication WHERE clauses to identity-key columns, never the full old tuple. And if you have two implementations of one contract, make them testify against each other — a differential run caught a CRITICAL silent-loss bug in the proven engine that months of single-implementation tests had missed.

## Primary sources

- Postgres REPLICA IDENTITY — ALTER TABLE &hellip; REPLICA IDENTITY (what FULL ships in the old tuple).

- Postgres logical-decoding output — logical replication message formats.

- sluice CDC behavior across engines — How sluice copies your data.

---
Canonical page: https://sluicesync.com/docs/field-notes/replica-identity-full-updates/ · Full docs index: https://sluicesync.com/llms.txt
