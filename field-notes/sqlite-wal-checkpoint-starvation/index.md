# One long-lived reader, 75 GB of WAL

> A continuous-CDC run against a 20 GB SQLite source watched the -wal file grow from zero to 75 GB in 52 minutes — while the change-log table it tracked stayed bounded at a few thousand rows. In WAL mode, a checkpoint can only reclaim frames older than the oldest live reader's snapshot.

Observed — continuous sqlite-trigger CDC against a WAL-mode SQLite source, ~52-minute endurance run. Internally Bug 167 (found v0.99.151, fixed v0.99.152).

## What happened

A continuous-CDC endurance run against a 20 GB SQLite source watched the -wal sidecar file grow from zero to 75 GB in 52 minutes — roughly 1.4 GB/min, linear, with no plateau — while the change-log table the sync tracked stayed bounded at a few thousand rows the whole time (a periodic prune kept its row count in check). Exactly-once was never in doubt; the harm was pure disk-fill, and it capped how long a continuous sync against a SQLite source could run. The process RSS crept up in lockstep, ~0.9 MB/min.

## Why (the mechanism)

In WAL mode, a checkpoint can only copy-and-reclaim frames older than the oldest live reader's snapshot. A reader holding a snapshot pins every WAL frame at or after its read-mark, so the checkpoint can restart the WAL but never truncate the file. sluice's poll loop kept a live read on the source between polls, so the WAL accumulated every superseded version of the same heavily-churned change-log B-tree pages — each insert-then-prune-delete rewrites the same pages, and every old version stayed pinned. An explicit PRAGMA wal_checkpoint(TRUNCATE) with the sync still running could not reclaim the 75 GB.

Ground truth was theatrical: the instant the process was killed and its read snapshot released, the last-connection-close checkpoint truncated the 75 GB WAL to zero, and the whole thing collapsed to about 0.6 GB of genuinely new pages in the main file. So ~74 GB of it was superseded frames the reader's snapshot had pinned. The precise culprit turned out to be subtle: it wasn't a single explicit long transaction but the poller's database/sql connection pool retaining an idle connection whose stale WAL read-mark pinned the checkpoint. (The RSS creep tracked the WAL, not the Go heap — it was modernc's OS-level mmap of the ever-growing -wal, a secondary effect that bounding the WAL also bounds.)

## The repro

    # multi-GB WAL-mode SQLite source; start a continuous CDC sync to any target;
    # drive a sustained insert/update/delete workload while pruning the change-log
    # so its ROW count stays bounded; sample the WAL each minute:
    stat --format='%s' big.db-wal     # climbs ~GB/min, no plateau,
                                      # even though the change-log row count is flat

    # stop the sync -> the last connection closes -> the WAL truncates to ~0.
    # That truncation-on-close is the proof the running reader pinned it.

## What sluice does about it

The fix is protocol hygiene, not tuning, and it has two parts (local-SQLite path only — the d1-trigger source polls over HTTP with no local pager and is unaffected). First, the poller's read connection is no longer retained idle (SetMaxIdleConns(0)), so its WAL read-mark is released after each poll and a checkpoint can reset the WAL — this alone held the WAL flat at ~8 MB in a focused repro where the default idle pool grew it to 158 MB in 12 seconds. Second, the poll loop issues PRAGMA wal_checkpoint(TRUNCATE) on a 30-second cadence (busy-tolerant: a BUSY result just retries next cadence), so the WAL stays bounded even when the operator's own application has disabled wal_autocheckpoint. The checkpoint runs in the poll goroutine between polls, never racing the read, and never touches the watermark or the exactly-once path.

## The transferable lesson

A reader's snapshot pins the log — this is the same principle that makes an idle Postgres replication slot fill a disk (slots don't die with your process) and long transactions bloat any MVCC engine's dead-tuple space. SQLite just shows it to you as a single file you can stat. If you hold a long-lived read against a churning table, you are silently retaining every superseded version of the pages you touch; release the snapshot periodically (short-lived read transactions, and mind your connection pool's idle connections — a pooled idle connection holds a read-mark just as a live query does) so the log can be reclaimed. And watch for the second-order effect: a growing WAL that gets mmap'd can look like a memory leak while your heap stays perfectly flat.

## Primary sources

- SQLite Write-Ahead Logging — the WAL design (checkpointing and the reader-snapshot constraint).

- PRAGMA wal_checkpoint and wal_autocheckpoint — SQLite pragmas.

- sluice trigger-based CDC — How sluice copies your data.

---
Canonical page: https://sluicesync.com/field-notes/sqlite-wal-checkpoint-starvation/ · Full docs index: https://sluicesync.com/llms.txt
