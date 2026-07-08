# Copy a subset of tables (cross-engine, with continuous sync)

> Copy one-to-several tables from an existing Postgres database to a PlanetScale MySQL/Vitess (or plain MySQL) target and keep just those continuously in sync.

You don't have to move a whole database. --include-table / --exclude-table scope a migrate or a sync start to just the tables you choose — for both the bulk copy and the CDC stream — so you can copy one-to-several tables from an existing Postgres database into a PlanetScale MySQL/Vitess (or plain MySQL) target and keep only those continuously in sync. This guide covers selecting the tables, how Postgres schemas map onto MySQL databases/keyspaces (the part people get surprised by), the PlanetScale keyspace prerequisite, and foreign-key handling for Vitess targets.

## Select the tables

Two mutually-exclusive flags scope any run. Use one or the other, never both:

- --include-table t1,t2 — copy only these (comma-separated, repeatable, and glob-aware, e.g. app_*).

- --exclude-table t1,t2 — copy everything except these (same syntax).

The scope is honored end to end: it filters the bulk copy, the VStream / logical-replication cold-start snapshot, and the live CDC apply. An excluded table in a large source is never even read — not merely "not written" — so scoping down a big source is cheap, not just tidy.

    sluice migrate \
        --source-driver postgres --source 'postgres://user:pw@src/appdb?sslmode=require&schema=app' \
        --target-driver mysql    --target 'root:pw@tcp(dst:3306)/app' \
        --include-table users,orders

## How Postgres schemas map to MySQL

This is the crux, and it surprises people: a Postgres schema and a MySQL database are the same namespace tier. So when the target is MySQL, a PG schema maps to a MySQL database — not to a table prefix, and never flattened silently into one place.

### Default — one schema in, one database out

By default the source DSN's ?schema=app (or public) names the single namespace copied; every other schema on the source is ignored — there is no flattening. On a plain MySQL target the target database must already exist: sluice does not create it, and a missing one fails loudly rather than guessing:

    # target database 'app' must already exist on plain MySQL, or:
    #   Error 1049 (42000): Unknown database 'app'
    sluice migrate \
        --source-driver postgres --source 'postgres://user:pw@src/appdb?sslmode=require&schema=app' \
        --target-driver mysql    --target 'root:pw@tcp(dst:3306)/app' \
        --include-table users,orders

### Copy more exactly — each schema to its own database

If you want to bring several schemas across faithfully, fan them out: --all-schemas (every non-system schema) or --include-schema app,reporting (glob-aware). Each PG schema becomes an auto-created same-named MySQL database, and same-named tables in different schemas stay separate — app.users and reporting.users are two distinct target tables in two distinct databases, never merged. Use a target DSN with a trailing / and no database, so the run connects to the server rather than one database:

    sluice migrate \
        --source-driver postgres --source 'postgres://user:pw@src/appdb?sslmode=require' \
        --target-driver mysql    --target 'root:pw@tcp(dst:3306)/' \
        --include-schema app,reporting

This is the "copy more of the database, exactly" answer: multiple target databases, one per schema. On PlanetScale each of those target databases is a keyspace — see the keyspace note below, which changes the pre-creation rule.

### Flattening many schemas into one database is refused

Merging two source schemas into a single target database is deliberately refused, because it would collide same-named tables and silently lose one. --map-schema app=x --map-schema reporting=x errors:

    many-to-one is refused; sluice never merges two source namespaces into one target

--map-schema old=new is a 1:1 rename only — e.g. --map-schema app=app_prod routes one schema to one differently-named database. It is not a merge tool.

### --include-table under fan-out is per-schema

When you combine table scoping with a fan-out, the table filter applies per schema, not globally. So --all-schemas --include-table users copies both app.users and reporting.users — the name is matched inside each schema independently.

Gotcha: a fanned-out schema with no matching table fails the whole run. If any selected schema has no table matching --include-table (a stray empty public is the classic case), the run ends in a loud non-zero error even though every other schema copied fine. Pair --all-schemas --include-table … with --exclude-schema public (or list exactly the schemas you mean with --include-schema) so no empty namespace is in scope.

### Summary

Scenario · Target namespaces · Auto-create target DB? · Same-named tables ·

Single schema (default) · The one schema in the DSN → one database · No — database must pre-exist on plain MySQL · n/a (one namespace) ·

Fan-out (--all-schemas / --include-schema) · Each schema → its own same-named database · Yes on plain MySQL (keyspace must pre-exist on PlanetScale) · Stay separate — never merged ·

Flatten (--map-schema a=x --map-schema b=x) · Refused · — · — ·

--include-table under fan-out · Filter applied per-schema · Per the fan-out row above · One copy per schema that has the table ·

## PlanetScale / Vitess keyspaces

On a PlanetScale/Vitess target, the DSN's database is the keyspace, and sluice does NOT auto-create it. Unlike plain MySQL — where a fan-out target database is created for you — a PlanetScale/Vitess keyspace must be pre-provisioned. pscale database create app gives you the default keyspace (named after the database); create more with pscale keyspace create … --wait. A missing keyspace fails loudly before any data moves:

    Error 1105 (HY000): VT05003: unknown database 'app' in vschema

So an --all-schemas fan-out to PlanetScale requires every target keyspace to exist first — create them all before the run. Use --target-driver planetscale and a DSN of the form …/<keyspace>?tls=true (the PlanetScale MySQL DSN uses ?tls=true, not the Postgres sslmode=…).

## Keep only the subset in sync

The same table scope carries onto sync start: it cold-copies only the included tables, then tails CDC for only those. An insert into an excluded table is never created or streamed on the target — the excluded table is outside the stream entirely (live-confirmed):

    sluice sync start --stream-id sub \
        --source-driver postgres   --source 'postgres://user:pw@src/appdb?sslmode=require&schema=app' \
        --target-driver planetscale --target 'USER:PASS@tcp(aws.connect.psdb.cloud:3306)/<keyspace>?tls=true' \
        --include-table users

Watch it, gate cutover on freshness, then drain and stop:

    sluice sync status --stream-id sub \
        --target-driver planetscale --target "$SLUICE_TARGET"

    sluice sync health --stream-id sub \
        --target-driver planetscale --target "$SLUICE_TARGET" --max-stale-seconds 30

    sluice sync stop --stream-id sub \
        --target-driver planetscale --target "$SLUICE_TARGET" --wait

Two operational callouts. First, sync stop requires --target-driver and --target — it reads the stream's state from the target, so it errors with a "missing flags" message without them. Second, a stopped Postgres stream leaves its replication slot behind on the source; drop it before starting a fresh stream (SELECT pg_drop_replication_slot('sluice_slot');) or sluice refuses loudly with "replication slot already exists; drop it before starting". The Postgres source also needs wal_level=logical — see Prepare a Postgres source.

## Foreign keys on a Vitess target

If your subset carries foreign keys and you're targeting PlanetScale/Vitess — where cross-shard FKs don't work and FK support is opt-in per database — --skip-foreign-keys (v0.99.198+) skips creating the FK constraints on the target while keeping each FK's referencing columns indexed. It synthesizes a backing index only when an existing target index doesn't already cover those columns as a left-prefix, so you transition an FK-bearing source without stripping the FKs from it first, and joins stay fast. Add it to the migrate or sync start command:

    sluice migrate \
        --source-driver postgres    --source 'postgres://user:pw@src/appdb?sslmode=require&schema=app' \
        --target-driver planetscale --target 'USER:PASS@tcp(aws.connect.psdb.cloud:3306)/<keyspace>?tls=true' \
        --include-table users,orders \
        --skip-foreign-keys

It is mutually exclusive with --allow-degraded-fks (opposite intents — one skips FK creation, the other creates FKs and tolerates dirty source rows), and it is never silent: each skipped FK is reported on its own log line (the table, the referencing columns, and the synthesized or already-covering index) plus a summary count. Alternatively, enable FK support on the PlanetScale database instead of skipping — turn on "Allow foreign key constraints" in the target database's Settings → General tab (unsharded databases only) so sluice's FK DDL is accepted; see the region-move guide's foreign-key note.

## Next steps

- Migrate many databases or schemas — the full fan-out story across every schema or database at once.

- PlanetScale Postgres, Move PlanetScale regions, and PlanetScale & Vitess — the target-side setup for each PlanetScale flavor.

- Verify & reconcile — confirm only the tables you scoped landed, with matching --include-table.

- Command reference — every flag named here, with defaults.

---
Canonical page: https://sluicesync.com/docs/copy-table-subset/ · Full docs index: https://sluicesync.com/llms.txt
