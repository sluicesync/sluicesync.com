# The 20-second guillotine: Vitess's transaction killer meets a 96 ms WAN

> Continuous CDC into PlanetScale MySQL over the internet stalled at effectively zero throughput. The failure geometry: with no statement pipelining an N-row apply costs N round-trips; at 96 ms RTT a 1,000-row batch takes ~100 seconds; Vitess kills any transaction at 20 seconds; the adaptive batch controller shrinks the batch — and converges to a stall.

Observed — trigger-CDC continuous apply into PlanetScale MySQL (Vitess) at ~96 ms RTT, and into PlanetScale Postgres. Internally Bug 168 (Postgres apply path, fixed v0.99.153) and Bug 169 (MySQL/Vitess apply path, insert path fixed v0.99.155; update/delete tail tracked under ADR-0138).

## What happened

A continuous CDC sync into a PlanetScale MySQL target over the public internet stalled. With the default apply config, every apply transaction took far longer than Vitess's hard 20-second transaction timeout and was killed:

    Error 1105: ... tx killer rollback ... exceeded timeout: 20s

The adaptive batch controller reacted to the failures and multiplicatively shrank the batch — 1000 → 500 → 250 → 125 → 62 — but the p95 stayed around 22 seconds, batches kept getting killed, and durable progress was roughly nil (over ~210 seconds the target advanced about 50 net rows; the durable resume position never left last_id=0). A self-tuning system had converged to a stall.

## Why (the mechanism)

The apply path issued its statements one round-trip at a time — no statement pipelining, no multi-row coalescing — so an N-row apply transaction costs about N network round-trips. At a 96 ms RTT, a 1,000-row batch is 1000 &times; ~2&times;RTT &asymp; ~100 s, well past the 20-second killer. So the two knobs fight each other with no winning setting: every batch big enough to be efficient overruns the killer, and every batch small enough to commit crawls at roughly lanes / RTT — with 4 lanes over 96 ms, on the order of 20&ndash;30 changes/s. The controller can only pick between "killed" and "crawling."

The clean proof that the bottleneck was per-row round-trips and not batch/transaction count came from the Postgres side of the same test: pinning a large static batch (--no-auto-tune --apply-batch-size 1000) barely moved throughput — about 63 changes/s, essentially unchanged from the auto-tuned collapse. If batch count were the cost, a 1,000-row static batch would have jumped; it didn't, because the cost is 1,000 serial round-trips either way. Routing the identical workload through a pipelined applier (a batch costs ~1&ndash;2 RTT instead of N) took Postgres from ~63/s to ~5,000 changes/s. Latency &times; protocol shape beats every knob.

## The repro

On a high-latency link (add ~80&ndash;100 ms with tc netem if you don't have a real WAN), run continuous CDC into a Vitess/PlanetScale MySQL target under a sustained write workload and watch the durable apply position:

    # generate a backlog, then apply over the WAN with the default config:
    #   the 20 s tx-killer fires, AIMD collapses the batch toward 1,
    #   durable progress ~0 (last_id stays near 0).
    # cap the batch low enough to commit inside 20 s to confirm the RTT floor:
    sluice sync start --no-auto-tune --apply-batch-size 80 ...
    #   no tx-kills now — but only ~20-30 changes/s, two orders of
    #   magnitude below the ~2,600/s the source generates. It diverges.

The diagnostic knob is the static-batch test: if pinning a large static batch doesn't raise throughput, your bottleneck is per-row round-trips, and no batch-size setting will save you.

## What sluice does about it

The real fix is to remove the per-row round-trips. On the Postgres apply path, sluice routes the batch through a statement-pipelined applier so a batch of N changes costs ~1&ndash;2 RTT — measured ~5,000 changes/s over the WAN where the round-trip-bound path managed ~63/s. On the MySQL/Vitess path, the insert-heavy case is handled by multi-row INSERT coalescing: re-validated on real PlanetScale MySQL at ~101 ms RTT, an insert-only 200,003-change backlog drained at ~4,000 changes/s with the default config and the 20-second killer never firing — versus the prior default-config stall (roughly 100&ndash;200&times;). The update/delete-heavy MySQL path is still round-trip-bound and is tracked as MySQL apply-parity work under ADR-0138; until it lands, migrate/cold-copy (a streaming COPY/bulk-load protocol, bandwidth-bound not RTT-bound) is the safe cross-region primitive.

## The transferable lesson

Over a WAN, the shape of your protocol dominates every tuning knob. If your applier isn't pipelined or multi-row-coalesced, an N-row batch costs N round-trips, and no adaptive batch controller can find a setting that is both efficient and within a managed database's transaction timeout — it will converge to a stall, which is worse than an honest error because it looks like the system is trying. And managed-database transaction killers (Vitess's 20 s, others' equivalents) turn "slow" into "wedged": a batch that would merely have been slow on a self-hosted server gets rolled back entirely. Measure round-trip cost directly — the static-batch test — before you trust batch size as a lever.

## Primary sources

- Vitess transaction timeout / tx-killer — Vitess transactions reference (the --queryserver-config-transaction-timeout behavior).

- sluice PlanetScale & Vitess guidance — PlanetScale & Vitess and PlanetScale Postgres.

- How sluice's CDC apply works — How sluice copies your data.

---
Canonical page: https://sluicesync.com/field-notes/vitess-tx-killer-wan/ · Full docs index: https://sluicesync.com/llms.txt
