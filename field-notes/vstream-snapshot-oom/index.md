# The cold-start that buffered a whole table into swap

> A 13 GB PlanetScale table drove the process to ~41 GB of RAM and got OOM-killed with zero rows written — the VStream snapshot reader held the entire copy phase in memory before a single row reached the target. The buffer wasn't laziness; three engine behaviors forced it.

Observed — PlanetScale / Vitess cold-start (VStream COPY snapshot) of one large table. Internally ADR-0071 (extends the ADR-0028 memory-bounded-streaming audit, which never reached this reader).

## What happened

A cold-start snapshot of a ~13 GB, ~19M-row PlanetScale table walked the process's RSS up 28 → 38 → ~41 GB on a 32 GB host, into swap, until the OOM killer reaped it — and not one row had been written to the target the entire time. The most ordinary cold-start shape there is (one big table) was an unbounded-memory failure.

## Why (the mechanism)

The VStream snapshot reader drained the entire COPY phase into an in-memory map[table][]Row before it returned the stream — it only completed after the global COPY_COMPLETED event, and only then did bulk-copy to the target begin. So peak memory was the whole snapshot, and target writes couldn't start until the buffer was full.

The uncomfortable part is that the buffer wasn't sloppiness — three VStream behaviors force a receiver to buffer, and a naive "just stream it straight through" rewrite breaks all three:

- Order decoupling. VStream emits COPY rows in its order; the orchestrator consumes table-by-table in its order. Something has to hold the rows whose turn hasn't come.

- Multi-shard fan-in. One logical table's rows arrive interleaved from N shards; they're merged by unqualified table name, which means collecting across the whole stream.

- Inline dedup. Vitess re-emits rows already behind its scan cursor during COPY (binlog catch-up); those duplicate PKs are dropped as events arrive, which needs the stream in hand.

## What sluice does about it

Two changes, shipped together. First, a correctness floor: the buffer is now accounted in bytes and refuses loudly over a cap (naming the table and the --max-buffer-bytes guidance) instead of growing into swap — a silent OOM becomes a bounded, diagnosable error. Second, the real fix: stop draining to completion. After capturing field metadata and the initial position, the reader returns immediately and pumps the gRPC stream from a background goroutine under the byte cap, emitting each table's rows as they arrive. A slow target backpressures the channel, which backpressures the Recv, which backpressures Vitess — so memory stays constant and target writes start right away. All three forcing invariants are preserved inside the bounded pump: dedup stays inline, shard fan-in still merges by name, and the snapshot position still finalizes at COPY_COMPLETED.

## The transferable lesson

When a snapshot or CDC wire protocol decouples the order it emits from the order you consume — and especially when it also fans in from multiple shards and expects you to dedup inline — it has quietly made you a buffering system, and the buffer is unbounded by default until one large table walks you into swap. The fix is not to remove the buffer (those invariants are real) but to bound it by bytes and backpressure the source: pump under a cap so a slow consumer slows the producer, and refuse loudly rather than silently at the ceiling. The tell for this bug is a process that sits at growing RSS with zero output — it isn't slow, it's buffering the world before it starts.

## Primary sources

- Vitess VStream COPY / catch-up semantics — VStream.

- gRPC flow control / backpressure — gRPC core concepts.

- How sluice cold-starts a sync — Zero-downtime migration.

---
Canonical page: https://sluicesync.com/field-notes/vstream-snapshot-oom/ · Full docs index: https://sluicesync.com/llms.txt
