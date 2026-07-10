# Comparing 32-bit transaction ids breaks after four billion of them

> A trigger-CDC hold-back compared a change row's 32-bit xmin against a 64-bit xid8 snapshot bound. At XID epoch 0 the two domains coincide and everything works; once a cluster crosses 2^32 lifetime transactions the predicate goes always-true and silently skips an in-flight transaction's rows.

Observed — the postgres-trigger CDC engine (trigger-based capture, no replication slot). Live-confirmed on a pg_resetwal -e 5 epoch-bumped PostgreSQL 16.

## What happened

The postgres-trigger engine's snapshot→CDC cold-start handoff has two guards that decide which change-log rows are safe to hand off: a safety-lag hold-back and the cold-start anchor. Both compared a change-log row's system xmin against the boundary of the copy's snapshot. On a fresh cluster this is correct. On a long-lived, busy cluster whose lifetime transaction count has crossed 232, the hold-back predicate becomes always true — the watermark advances past an in-flight transaction's already-allocated change-log ids, and that transaction's changes are silently skipped when it commits — and the anchor's >= arm never matches, degenerating to MAX(id) and re-opening a cold-start gap. Exit 0, zero warnings, missing rows.

## Why (the mechanism)

Postgres's transaction id (xid) is a 32-bit counter that wraps. To compare ids across the wraparound boundary Postgres offers xid8 — a 64-bit, epoch-extended id that never wraps in practice. The bug was a cross-domain comparison hiding in plain sight: the change-log row's system xmin is a 32-bit epoch-less xid, while pg_snapshot_xmin(pg_current_snapshot()) returns a 64-bit epoch-carrying xid8. At epoch 0 the numeric values coincide, so the comparison looks correct and passes every test written on a young database. Past 232 lifetime transactions the epoch on the xid8 side is &ge; 1 while the raw xmin has wrapped back toward 0 — the two numbers are now in different domains, and the ordering the predicate depends on is meaningless. An in-code comment had even treated the cast as a JSON-precision detail rather than a cross-domain comparison.

## The repro

You don't have to run four billion transactions — pg_resetwal can move the epoch directly:

    # Bump the XID epoch on a stopped cluster so snapshot xmin > 2^32:
    pg_resetwal -e 5 $PGDATA
    # Start it, run the trigger-CDC cold-start handoff, and observe:
    #   - the hold-back predicate emits a committed row while an older
    #     transaction with a LOWER change-log id is still open
    #   - the anchor query returns MAX(id) instead of the intended bound
    # At epoch 0 (a fresh initdb) the identical handoff is correct.

## What sluice does about it

Both queries now compare the capture trigger's own txid column — recorded as pg_current_xact_id()::text::bigint, which is xid8 on both sides of the comparison — instead of the row's 32-bit system xmin. That is what the engine's design intended all along: txid has been NOT NULL since the engine's first release, so existing installs need no ALTER, and behavior at epoch 0 is byte-for-byte unchanged (verified live). The fix is pinned by SQL-shape unit tests plus an epoch-bump integration test that gates on pg_resetwal -e 5 pushing snapshot xmin above 232 and asserts the hold-back and anchor land correctly.

## The transferable lesson

Postgres transaction ids are 32 bits and they wrap — that is not an edge case, it is the routine steady state of any long-lived busy cluster (it is why autovacuum exists). Any comparison of transaction ids that must stay correct across the life of the database has to be done in the xid8 / epoch-extended domain, on both sides. A comparison that mixes a 32-bit xid with a 64-bit xid8 is a time bomb whose fuse is exactly 232 transactions long, and it will test green for the entire life of your CI.

## Primary sources

- PostgreSQL — Preventing Transaction ID Wraparound Failures — why 32-bit xids wrap and the epoch matters.

- PostgreSQL — Transaction ID and Snapshot Information Functions — xid8, pg_current_xact_id(), pg_snapshot_xmin().

- sluice's trigger-CDC handoff — How sluice copies your data.

---
Canonical page: https://sluicesync.com/field-notes/xid-wraparound-cdc/ · Full docs index: https://sluicesync.com/llms.txt
