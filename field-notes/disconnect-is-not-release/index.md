# Disconnect is not release — Postgres lets go of a replication slot asynchronously, and 55006 means two opposite things

> When a logical-replication client disconnects, Postgres does not synchronously mark the slot inactive — the walsender releases it on its own schedule: near-instant in practice, whole seconds under a contended CI scheduler, bounded in the worst case only by wal_sender_timeout (default 60s). Anything that runs at 'the client is gone' races that window and hits SQLSTATE 55006 — on both sides of the slot lifecycle — and the error text gives you nothing to distinguish 'prior owner not yet reaped' from 'genuinely concurrent second writer'.

Observed &mdash; a sluice release-tag CI flake: an integration test stopped its streamer, waited for Run to return, then called pg_drop_replication_slot &mdash; and lost the race to the walsender, which had not yet let go. The drop-side retry landed in sluice v0.99.289; the START_REPLICATION-side bounded retry has guarded the product path for much longer.

## The asynchronous release

&ldquo;My connection closed&rdquo; and &ldquo;the slot is free&rdquo; are different events, ordered by nothing you control. The client-side socket closes; the server-side walsender process notices, tears down, and only then clears pg_replication_slots.active. Under load that gap stretches to whole seconds, and its worst-case bound is not your teardown code &mdash; it is wal_sender_timeout, default 60 seconds. Both lifecycle operations race it:

    START_REPLICATION ...      -> ERROR: replication slot "sluice_x" is active for PID 4711 (SQLSTATE 55006)
    SELECT pg_drop_replication_slot('sluice_x');
                               -> ERROR: replication slot "sluice_x" is active for PID 4711 (SQLSTATE 55006)

## One SQLSTATE, two opposite meanings

The sharp edge is semantic: 55006 means either &ldquo;the prior owner's walsender hasn't been reaped yet&rdquo; &mdash; transient, self-heals in seconds, must be retried &mdash; or &ldquo;a second writer is genuinely consuming this slot right now&rdquo; &mdash; the load-bearing guard against two streamers sharing one slot, which must fail loudly and immediately. Same code, same message shape, opposite correct responses; the error carries nothing to tell them apart (the PID names the holder, not its liveness).

## The clean separator is a bounded retry

Time is the only discriminator the server gives you. A dead owner's walsender is reaped well inside a small bounded budget; a live owner holds the slot past any reasonable budget. So both of sluice's lifecycle sides retry 55006 on a short backoff and let the FINAL attempt's original loud refusal propagate unchanged &mdash; the transient case self-heals invisibly, and the genuine-second-writer case fails exactly as loudly as before, just a bounded number of seconds later. No liveness oracle, no heuristics on the message text, no weakening of the guard.

## The transferable lesson

Audit every code path that runs at &ldquo;the client is gone&rdquo; &mdash; restarts, teardowns, failover tooling, test cleanup &mdash; for the assumption that disconnect implies release. Where a shared resource is freed asynchronously and the contention error is ambiguous between &ldquo;stale hold&rdquo; and &ldquo;real conflict&rdquo;, a bounded retry that preserves the final loud failure is the honest resolution: it distinguishes the two cases by the one signal the server actually provides &mdash; how long the hold lasts.

## Primary sources

- sluice &mdash; the START_REPLICATION bounded retry and its dual-cause analysis (incl. the wal_sender_timeout worst-case bound) in the Postgres CDC reader; the v0.99.289 drop-side retry in the slot-loss integration test.

- PostgreSQL documentation &mdash; wal_sender_timeout; SQLSTATE class 55 (object not in prerequisite state).

- Related field notes &mdash; &ldquo;active&rdquo; is not liveness and the slot is the registry you already have (the same catalog surface, opposite direction: there existence is the signal; here activity is the ambiguity).

---
Canonical page: https://sluicesync.com/field-notes/disconnect-is-not-release/ · Full docs index: https://sluicesync.com/llms.txt
