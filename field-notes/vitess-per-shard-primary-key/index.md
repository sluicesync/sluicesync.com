# Your primary key is only unique per shard

> vtgate merges every Vitess/PlanetScale shard into one logical stream, but per-shard id ranges mean the same primary-key value legitimately exists on several shards. Copy them into one target table with that key and the collisions silently overwrite — exit 0, rows short.

Observed — sharded Vitess / PlanetScale keyspace consolidated into a single target table. Internally Bug 152 + ADR-0048 (--inject-shard-column).

## What happened

Consolidating a sharded Vitess keyspace into one target table finished clean — exit 0 — with fewer rows on the target than the sum of the shards. No error, no duplicate-key complaint. Rows from different shards that shared a primary-key value had silently overwritten each other.

## Why (the mechanism)

A sharded keyspace behind vtgate presents as one logical database, so it is natural to treat it as one source and copy it into one target table. But uniqueness in Vitess is per shard, not global: each shard runs its own MySQL with its own auto-increment range, and tenant-local or hash-partitioned ids mean primary-key value 42 can legitimately exist on shard -80 and again on shard 80-, as two entirely different rows. Merge those into a single target table whose primary key is that id, and the second insert of 42 collides with the first. If the copy uses an upsert/replace, the collisions silently overwrite; if it uses plain inserts, the target's own PK rejects them — either way the consolidated table is short, and unless you are diffing counts per shard it looks like a clean run.

## The repro

    -- vtgate presents one stream; the shards each own id 42:
    mysql> SHOW VITESS_SHARDS;
    --  customer/-80
    --  customer/80-
    -- shard -80: (id=42, name='alice')   shard 80-: (id=42, name='bob')

    -- consolidate into one target with id as PK:
    --   INSERT (42,'alice')  -> ok
    --   INSERT (42,'bob')    -> duplicate key / or REPLACE overwrites alice
    -- result: one row for id=42, one tenant silently lost.

## What sluice does about it

sluice makes the shard identity part of the target key. With --inject-shard-column NAME=VALUE it adds a discriminator column carrying each source's shard identity and folds it into the target's primary/unique key, so (shard, id) is globally unique and no row is overwritten. The consolidation preflight discovers the shard set (via SHOW VITESS_SHARDS) and — critically — fails closed if it can't establish that the merged keys will be unique, rather than proceeding into a silent overwrite. (If your ids are already provably global — Vitess sequences, or UUIDs — you don't need the discriminator, but that has to be true, not assumed.)

## The transferable lesson

"One connection endpoint" does not mean "one key space." A sharded database presented through a single proxy still enforces uniqueness at the shard, so any primary key that isn't provably global — anything backed by per-shard auto-increment or per-tenant numbering — collides the moment you consolidate. Before merging N sources into one table, prove the key is globally unique or make it so (add the shard discriminator to the key), and make the check fail closed — because the failure mode is silent overwrite, and a row-count that's merely "smaller than expected" is easy to rationalize away.

## Primary sources

- Vitess sharding & per-shard uniqueness — Vitess sharding and Vitess sequences (the global-id escape hatch).

- sluice multi-source consolidation — Migrate many databases or schemas.

---
Canonical page: https://sluicesync.com/field-notes/vitess-per-shard-primary-key/ · Full docs index: https://sluicesync.com/llms.txt
