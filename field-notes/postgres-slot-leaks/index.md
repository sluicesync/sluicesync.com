# Replication slots don't die with your process

> A Postgres logical replication slot is a promise the server keeps: it retains WAL from the slot's restart_lsn until you drop it — even if the process that created it crashed weeks ago. We hit the class three separate ways, each invisible until the source disk fills.

Observed — Postgres source, replication-slot lifecycle across crashes and early exits. Internally Bug 5 (fixed v0.2.0), Bug 137 (fixed v0.99.37), Bug 177 (fixed v0.99.179).

## What happened

A Postgres logical replication slot retains WAL from its restart_lsn onward until something drops it. A slot left behind by a dead process keeps pinning WAL forever — the server has no idea the client is gone, and it is doing exactly what you asked: holding the log so a consumer can resume. On a write-active source, an orphaned slot is a slow disk-fill with no loud signal until Postgres goes read-only. We hit this class three separate ways.

- A hard-killed backup. A PG-source backup full created a non-temporary snapshot-anchor slot (sluice_backup_anchor_<ts>). Kill it mid-run and the slot survives inactive; the subsequent resume creates a new anchor and never sweeps the old one, so every crashed run adds one more WAL-pinning orphan, each frozen at its creation-time restart_lsn.

- A cold-start that refused for an unrelated reason. A sync start created its slot before the target-empty check, then hit SLUICE-E-COLDSTART-TARGET-NOT-EMPTY and exited — without dropping the slot it had just created. The refusal was loud and correct; the leaked slot behind it was silent.

- The earliest version of the tool. In week one, any cold-start that failed between CREATE_REPLICATION_SLOT and clean shutdown left sluice_slot behind, and the next start refused with replication slot "sluice_slot" already exists until an operator ran pg_drop_replication_slot by hand.

## Why (the mechanism)

A non-temporary slot's lifetime is server-side and unbounded — it is decoupled from the TCP connection or OS process that created it, by design, so a consumer can disconnect and reconnect without losing its place. That is exactly why a crash leaks it: there is no session-teardown hook that drops a persistent slot, and kill -9 gives the client no chance to clean up. Any code path that creates a slot and can exit abnormally — a crash, a signal, an early-return refusal — is therefore a potential leak, and the leak is invisible from the application side. You only see it in pg_replication_slots, or when the disk fills.

## The repro

Create a slot, kill the process before it drops it, and look at the catalog:

    -- create a slot, then hard-kill the creating process (kill -9 / taskkill /F)
    SELECT slot_name, temporary, active, restart_lsn
    FROM pg_replication_slots
    WHERE slot_name LIKE 'sluice_%';
    --  sluice_backup_anchor_178...  | f | f | 0/1A2B3C4   <- persistent, inactive,
    --                                                        pinning WAL at that LSN

    -- the WAL it pins never recycles until you drop it:
    SELECT pg_drop_replication_slot('sluice_backup_anchor_178...');

## What sluice does about it

The toolbox that closed the class:

- Protocol TEMPORARY slots for anything single-run-scoped. A temporary slot auto-drops when its session ends — including under kill -9 — so a crashed backup no longer leaks its anchor. (CREATE_REPLICATION_SLOT &hellip; TEMPORARY supports EXPORT_SNAPSHOT, so the snapshot-anchored backup path can use it.)

- An orphan sweep with an age safety margin on the resume path, for slots leaked by pre-fix binaries: old orphans are dropped with an INFO naming each one; a slot younger than the margin is only WARN-named (it might belong to a concurrent run), never auto-dropped.

- Teardown-on-refusal ordering: an early-exit refusal now abandons the slot it created before returning, so the target-not-empty path leaves the source slot count unchanged.

This is the contain-Postgres-complexity tenet in practice: slot lifecycle is surfaced explicitly — via sluice slot list / slot drop and named WARNs — rather than silently auto-handled or silently leaked.

## The transferable lesson

If your tool creates replication slots (or any server-side, session-decoupled resource), your crash paths are part of your API. Enumerate every way the process can exit abnormally — signal, panic, early-return refusal, hard kill — and make sure each one either can't leak the resource (protocol-TEMPORARY) or is reconciled on the next run (an age-bounded sweep). A resource whose lifetime the server owns will outlive your process by default; that is a feature you have to opt out of, not a bug you can ignore.

## Primary sources

- Postgres replication slots — streaming replication slots and pg_replication_slots.

- The replication protocol's CREATE_REPLICATION_SLOT &hellip; TEMPORARY — streaming replication protocol.

- sluice Postgres-source preparation — Prepare a Postgres source and the managed (slot-less) path.

---
Canonical page: https://sluicesync.com/field-notes/postgres-slot-leaks/ · Full docs index: https://sluicesync.com/llms.txt
