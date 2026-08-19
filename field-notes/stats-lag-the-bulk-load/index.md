# The catalog stats that lag your bulk load

> Right after a bulk COPY, a 36 MB PlanetScale table reported DATA_LENGTH = 16384 (16 KB) and TABLE_ROWS = 5,925 — the catalog statistics hadn't caught up. A size gate keyed off the just-copied target read three orders of magnitude low and never fired, so the safeguard was absent on exactly the platform it protects. Nothing errored; the threshold just never tripped.

Observed &mdash; bulk migrate into PlanetScale (Vitess) MySQL, reading the freshly-copied target's own information_schema. The gate this defeated is sluice's ADR-0184 per-index index-split; the fix moved its sizing to the source (fixed v0.129.0).

## What happened

sluice defers a large table's secondary-index build to a post-copy phase, and on PlanetScale it splits that build into one ALTER per index once the table is big enough to risk the platform's statement-time wall (see the companion note). &ldquo;Big enough&rdquo; was a threshold on the table's DATA_LENGTH, read from information_schema.tables right after the bulk copy finished.

On a real PlanetScale branch the split never engaged. The table it should have protected was 36 MB with 524,000 rows &mdash; comfortably into the range the split exists for &mdash; yet the gate read its size as 16 KB and its row count as 5,925, and concluded it was small. The optimization was inert on the one platform whose wall it was built to dodge. Every local test had passed, because local MySQL doesn't behave this way.

## Why (the mechanism)

The numbers the gate trusted were stale. A managed, replicated MySQL like Vitess/PlanetScale does not populate a table's information_schema statistics synchronously with a bulk load: immediately after the COPY that filled it, the catalog still reported near-initial values &mdash; DATA_LENGTH off by three orders of magnitude, TABLE_ROWS off by two. The statistics converge later, on the engine's own schedule; the window right after a load is exactly when they are least trustworthy, and exactly when a post-copy phase wants to read them.

The precise server-side cause &mdash; InnoDB persistent-stats sampling not yet run, versus a Vitess catalog layer that hadn't refreshed &mdash; we did not isolate. The finding is the black-box measurement: 36 MB reads back as 16 KB.

Local MySQL updates these stats promptly, which is why the whole thing was invisible in testing. Every unit test and the local scale experiment sized their gate off a table whose stats were fresh, so the gate tripped correctly and the tests were green &mdash; while the same gate, on the same code, was dead on the real platform.

## The repro

Bulk-load a table into a PlanetScale (or self-hosted Vitess) keyspace and, immediately after the copy completes, read it back:

    SELECT DATA_LENGTH, TABLE_ROWS
    FROM information_schema.tables
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?;

The values sit far below the real size until the engine's statistics catch up. On local MySQL the same query returns the true size at once &mdash; which is the trap: the behavior you test against is not the behavior you ship onto.

## What sluice does about it

The gate now sizes off the long-lived source table, not the freshly-copied target. A source table that has existed for a while has accurate statistics, because it wasn't just written; only the target is stale right after a copy. The threshold, the byte semantics, and the flavor gate are all unchanged &mdash; only the data source moved, from the stale target to the accurate source. An anti-regression pin now drives the exact PlanetScale shape (source large while the target reports the stale 16 KB) and asserts the split still engages, plus the converse, so a change that re-couples the decision to the target's post-copy stats fails the build.

## The transferable lesson

Do not make a decision from a freshly-loaded table's own catalog statistics on a managed or replicated engine. The stats a table reports about itself right after a bulk load are stale, sometimes by orders of magnitude, and any threshold keyed off them silently doesn't trip &mdash; the worst failure shape, because nothing is wrong with a value in a row: the safeguard simply never runs, and it never runs precisely where you needed it. Size off the long-lived source instead, or run an explicit ANALYZE TABLE first and pay its cost. What you cannot do is trust a just-copied table to tell you how big it is.

## Primary sources

- sluice ADR-0184 &mdash; per-index ALTER splitting for large index builds; the &ldquo;PlanetScale leg&rdquo; amendment records the 16 KB / 36 MB measurement and the source-sizing fix.

- MySQL reference &mdash; InnoDB persistent statistics: information_schema.tables cardinality and size are estimates the engine maintains lazily.

- Companion note: The scan-once optimization that walls you &mdash; why the gate this defeated exists at all.

---
Canonical page: https://sluicesync.com/field-notes/stats-lag-the-bulk-load/ · Full docs index: https://sluicesync.com/llms.txt
