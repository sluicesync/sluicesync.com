# PlanetScale acked our rows, then a storage-grow reparent un-acked them

> A 5.5M-row migrate into PlanetScale MySQL returned exit 0 and “migration complete” — and landed 5,496,003 rows. About four thousand, gone in scattered whole-batch units, no error anywhere.

Observed — bulk migrate into non-Metal PlanetScale (Vitess) MySQL, source row count 5,500,000. Internally Bug 175; the loss mechanism ties to ADR-0113, the coordinated fix to ADR-0110 / ADR-0141 (fixed v0.99.161).

## What happened

A migrate of 5,500,000 rows into a PlanetScale MySQL database reported success — exit 0, &ldquo;migration complete&rdquo; — and left 5,496,003 rows on the target. Roughly four thousand rows were missing, in scattered whole-batch units, with no error logged on either side. The client had seen every batch commit and acknowledge. The rows the client believed were durable were simply not there.

## Why (the mechanism)

This is a genuine distributed-systems edge, not a sluice batching bug. On non-Metal PlanetScale, when the underlying volume fills during a bulk load:

- the primary hits Error 1114 (HY000): The table is full;

- under storage pressure, semi-synchronous replication falls back to asynchronous;

- the storage-grow event triggers a reparent — a new primary is promoted;

- the new primary is promoted from behind the async-acked window, so rows the client saw committed and acknowledged on the old primary were never durably replicated, and are absent on the new one.

A bulk load is exactly the workload that crosses grow thresholds — it's the one operation most likely to fill a volume fast enough to trigger the grow. So the loss lands precisely where you'd least want it: a large first import.

## The repro

This one reproduces operationally, not with a single statement. Instrument a live PlanetScale database near its volume floor (the cheapest repro tier starts at a ~12 GB floor) and bulk-load past the grow threshold. In our diagnostic, three runs froze at ~10.34 GB — about 86% of the 12 GB volume — right at the grow trigger, and a single-lane load stalled identically to a 16-lane one, ruling out write concurrency as the cause. Watch for the Error 1114 transient and the primary changing underneath the stream; the missing rows cluster around that reparent instant, in whole batches, because the async gap is measured in transactions, not rows.

## What sluice does about it

The fix needed two layers, because reactive retry alone can't recover an already-lost acked window:

- A coordinated grow gate: the moment any write lane sees a grow-transient, all lanes quiesce and wait out the grow/reparent window together. Reactive per-lane retry alone bred a thundering herd — on the order of hundreds of simultaneous retries per grow window — so the gate coordinates instead of each lane fighting independently.

- A post-copy reconciliation phase that re-derives every reparent-touched table from the replayable source. The gate prevents new loss; reconciliation recovers the window that was already un-acked before the gate engaged. Reactive handling can never do the latter, because the lost rows were never on the new primary to retry against.

A war-story footnote worth its own lesson: the first version of this fix shipped inert — a dead branch that never fired — and was caught only by live A/B revalidation (81 grow windows observed, 0 reconcile rounds triggered, when there should have been many). A fix for a silent-loss class has to be validated against the live behavior it targets, not just unit-tested; a green test on an unreachable branch is exactly as silent as the bug.

## The transferable lesson

&ldquo;The client received an ack&rdquo; is not the same as &ldquo;the row survived a failover.&rdquo; On any system where a storage event can trigger a reparent and replication can silently degrade from sync to async under pressure, acknowledged writes in the async window are lost across the promotion — and bulk loads are the workload most likely to cross that threshold. If you can replay the source, a post-load reconciliation of failover-touched tables is the only thing that closes the gap; retry logic alone treats a wound it can't reach.

## Primary sources

- sluice PlanetScale guides — PlanetScale & Vitess and Self-hosted MySQL → PlanetScale.

- MySQL Error 1114 reference — MySQL server error reference.

- Vitess reparenting (the promotion mechanism) — vitess.io reparenting docs.

---
Canonical page: https://sluicesync.com/docs/field-notes/planetscale-grow-reparent/ · Full docs index: https://sluicesync.com/llms.txt
