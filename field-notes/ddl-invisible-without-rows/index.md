# An ALTER with no rows behind it is invisible to Postgres CDC

> Change-data-capture tools quietly assume a schema change leaves a mark in the replication stream. It does on MySQL and it does not on Postgres, and the divergence is sharp: pgoutput never streams DDL at all — a schema change surfaces only as a RelationMessage, and only right before the first row that follows it. A pure ALTER with no writes behind it produces nothing.

Observed — establishing ground truth across four DDL shapes on real Postgres and MySQL while closing a backup-completeness hole. On Postgres a pure ADD COLUMN window closed with an empty end position and no schema anchor; the identical window on MySQL anchored a schema snapshot at the DDL event's own position.

## What happened

We were probing how a schema-only change window looks in each engine's change stream — specifically whether an ALTER TABLE … ADD COLUMN with no following INSERT/UPDATE/DELETE advances the stream position and leaves a schema marker. The intuition, carried over from MySQL, was that a DDL is an event like any other: it happens at some position, so a schema-only window should advance the position to that DDL and record a schema snapshot there.

On MySQL that is what happens. On Postgres it is not: a pure ADD COLUMN with no row behind it produced nothing in the logical stream — no relation message, no position advance, no snapshot. The new column's shape only appeared once a row for that table finally flowed. The same window, the same intent, two engines, and one of them treats a bare schema change as a non-event.

## Why (the mechanism)

The two engines carry DDL in fundamentally different ways:

- Postgres — pgoutput never streams DDL. Logical decoding emits data changes and the schema descriptors needed to interpret them; it does not emit ALTER TABLE. A schema change surfaces only indirectly, as an updated RelationMessage — and pgoutput sends that lazily: right before the first row change for that relation after the schema changed. No row change, no RelationMessage. So an ALTER … ADD COLUMN that isn't followed by any DML to that table leaves the stream untouched; the altered shape is invisible until data moves behind it.

- MySQL — the binlog logs DDL as a first-class statement. An ALTER TABLE is written to the binlog as a text Query event at its own position, immediately, whether or not any row ever follows. A reader sees the DDL the moment it happens.

So a &ldquo;DDL-only window&rdquo; is not one shape across engines. On MySQL it has a concrete position and a visible statement. On Postgres, until a row flows, it has neither — the change is real in the catalog but absent from the stream.

## Where it bit us

sluice's logical-backup restore has a completeness check: it refuses a backup incremental whose recorded change chunks were deleted (a store-level tamper) by asserting the replay reaches the window's recorded end position — either via the last replayed change, or via a schema-history snapshot anchored exactly there (the legitimate schema-only-window case). We were hardening that check against a forged anchor, and needed to know: what does a real schema-only window actually look like?

The ground truth settled it. On Postgres a pure DDL-only window has no snapshot and an empty end position, so it never even reaches the anchor branch — it's applied from the recorded schema delta and skipped by the completeness guard entirely. A snapshot that does sit at the end position, on either engine, only arises when a real column-changing DDL produced a schema delta (which the diff always records) or when data followed the DDL and the snapshot is anchored before those rows. So the guard now trusts an anchor at the boundary only when the window also carries a schema delta — an emptied-data window's forged anchor, which has none, is refused. The engine-visibility divergence is exactly why the naive &ldquo;a schema-only window advances the position to its snapshot&rdquo; assumption — true on MySQL, false on Postgres — had to be replaced with something derived from what the stream actually produces.

## The transferable lesson

A schema change is not guaranteed to leave a trace in a CDC stream. On the MySQL binlog it does — a DDL is a logged statement at a known position. On Postgres logical replication it does not: pgoutput carries no DDL, and the relation descriptor that reveals the new shape is emitted only ahead of the first row that uses it, so a bare ALTER with nothing behind it is invisible until data moves. Any completeness check, boundary test, schema-drift detector, or &ldquo;did this DDL replicate yet?&rdquo; probe that assumes the schema change left a mark is unsound the moment you point it at pgoutput — it will pass on the engine you wrote it against and quietly miss the change on the one you didn't. This is a sibling of a CDC position isn't a universal coordinate: that note is about which side of the rows the position sits on; this one is about whether the schema change is even visible without rows behind it. Both are the same warning — a change stream tells you less, and less portably, than it looks like it does.

## Primary sources

- Postgres logical replication protocol — the Relation message, sent before the first change to a relation whose row descriptor the subscriber hasn't seen; pgoutput carries no DDL statements.

- MySQL binlog — a DDL QUERY_EVENT records the statement text at its own log position.

- Companion note — A CDC position isn't a universal coordinate.

---
Canonical page: https://sluicesync.com/field-notes/ddl-invisible-without-rows/ · Full docs index: https://sluicesync.com/llms.txt
