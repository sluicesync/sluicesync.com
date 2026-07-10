# One JSON blob in one row is a quadratic write

> Storing all per-table progress as a single growing JSON blob and re-upserting it on every checkpoint is O(n²) work. On Postgres the amplification lands somewhere specific: a new tuple version plus a re-TOAST of the whole value, every time, on one hot row — while the clone runs inside the lock your workers are waiting on.

Observed — the resumable-migration state store under a high-frequency checkpoint loop across many tables. Internally ADR-0082 (a HIGH-rated P1 audit finding).

## What happened

Sluice's resumable-migration progress lived as one JSON blob — the whole map[table]TableProgress — in a single database row, re-written on every checkpoint. At the 10,000-table scale the parallel copy pool targets, that one row was re-encoded and re-upserted ≥20,000 times per migration (two breadcrumbs per table, plus a resume cursor every 5,000 rows, plus a checkpoint per chunk), each write carrying the whole ~0.86 MB blob. It worked fine at ten tables and quietly became a performance wall at ten thousand.

## Why (the mechanism)

There are two costs stacked on top of each other. The first is the obvious quadratic: the blob grows linearly with table count, and it's rewritten a number of times that also grows with table count, so total work is O(n&sup2;). The second is where it hurts on a real database — Postgres MVCC and TOAST:

- An UPDATE in Postgres doesn't overwrite in place; it writes a new tuple version and marks the old one dead (to be reclaimed by vacuum later). Rewriting one row 20,000 times creates 20,000 dead versions of that row.

- A ~0.86 MB value is far past the ~2 KB inline threshold, so it lives in TOAST (the out-of-line storage for oversized values). Each update re-TOASTs the whole value into fresh chunks. The measured write amplification was ~17 GB — for a progress log.

- And the whole-map deep clone that precedes the encode ran inside the state mutex, so every checkpoint serialized against all the parallel copy workers — the O(n) clone was also a contention point.

The row count you think you're bounded by (tables) is not the row count that bites (tuple versions of one hot row).

## What sluice does about it

Split the single blob into a header row plus one row per table, and give the store an O(1) per-table write. A checkpoint now upserts a single small progress row instead of re-encoding the whole map, so total work drops to O(n) and the TOAST re-write is per-table, not per-everything. The concurrency win comes for free: because workers now write different rows, the state mutex stops serializing them. (An additive state_format column lets an in-flight legacy blob upgrade in place, once.)

## The transferable lesson

"Just keep the state as one JSON column and upsert it" is an O(n&sup2;) amplifier the moment the state grows and the checkpoints are frequent — and on an MVCC database the cost is not merely re-serialization: every write is a new tuple version plus a re-TOAST of the entire oversized value, all concentrated on one hot row that also becomes a lock. Give any growing state map an O(1) per-key write surface (a row per key), and you fix the algorithmic cost, the storage amplification, and the write contention in one move. The same shape shows up in this project's backup manifest — a growing metadata object rewritten once per unit of progress is the pattern to watch for.

## Primary sources

- Postgres MVCC (an UPDATE writes a new row version) — concurrency control intro and routine vacuuming.

- TOAST (out-of-line storage for large values) — TOAST.

- sluice's resumable migration model — Preview & validate.

---
Canonical page: https://sluicesync.com/field-notes/migrate-state-quadratic-blob/ · Full docs index: https://sluicesync.com/llms.txt
