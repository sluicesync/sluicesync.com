# Count your bytes, not your rows

> A batch size tuned for narrow OLTP rows — 5,000 rows, under 10 MB — quietly pins hundreds of MB the moment the workload is MB-scale TEXT, BYTEA, JSON, or geometry. Row count is a proxy for memory, and it's only honest when rows are uniform.

Observed — bulk-copy (batched INSERT) and CDC apply into a target, a batch size set by row count meeting wide columns. Internally ADR-0028 (memory-bounded streaming).

## What happened

The batch accumulators were bounded by row count — --bulk-batch-size 5000 for bulk INSERT, --apply-batch-size for CDC. On the narrow OLTP rows most tests use, 5,000 rows is under 10 MB and everything is fine. On a table with MB-scale TEXT / BYTEA / JSON / geometry columns, the same 5,000-row batch pinned hundreds of MB of driver parameter buffer — and a 500-change CDC batch holding one open transaction's parameter slice did the same. Memory spiked exactly where the configured batch size promised it wouldn't.

## Why (the mechanism)

Row count is a stand-in for memory that only holds when every row is about the same small size. A batch accumulator holds N rows' worth of shaped values and driver parameter buffers before it flushes — that's N &times; (row width), and row width varies across workloads by orders of magnitude. A schema with one wide column breaks the proxy: 5000 &times; 10 bytes is 50 KB, 5000 &times; 2 MB is 10 GB, same batch size. Notably, the COPY and LOAD DATA paths were immune — they stream row-by-row through driver-controlled wire buffers and never hold N rows at once — so only the two accumulators (batched INSERT, and the open-transaction CDC apply) had the problem. The bound was on the wrong axis.

## The repro (the arithmetic)

    -- same batch size, four orders of magnitude apart in memory:
    --   narrow:  5000 rows x ~10 B/row   = ~50 KB   in flight
    --   wide:    5000 rows x ~2 MB/row   = ~10 GB   in flight
    -- a batch size that is safe for your test data is a memory bomb for
    -- someone else's schema — a single BYTEA/JSON/geometry column does it.

## What sluice does about it

Add a byte budget: --max-buffer-bytes (default 64 MiB) that flushes on whichever fires first, the row count or the accumulated bytes. A wide-row workload transparently uses a smaller batch; a narrow one keeps the full count. The streaming paths (COPY, LOAD DATA) need no change, because they were never accumulators. The precedent is worth stealing: PlanetScale's pscale dumper already flushes its bulk-INSERT batcher at ~1 MB of statement body, not a fixed row count, for exactly this reason.

## The transferable lesson

Row count is a proxy for memory, and the proxy is only accurate when rows are uniform. The moment a schema has a wide column — a blob, a document, a geometry — "5,000 rows" can mean 50 KB or 10 GB, so a batch size that's safe for your data is a memory bomb for someone else's. Bound an accumulator by the resource you actually care about (bytes), and keep the count as a secondary cap. And know which of your paths are accumulators and which are streamers: the streaming ones were never at risk here, because they never hold the whole batch at once — the same reason a byte cap belongs on the two that do. (It's the smaller cousin of a snapshot reader that buffered a whole table into swap.)

## Primary sources

- Postgres large-value storage (why a "row" can be megabytes) — TOAST.

- The 1 MB statement-body flush precedent — pscale / mydumper batch sizing conventions.

- How sluice copies data (streaming vs batched paths) — How sluice copies your data.

---
Canonical page: https://sluicesync.com/field-notes/batch-by-bytes-not-rows/ · Full docs index: https://sluicesync.com/llms.txt
