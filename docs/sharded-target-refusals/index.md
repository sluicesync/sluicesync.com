<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# What sluice refuses on a sharded target

> Each refusal exists because a specific silent-corruption shape was measured on a live cluster. This page is the reasoning.

sluice refuses several things on a sharded target that it accepts everywhere else. Each refusal exists because a specific way of losing or corrupting data was measured on a live cluster &mdash; not because sharded targets warrant extra caution in the abstract.

This page is the reasoning. Error codes is the reference.

Why refuse instead of warn. Every shape below fails quietly if allowed through: exit 0, no error, correct-looking row counts, and a target that disagrees with the source in a way you find out about later. A loud refusal you can act on is strictly better than a silent divergence you cannot see. Where the condition is knowable from the schema, the refusal comes before any data moves.

## The shard key is not in the key sluice conflicts on

SLUICE-E-TARGET-SHARD-KEY-NOT-IN-UPSERT-KEY &mdash; refused at preflight, before anything is written.

sluice's idempotent write is INSERT &hellip; ON CONFLICT (key) DO UPDATE. Both the CDC applier and the bulk-copy resume path use it. On a sharded table whose shard key is outside that key, both available spellings fail, and they fail in opposite directions:

- Naming the shard key in the SET list is refused by the platform outright (SQLSTATE NK013), on the statement shape, even when the value is unchanged.

- Leaving it out &mdash; the obvious workaround &mdash; is worse. ON CONFLICT is evaluated only on the shard the incoming row routes to, so a row whose shard key differs from the stored row's finds no conflict there and is inserted alongside it.

Measured: two rows carrying id = 3001, physically resident on different shards, at exit 0 with no warning &mdash; and an equality-routed read returns only one of them, so the duplication is invisible to exactly the queries a sharded application is written to use. A CDC replay of an update that changed the shard key produces this, and an at-least-once pipeline will eventually emit one.

There is no third spelling, which is why this is a refusal rather than a degradation. The safe condition is a property of the schema &mdash; every shard-key column contained in the conflict key &mdash; so it is knowable before any data moves and fixable by you.

The fix: put the shard key in the primary key. That is the standard advice for a sharded schema anyway, and it makes the shard key unchangeable for a given key.

### On Vitess / PlanetScale MySQL: a vindex column outside the primary key (v0.156.9+)

On a sharded Vitess or PlanetScale MySQL keyspace the same pair holds for a vindex column outside the primary key (GC-41 (e)). vtgate refuses an ON DUPLICATE KEY UPDATE that assigns any vindex column (VT12001: DML cannot update vindex column, measured on vttestserver), and the spellings it accepts &mdash; leaving the column out, or col = VALUES(col) &mdash; insert a moved row on its new shard beside the original. So there is no write sluice can send.

A sync cold start, and its stopped-copy resume, read each in-scope table's vindexes (SHOW VSCHEMA VINDEXES ON) and refuse with the same code before anything is written, naming the table and the column. A table with no primary key fails on every vindex column. A table whose vschema or key cannot be read is passed with a WARN, because vtgate then refuses the offending write itself (SHARDED-TARGET-VINDEX-UPDATE). A warm restart of an existing stream runs no such preflight and still stops at the first refused write. Through v0.156.8 every such stream also failed, but only at its first row.

The fix on Vitess / PlanetScale: make the primary key contain every vindex column, or move the primary vindex onto the primary key. A UNIQUE index does not help there, because the MySQL CDC applier's upsert leaves only primary-key columns out of its update list. Scope of what then applies: sharded → sharded.

## Routing and placement disagree

SLUICE-E-TARGET-SHARD-PLACEMENT-MISMATCH &mdash; refused before any data moves.

If a table is attached to a shard group without moving its rows to the shards that routing now points at, the table's PRIMARY KEY stops being globally enforced: equality-routed queries look on the shard the key routes to, find nothing, and an upsert inserts a second copy.

The usual cause is attaching a populated table to a shard group without running a reshard workflow. sluice probes for it rather than assuming, and refuses if it finds it.

The fix: run the platform's reshard workflow so the rows are where the topology says they are, then re-run.

## A change would move a row between shards

SLUICE-E-TARGET-SHARD-KEY-UPDATE-UNSUPPORTED &mdash; refused mid-stream, on a target that passed the preflight above.

A CDC change that alters a shard-key value would have to move the row to a different shard, which a sharded target cannot express. sluice refuses rather than applying the other columns and leaving the routing column behind &mdash; that would make the target's row disagree with the source's on the one value that decides where the row lives, silently, with the stream still reporting healthy.

Only a genuine change reaches here. An unchanged shard key is dropped from the UPDATE's SET list automatically, because the before-image proves the assignment is a no-op and the WHERE clause still routes the statement correctly.

The fix: shard on a column your application does not update. If the change is a one-off, apply it on the source as a delete plus an insert, which sluice replicates as two changes that both route correctly.

## Vitess / PlanetScale MySQL: a write that assigns a primary-vindex column

SHARDED-TARGET-VINDEX-UPDATE &mdash; the stream stops mid-apply, terminal (v0.156.7+).

On a sharded Vitess or PlanetScale MySQL keyspace, vtgate refuses an UPDATE or ON DUPLICATE KEY UPDATE that assigns a table's primary-vindex column (Error 1235, VT12001). That keeps a row from being moved between shards, and nothing is written. Before v0.156.7 the stream stopped on the bare 1235. It now stops with this marker, the table and a remedy. The position stays where it was, and nothing is written silently.

The marker exists because the refusal decides what you can sync into a keyspace you pre-created and vindexed yourself. The scope, measured on a 2-shard vttestserver (GC-41 (e)):

- Every vindex column inside the primary key: inserts, updates and deletes apply on every apply path, the per-change path included (--apply-batch-size 1, the broker and chain restore, a partial after-image including the default-on ADD COLUMN backfill, a primary-key change that keeps the vindex value). Since v0.156.9 the per-change UPDATE leaves a key column whose value did not change out of its SET list, the shape the batched path has always sent; &ldquo;did not change&rdquo; is compared bit-exactly, so a DOUBLE/FLOAT key moving between 0 and -0 is still sent. Through v0.156.8 every such update stopped the stream here, even with the key unchanged.

- A vindex column outside the primary key, or a table with no primary key: no write sluice can send works. Since v0.156.9 a sync cold start refuses it up front with SLUICE-E-TARGET-SHARD-KEY-NOT-IN-UPSERT-KEY; a warm restart of an existing stream, or a vschema the role cannot read, still stops here at the first refused write.

- A change that really moves a row's vindex value (a change to a vindexed primary-key column, or a new value in a vindex column) cannot be applied through vtgate at all.

- Two narrow shapes are still refused at write time with the vindex in the key: an insert into a table whose every column is in the primary key when the first key column is a vindex column, and an UPDATE whose after-image holds only unchanged key columns. Both are filed.

It is terminal. It carries no SLUICE-E-* code and exits 1. A restart re-delivers the same change and refuses again, so under sluice sync run the leg is marked failed and not restarted.

One shape vtgate does let through silently: ON DUPLICATE KEY UPDATE col = VALUES(col), which it executes as an insert on the new shard and leaves the old row in place. That is a cross-shard duplicate at exit 0, measured on vttestserver. sluice never sends that spelling to a Vitess-family target (its upsert uses the row-alias form, which vtgate refuses loudly), and a test pins it.

The fix: for a change that moves a row's vindex value, delete the row on the target and re-copy it, or sync into an unsharded keyspace. For a vindex column outside the primary key, put it in the primary key. A stream that stopped here on an earlier release for an UPDATE that did not change the key can be restarted on v0.156.9. The full scope is under sharded → sharded.

## A workflow has taken the table away

SLUICE-E-TARGET-TABLE-BLOCKED-BY-WORKFLOW &mdash; the stream halts.

A PlanetScale Neki MoveTables cutover moves tables between databases. Because a Postgres client chooses its database at connect time, the write switch cannot redirect a connection that named the old one &mdash; so it blocks the table there instead, on every shard primary, and every statement sluice makes is refused (SQLSTATE NK213).

Nothing is lost when this fires. Measured across a full cutover with a live stream and a running writer: 2,000 rows byte-identical end to end. move_tables_create and the read switch are completely transparent; it is the write switch that takes the table. The persisted CDC position stops before the block rather than advancing past unapplied changes, which is what makes a restart replay the gap instead of skipping it.

It is terminal rather than retried: the block carries a one-year expiry and clears only on an operator action, and the resolution changes which database the data lives in &mdash; not a decision a migration tool should make for you.

The fix: __neki.list_blocked_tables() names the database and table; __neki.move_tables_status() names the workflow. Then either finish the move and restart sluice against the new database, or reverse the cutover.

## What sluice does not protect you from

Stated plainly, because a page listing refusals can read as a claim of total coverage:

- Per-shard UNIQUE and EXCLUDE constraints. sluice copies your schema faithfully, and the platform enforces those constraints within a shard. sluice does not warn that a constraint means less than it says &mdash; see the readiness checklist to find them yourself before migrating.

- Cross-shard transaction semantics. Reads that span shards have no shared snapshot. That is a property of your queries after the migration, not of the copy.

- A commit torn between two data shards. On Vitess and PlanetScale MySQL, vtgate's default transaction_mode=MULTI commits a multi-shard transaction shard by shard with no two-phase commit. sluice orders its rows ahead of its control-table writes, which covers a tear between the data and the sidecar control keyspace. A source transaction whose rows span two data shards can still tear between them, and that class is not covered (under triage).

- Router-evaluated expression differences. Bulk copy moves stored values, which we measured byte-identical; computed results are an application concern.

- Choosing the shard key. sluice checks that your schema is consistent with the key you chose. Whether it is a good key is a design question.

The pattern is consistent: sluice refuses what it can prove would diverge, and tells you plainly where it cannot see.

---
Canonical page: https://sluicesync.com/docs/sharded-target-refusals/ · Full docs index: https://sluicesync.com/llms.txt
