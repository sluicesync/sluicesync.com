# What changes when your Postgres is sharded

> Sharding changes what your schema guarantees, and several of the changes are silent. Measured on a live PlanetScale Neki cluster.

Sharding a PostgreSQL database does not only spread it across machines. It changes what your schema guarantees, and several of the changes are silent &mdash; the statement succeeds, the exit code is zero, and the result is not what the same SQL means on one node.

This page is about PlanetScale Neki specifically, but most of it is true of any sharded PostgreSQL. Everything below was measured on a live 3-shard cluster on 2026-09-10 (PostgreSQL 18.6, platform preview) rather than taken from documentation. Neki is in preview; re-check anything load-bearing before you bet on it.

The short version. Three guarantees you almost certainly rely on stop holding globally: UNIQUE, PRIMARY KEY conflict detection, and the ability to change a column's value. If your schema depends on any of them across the whole table rather than within one shard, that dependency needs a plan before you migrate, not after.

## Your UNIQUE constraint is only unique within a shard

A UNIQUE constraint is accepted in full on a sharded table and enforced per shard. Two rows carrying the same value in a UNIQUE column can coexist, at exit 0, with no error at any point &mdash; if they route to different shards.

The same is true of EXCLUDE constraints. Both are created without complaint, and both quietly mean something narrower than they say.

This is not a bug so much as arithmetic: enforcing uniqueness globally would require a cross-shard read on every insert, which is the cost sharding exists to avoid. But it is rarely what the schema author intended, and nothing warns you.

What to do. For every UNIQUE constraint, ask whether it is a correctness requirement or a convenience. If an email address must be globally unique, the shard key has to be the email (or uniqueness has to move to an application-level check, or a separate unsharded table). If it is a convenience index, nothing needs to change.

## An upsert can insert a duplicate primary key

This one is worth understanding in detail, because it is the shape every change-data-capture pipeline and every idempotent writer uses:

    INSERT INTO t (...) VALUES (...)
    ON CONFLICT (id) DO UPDATE SET ...

ON CONFLICT is evaluated only on the shard the incoming row routes to, and routing is by shard key. So if a row's shard key changes, the new version routes to a different shard, finds no conflict there, and is inserted alongside the original. Two rows, one primary key.

Measured: two rows carrying id = 3001, physically resident on different shards, at exit 0 with no warning. And an equality-routed read returns only one of them &mdash; so the duplication is invisible to exactly the queries a sharded application is written to use.

What to do. Put the shard key inside the primary key. That is the standard advice for a sharded schema anyway, and it makes the shard key unchangeable for a given key, which closes this hole by construction. sluice refuses a target where the routing columns are not contained in the key it conflicts on (SLUICE-E-TARGET-SHARD-KEY-NOT-IN-UPSERT-KEY) rather than writing duplicates.

## You cannot change the shard key at all

Naming a shard-key column in an UPDATE &hellip; SET list is refused outright:

    ERROR: not implemented: updating index column "tenant_id" is not supported (SQLSTATE NK013)

The refusal is on the statement shape, not the data &mdash; it fires even when you assign the column its own current value. Moving a row between shards is not an update; it is a delete plus an insert.

What to do. Shard on something your application does not update. A routing key that changes is a data-model problem on every sharded system, not just this one. If a one-off correction is needed, express it as a delete followed by an insert.

## Cross-shard transactions are not what you think

A transaction spanning shards has no shared snapshot and no atomic commit. Readers can see part of it. A failure can leave it partly applied.

SET __neki.tx_mode = 'single' forces single-shard transactions, which restores the guarantees at the cost of refusing anything that spans shards &mdash; often the right trade, because a loud refusal beats a partial commit.

## DDL behaves differently in two ways that will surprise you

DDL inside a transaction is invisible to the rest of that transaction, and does not survive the commit. This fails:

    BEGIN;
    CREATE TABLE t (...);
    INSERT INTO t VALUES (...);   -- ERROR: relation "t" does not exist
    COMMIT;                       -- and no table is left behind

That is the shape essentially every schema-migration framework emits, so expect tooling that works on single-node Postgres to fail here &mdash; loudly, but pointing at the wrong thing.

DDL is eventually consistent across routers. Every CREATE/ALTER returns a notice saying the change is visible on this router and may not be on others, with __neki.wait_for_ddl() to wait. This matters for any tool that creates a table and then writes to it over a connection pool, since different connections can land on different routers.

## The topology is a document someone writes, not an inventory

A table created with a plain CREATE TABLE is fully routable and takes writes &mdash; and is never enrolled in the data topology. It simply falls through to the default shard group. On the cluster we measured, 6 of 19 tables were in that state, all working normally.

You find out when a workflow refuses it: move_tables_create answers NK604 &mdash; table doesn't exist in the existing topology for a table that plainly exists and holds rows. Add it with __neki.set_data_topology() first.

## Not every extension in the catalogue can be created

The default role is not a superuser, and the platform allows a specific set rather than everything pg_available_extensions lists. Measured:

installs · refuses (permission denied, 42501) ·

btree_gist, btree_gin, citext, hstore, ltree, pg_trgm, pgcrypto, uuid-ossp, vector · postgis, postgres_fdw, pg_stat_statements ·

postgis is the trap: it is listed at version 3.6.4 and still cannot be created, so its presence in the catalogue proves nothing. And the allowlist is not PostgreSQL's own trusted flag &mdash; vector is marked untrusted and installs anyway, while postgres_fdw and pg_stat_statements are equally untrusted and do not. Probe the specific extensions your schema needs; do not extrapolate.

## Some expressions the router evaluates do not match PostgreSQL

Where the router computes a result itself rather than delegating, the answer can differ from what PostgreSQL would give. Measured: avg(float8) returns a number where PostgreSQL raises 22003, and sqrt/power on numeric return a value PostgreSQL then reports as not equal to its own result.

Low impact for a bulk copy, which moves stored values rather than computed ones &mdash; we measured copies as byte-identical. Higher impact if you are porting an application that computes in SQL and compares the results.

## Neki cannot be a continuous-sync source

Getting data out continuously is not currently possible: the router refuses a replication connection outright.

    FATAL: replication connections must target a specific shard (SQLSTATE 0A000)

Measured on an unsharded Neki database, so this is not a consequence of sharding you can avoid by keeping one shard. Logical replication in Neki is a per-shard facility and the endpoint an application connects to is not one. A one-shot migrate out of Neki works fine, including from a sharded database &mdash; plan a cutover window rather than a continuous tail if you ever need to move back off.

## Before you migrate

Run these against your existing database, before anything moves:

- Which tables would lack the shard key in their primary key? Those are the ones where an upsert can duplicate. Fixing the key is cheaper before the data moves.

- Which UNIQUE constraints are correctness requirements rather than conveniences? Each one needs an answer: shard on it, move it to an unsharded table, or enforce it in the application.

- Do you have EXCLUDE constraints? Same question, same three answers.

- Does anything update what would become the shard key? If so, the shard key is wrong.

- Which extensions do you use? Check each against the table above &mdash; on the target, not from the catalogue.

- Do you need continuous replication out of Neki later? If yes, that is not available today.

sluice refuses the shapes above that would corrupt silently &mdash; before any data moves where the condition is knowable from the schema, and mid-stream where it is a property of a row. That is the argument for using it here rather than a generic copy tool: on a sharded target, the failure modes that matter are the quiet ones.

When you are ready, Migrate PlanetScale Postgres to Neki is the tested step-by-step procedure.

---
Canonical page: https://sluicesync.com/docs/sharded-postgres-semantics/ · Full docs index: https://sluicesync.com/llms.txt
