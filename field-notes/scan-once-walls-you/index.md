# The scan-once optimization that walls you

> Collapsing a table's index builds into one ALTER so InnoDB scans once is a real win — until a per-statement time limit. On PlanetScale a 12.8 GB table's four-index ALTER hit the ~900 s wall at 900,004 ms, and --resume re-issued the identical statement, so the build could never converge. The very property that makes the optimization efficient — one big statement — is what the wall kills.

Observed &mdash; a real 30 GB PlanetScale us-east-1 → us-east-2 region move (7&ndash;8 hours, 4&ndash;5 restarts). Fixed in sluice v0.129.0 (ADR-0184); the combined-ALTER it conditionally splits is ADR-0080.

## What happened

sluice builds a table's secondary indexes in a deferred post-copy phase, and &mdash; following a standard MySQL optimization &mdash; emits the minimum set of statements: all of a table's combinable indexes collapse into one ALTER TABLE t ADD UNIQUE KEY &hellip;, ADD KEY &hellip;, ADD KEY &hellip; so InnoDB scans and rebuilds the table once instead of once per index. On an ordinary table that is a real, measured win.

On a large table on PlanetScale it was the opposite. The 12.8 GB audio_plays_daily table's four-index combined ALTER ran for exactly 900,004 milliseconds and was killed by the platform's statement-time limit (errno 3024) &mdash; four milliseconds over the ~900 s ceiling. And because --resume re-issued the same combined statement, every restart hit the same wall at the same place. The build could not converge; the operator restarted from scratch, re-copying 30 GB each time. That non-convergence was much of a 7&ndash;8 hour, 4&ndash;5 restart ordeal.

## Why (the mechanism)

Two facts combined into a trap. First, the &ldquo;scan once&rdquo; optimization concentrates all of the work into a single statement, and a single statement is precisely the unit the wall measures. The very property that makes the combined ALTER efficient &mdash; one big statement instead of several &mdash; is what makes it un-survivable under a per-statement time limit: you cannot get under the wall by being efficient inside one statement; you have to have fewer things in the statement.

Second, a resume that re-issues the identical failing statement is non-convergent by construction. sluice's resume already skips indexes that are already present &mdash; but the combined ALTER is one atomic statement that builds all four indexes or none, so after it is killed, zero indexes are present, and resume re-issues all four again. There is no state in which it makes progress.

## What sluice does about it

On a statement-time-limited target (the PlanetScale/Vitess flavor) and a table large enough to risk the wall, sluice now splits the deferred build into one ALTER per index instead of the combined form. Measured locally on an 8.4M-row table in the same shape: the combined build's longest statement was 220 s; per-index, the longest was 64 s, at the same 191 s total when the table fit in the buffer pool (roughly 1/N per statement, no total-time penalty; a table that doesn't fit in memory pays extra scans &mdash; the correct trade when the alternative is a hard failure). Each per-index ALTER stays well under the wall.

And because each index is now its own statement, resume works: the indexes that landed before the failure are present, resume skips them, and it finishes only the ones still missing instead of re-hitting a monolith. Every other target, and every ordinary table, keeps the combined ALTER unchanged &mdash; its single-scan win is real where the wall doesn't apply.

One elegant alternative didn't survive contact with the schema. Building each partition's shard separately and swapping them in with EXCHANGE PARTITION &hellip; WITHOUT VALIDATION recombines in 0.6 s, metadata-only &mdash; but MySQL requires every unique key to contain the partition column, which a table with a surrogate id primary key and an independent business UNIQUE(date, seller_id, pack_id, sample_id) cannot satisfy (ERROR 1503). And WITHOUT VALIDATION silently misplaces any out-of-range row &mdash; our own experiment lost ~458,000 high-id rows to a fixed-range assumption. The per-index split gets most of the benefit with none of those constraints.

## The transferable lesson

Under a per-statement time limit, a scan-minimizing &ldquo;do it all in one statement&rdquo; optimization is a liability, not a win. The efficiency you gained by consolidating work into one statement is invisible to a wall that only sees the statement &mdash; and a resume that re-issues the failing statement can never converge. When a platform caps statement time, the unit of progress has to be smaller than the cap, and the resume has to advance one small statement at a time.

## Primary sources

- sluice ADR-0184 &mdash; per-index ALTER splitting for large index builds on a statement-time-limited target: the experiment table, the 900,004 ms measurement, and the EXCHANGE PARTITION alternative.

- sluice ADR-0080 &mdash; the combined-ALTER single-table-scan optimization this conditionally splits.

- PlanetScale &mdash; system limits: the ~900 s statement-execution timeout that surfaces as errno 3024.

- Companion note: The catalog stats that lag your bulk load &mdash; the size gate that decides when this split engages, and how it first read the wrong stats.

---
Canonical page: https://sluicesync.com/field-notes/scan-once-walls-you/ · Full docs index: https://sluicesync.com/llms.txt
