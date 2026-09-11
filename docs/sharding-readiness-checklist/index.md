# Is your schema ready to be sharded?

> A checklist of read-only queries you run against the database you already have, before anything moves.

What changes when your Postgres is sharded explains which guarantees stop holding. This page answers the narrower question: do any of them matter for your schema?

Every query below runs against the database you already have &mdash; no Neki, no migration, no commitment. Each one is cheap, read-only, and answers in seconds. Pick your intended shard key first; most of the checks are relative to it.

Why before rather than after. Every problem on this list is cheaper to fix while the data is still on one node. Changing a primary key on a live sharded table means moving rows between shards; changing it beforehand is an ALTER TABLE.

## 0. Choose a shard key, and sanity-check it

A shard key that changes is a data-model problem on every sharded system &mdash; and on Neki it is refused outright, so it is worth ruling out first. If your candidate column is ever updated, pick a different one.

    -- Columns your application updates are the WRONG shard key.
    -- This finds candidates: high-cardinality, NOT NULL, never-updated columns.
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.is_nullable = 'NO'
      AND c.column_name IN ('tenant_id','account_id','org_id','customer_id','workspace_id')
    ORDER BY 1, 2;

Adjust the name list to your own conventions. The point is to find the column that already partitions your data logically &mdash; if one exists, it is almost always the right shard key.

## 1. Which tables would lack the shard key in their primary key?

This is the most important query on the page. A sharded table whose primary key does not contain the shard key is the shape where an upsert inserts a duplicate instead of updating &mdash; silently, because ON CONFLICT is only evaluated on the shard the incoming row routes to.

    -- Replace 'tenant_id' with your shard key.
    SELECT t.tablename AS needs_shard_key_in_pk
    FROM pg_tables t
    LEFT JOIN (
      SELECT i.indrelid::regclass::text AS tbl
      FROM pg_index i
      JOIN pg_attribute a
        ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary AND a.attname = 'tenant_id'
    ) ok ON ok.tbl = t.tablename
    WHERE t.schemaname = 'public' AND ok.tbl IS NULL
    ORDER BY 1;

Every table this returns needs one of: the shard key added to its primary key, exclusion from the sharded set, or a deliberate decision that it is append-only and never upserted.

sluice refuses a target in this shape before writing anything (SLUICE-E-TARGET-SHARD-KEY-NOT-IN-UPSERT-KEY), so a missed table fails loudly rather than corrupting &mdash; but finding it now is cheaper than finding it mid-migration.

## 2. Which tables have no primary key at all?

    SELECT t.tablename AS no_primary_key
    FROM pg_tables t
    LEFT JOIN pg_index i
      ON i.indrelid = (quote_ident(t.schemaname)||'.'||quote_ident(t.tablename))::regclass
     AND i.indisprimary
    WHERE t.schemaname = 'public' AND i.indrelid IS NULL
    ORDER BY 1;

Keyless tables are a problem before sharding is even considered &mdash; they block continuous replication generally, because there is no way to identify a row for an UPDATE or DELETE. Sharding makes it worse, not different.

## 3. Which UNIQUE constraints are correctness requirements?

On a sharded table, UNIQUE is enforced within a shard. The constraint is still created; it just means less than it says.

    -- Every UNIQUE constraint that does NOT contain the shard key.
    -- These are the ones that stop being global.
    SELECT c.conrelid::regclass AS table_name,
           c.conname            AS constraint_name,
           pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    WHERE c.contype = 'u'
      AND c.connamespace = 'public'::regnamespace
      AND NOT EXISTS (
        SELECT 1 FROM unnest(c.conkey) k
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
        WHERE a.attname = 'tenant_id'   -- your shard key
      )
    ORDER BY 1, 2;

For each row returned, decide which it is:

- A correctness requirement (a login email, a billing reference) &mdash; it needs the shard key added, a move to an unsharded table, or an application-level check.

- A convenience (a natural key you happen to index) &mdash; nothing to do; per-shard uniqueness is fine.

## 4. Do you have EXCLUDE constraints?

    SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE contype = 'x' AND connamespace = 'public'::regnamespace
    ORDER BY 1;

Same story as UNIQUE, and usually more surprising &mdash; an EXCLUDE preventing overlapping bookings prevents them within a shard. Two overlapping rows on different shards coexist happily.

## 5. Which extensions do you use?

    SELECT extname, extversion FROM pg_extension ORDER BY 1;

Check each against the target &mdash; not against the target's catalogue. pg_available_extensions lists things that cannot actually be created: on the cluster we measured, postgis appears at version 3.6.4 and CREATE EXTENSION postgis fails with permission denied (SQLSTATE 42501), because the default role is not a superuser.

The measured allowlist is in the semantics page. Treat it as a point-in-time measurement of a preview platform, not a rule &mdash; and note it is not PostgreSQL's own trusted flag, so you cannot derive it.

## 6. Does anything update your candidate shard key?

No query can answer this from the catalogue &mdash; it is a property of your application, not your schema. Grep your codebase for UPDATE statements touching the column, and check any ORM-driven writes that set a whole row.

If the answer is yes, the shard key is wrong. On Neki the update is refused outright (SQLSTATE NK013), on the statement shape, even when the value is unchanged.

## 7. Will you need continuous replication out later?

If your plan involves streaming out of the sharded database &mdash; to a warehouse, a search index, a second region &mdash; check that it is available before you commit. On Neki today it is not: the router refuses a replication connection outright, measured even on an unsharded database. A one-shot migrate out works fine.

## Reading the result

All empty? Your schema is already shaped for sharding, which is more common than it sounds if you built multi-tenant from the start.

A handful of tables in check 1? Normal, and a contained ALTER TABLE each.

Many rows in check 3, most of them correctness requirements? Worth pausing. Global uniqueness across a sharded table is the constraint sharding is least able to give you, and designing around it after the fact is expensive.

When you are ready, Migrate PlanetScale Postgres to Neki is the tested procedure, and what sluice refuses on a sharded target covers what happens if something on this list is missed.

---
Canonical page: https://sluicesync.com/docs/sharding-readiness-checklist/ · Full docs index: https://sluicesync.com/llms.txt
