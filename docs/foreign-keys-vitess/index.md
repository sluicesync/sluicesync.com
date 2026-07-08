# Foreign keys on a Vitess / PlanetScale target

> Migrating or syncing a foreign-key-bearing source into Vitess or PlanetScale MySQL — the two strategies (skip-and-index, or enable FK support) and how to choose.

When the target is Vitess — or PlanetScale MySQL, which is managed Vitess — foreign keys need a decision that a plain MySQL or Postgres target doesn't force on you. This guide covers why, the two strategies sluice supports, and which one to pick. It applies to both the one-shot migrate and the sync start cold-start.

## Why Vitess is different

Vitess treats foreign keys specially, for two reasons:

- Cross-shard FKs don't work. A sharded keyspace can't enforce a constraint whose parent and child rows live on different shards — there's no shard-spanning transaction to check referential integrity against.

- On PlanetScale, FK support is opt-in per database, and only on unsharded databases. By default PlanetScale rejects FOREIGN KEY DDL outright (Vitess answers with VT10001); you turn support on per database, and even then only when the database is unsharded.

So migrating an FK-bearing source — a Postgres or MySQL database that has foreign keys — into Vitess/PlanetScale needs a call: skip the FKs, or turn FK support on. sluice supports both, and never silently drops a constraint — whichever path you take is explicit and logged.

## Strategy 1 — skip the constraints, keep the columns indexed

--skip-foreign-keys (v0.99.198+, on migrate and sync start) skips creating the FK constraints on the target, but ensures each skipped FK's referencing column tuple is still indexed. It synthesizes a plain backing index only when no existing target index already covers those columns as a left-prefix — never a redundant one.

Why the index matters. On a MySQL/Vitess target, MySQL auto-creates an FK's backing index only when the FK itself is created. A naive skip would therefore leave the referencing column unindexed and slow every join through it. sluice keeps the column indexed so joins stay fast — you get the transition without the performance cliff.

This lets an existing FK-bearing database transition without stripping the FKs from the source first. It's the right choice for a sharded target (where FKs can't be enforced anyway) or any target where FKs are managed out-of-band.

    sluice migrate \
        --source-driver postgres    --source 'postgres://user:pw@src/appdb?sslmode=require&schema=app' \
        --target-driver planetscale --target 'USER:PASS@tcp(aws.connect.psdb.cloud:3306)/<keyspace>?tls=true' \
        --skip-foreign-keys

The same flag is available on sync start, where it applies to the cold-start schema-apply — steady-state CDC apply never creates FKs, so nothing else changes. It is mutually exclusive with --allow-degraded-fks (opposite intents — one skips FK creation, the other creates FKs and tolerates dirty source rows) and sluice refuses loudly if both are set. And it is never silent: each skipped FK is logged on its own line — the table, the referencing columns, and the synthesized or already-covering index — plus a summary count at the end of the run.

## Strategy 2 — enable FK support on an unsharded PlanetScale database

If the target is an unsharded PlanetScale database and you want the foreign keys, turn on "Allow foreign key constraints" in the database's Settings → General tab in the PlanetScale UI. This is a toggle, not a pscale flag — the operator sets it after creating the database, and it applies to unsharded databases only.

Once it's on, no special sluice flag is needed: sluice's normal foreign-key DDL is accepted and the constraints are created as usual (leave --skip-foreign-keys off). Enable it before you migrate, with no open deploy requests. See the region-move guide's foreign-key note for the full PlanetScale-side caveats (cyclic CASCADE FKs are unsupported; deploy requests don't validate pre-existing rows).

## Which to use

Target · Foreign keys? · Strategy ·

Sharded · Can't be enforced cross-shard · Skip — --skip-foreign-keys (columns stay indexed) ·

Unsharded · Wanted · Enable FK support in Settings → General, then migrate normally ·

Unsharded · Not wanted / managed elsewhere · Skip — --skip-foreign-keys ·

The two strategies are not combined. --skip-foreign-keys means no FK DDL at all — it doesn't emit constraints for an FK-enabled database to accept. Enable FK support or skip; pick one per target.

## Next steps

- Copy a subset of tables — scope a migrate or sync to just the tables you choose; FK handling in context.

- PlanetScale & Vitess — the full target-side setup for a Vitess/PlanetScale-MySQL destination.

- Move PlanetScale regions — the FK-enablement note lives in its "Before you start" section.

- PlanetScale Postgres — the other PlanetScale flavor, where FKs behave like normal Postgres.

- Command reference — --skip-foreign-keys, --allow-degraded-fks, and every other flag, with defaults.

---
Canonical page: https://sluicesync.com/docs/foreign-keys-vitess/ · Full docs index: https://sluicesync.com/llms.txt
