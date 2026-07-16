# The alert cleared at the exact moment the slot died

> Monitor a Postgres replication slot by WAL-retention pressure and you inherit a sign flip at the terminal event: when Postgres invalidates the slot, pg_replication_slots reports wal_status='lost' and the lag columns go NULL — not huge. Coerce NULL to zero, compute 0% pressure, and your threshold evaluator concludes the condition cleared. The operator is told the pressure resolved at precisely the moment it became fatal.

Observed — live on PG16, first by the 2026-07-15 repo audit (MED-D0-9, against sluice's own slot-health evaluator) and then reproduced as a staged before/after differential by the v0.99.258 regression cycle, exact log lines below. This was sluice's bug, not Postgres's: the catalog behavior is documented. Fixed in v0.99.258. One mitigating fact up front: the CDC streamer itself fails loudly on a lost slot, so this was an alerting-truth inversion, not a data-loss path — the feature that existed to give operators early warning gave them a false all-clear instead.

## What happened

sluice's slot-health watcher pages on WAL-retention pressure: percent of max_slot_wal_keep_size retained for the slot, WARN at 70%, CRITICAL at 85%. The natural implementation reads the slot's lag from pg_replication_slots, computes a percentage, and compares against thresholds — and that implementation contains the trap twice over:

- When Postgres invalidates a slot (the WAL it needs got recycled past the cap), the row doesn't show an enormous lag. It shows wal_status='lost' and NULL in the lag columns — the audit's live probe row was active=f | lost | NULL | NULL.

- sluice's Postgres reporter mapped NULL lag to 0 bytes, and the threshold evaluator never read WALStatus at all. NULL lag → 0% pressure → below every threshold → Cleared=true → an INFO reading &ldquo;condition cleared.&rdquo;

So the observed sequence on the shipped binary was: page CRITICAL at 85%, keep paging as pressure climbs — then, at the exact tick the slot became irrecoverable, log &ldquo;condition cleared&rdquo; and go quiet. Terminal states in monitoring views often present as absent data rather than extreme data, and absent-means-clean defaults invert the alert exactly when it matters most.

## The live differential

The v0.99.258 cycle staged it on a throwaway postgres:16 with max_slot_wal_keep_size=1MB: stall the consumer realistically, burn WAL to ~92% of the cap (lag 969,120 bytes, identical on both binaries), take one in-condition retention pressure CRITICAL tick, then burn past the cap and CHECKPOINT so the slot invalidates live.

    binary       at the terminal event
    ---------    ------------------------------------------------------------
    v0.99.257    next tick emits `postgres: slot-health condition cleared`
                 with wal_status=lost lag_bytes=0 — the false all-clear —
                 and NO lost page ever (lost=0, cleared=1)
    v0.99.258    exactly ONE terminal ERROR: `slot INVALIDATED
                 (wal_status=lost) — terminal, re-snapshot required`;
                 ZERO clears; the pre-invalidation retention WARN intact

A staging detail worth recording: a plain fast burn on v0.99.257 (clean straight to lost, no sampled in-condition tick) emits nothing at all — reproducing the audit's exact false-clear shape needs the staged burn, one retention tick first.

## The fix's shape — and its two siblings

The repair is instructive beyond the one bug. First, dispatch on wal_status before any percentage math: lost pages CRITICAL exactly once and latches — never repeats, never clears — because the state is terminal by definition. But unreserved pages CRITICAL and stays clearable, because Postgres documents that an unreserved slot can recover; latching a recoverable state would re-create the inversion in the other direction (a stale alarm the operator learns to ignore). Truthful alerting cuts both ways.

Two siblings shipped in the same pass, both variations on &ldquo;the net must be truthful at the terminal event&rdquo;:

- A probe that fails silently is a disabled net. A revoked role or killed connection had the health probe logging DEBUG forever while the operator believed the alerting was live. Now five consecutive probe failures escalate to a WARN — &ldquo;retention/invalidation alerts are blind until it recovers&rdquo; — once per streak, with a recovery INFO. The cycle proved it live: REVOKE SELECT ON pg_catalog.pg_replication_slots, CDC keeps applying while the probe is blind, the WARN fires at exactly consecutive_failures=5.

- An edge-once latch must advance on delivery, not on decision. The schema-drift page's once-per-stall latch advanced before the notification was sent, so one transient sink error (a 502 at the stall moment) permanently swallowed the only page a persistent stall would ever get. The latch now advances only on successful delivery.

Plus one-tick hysteresis on threshold downgrades, so a catch-up hovering at the 85% boundary doesn't page every 30 seconds in both directions.

## Reproducing it

Throwaway container, ~5 minutes (this is the regression-cycle recipe):

    docker run -d --name slotpg -e POSTGRES_PASSWORD=x -p 5460:5432 postgres:16 \
      -c wal_level=logical -c max_slot_wal_keep_size=1MB

    -- create a logical slot, attach a consumer (sluice sync or pg_recvlogical), then stall it
    -- burn WAL past the cap and force recycling:
    SELECT pg_switch_wal(); CHECKPOINT;   -- repeat with junk writes until:
    SELECT active, wal_status, safe_wal_size FROM pg_replication_slots;
    --  f | lost | NULL          <- the terminal row: status text, NULL numbers

Any monitor that computes pressure from the lag/safe_wal_size columns and treats NULL as zero will read that row as 0% — sluice &le; v0.99.257 logged &ldquo;condition cleared&rdquo; on it; &ge; v0.99.258 pages terminal CRITICAL once. To see the false clear specifically, let the monitor sample one in-condition tick before the burn crosses the cap.

## The transferable lesson

When a monitored resource dies, its metrics don't spike — they vanish. Check the status column before the arithmetic, and treat absent data as &ldquo;cannot assert health,&rdquo; never as zero. Then audit the alert lifecycle at its edges: a terminal state should latch (one page, no clears, no repeats), a documented-recoverable state should not, a probe that can't see must say so, and a once-only notification must not mark itself sent until it was. Every one of those edges defaults to the quiet-and-wrong behavior if unexamined — and the quiet failure of an alerting net is indistinguishable from good news.

## Primary sources

- PostgreSQL documentation — pg_replication_slots.wal_status (lost: &ldquo;this slot can no longer be used&rdquo;; the lag/safe_wal_size columns go NULL) and max_slot_wal_keep_size.

- sluice v0.99.258 changelog — the lost/unreserved dispatch, probe-outage escalation, delivery-gated drift latch, and downgrade hysteresis; the 2026-07-15 audit findings MED-D0-9/10/11.

- sluice-testing session report v0.99.258 (F4/F4b) — the staged false-clear differential and the exactly-once terminal page, live on PG16.

- Companion field notes — postgres-slot-leaks and postgres-idle-slot-failover (how slots die; this note covers how their death reads as good news to your alerting).

---
Canonical page: https://sluicesync.com/field-notes/alert-cleared-when-slot-died/ · Full docs index: https://sluicesync.com/llms.txt
