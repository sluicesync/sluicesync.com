# Migrate PlanetScale Postgres to Neki

> Neki is PlanetScale's sharded Postgres. sluice reaches it with the ordinary postgres driver — no new engine, no flag — and this page is the procedure we measured end to end against live databases.

Neki is PlanetScale's horizontally-sharded PostgreSQL: a router speaking the PostgreSQL wire protocol in front of real PostgreSQL clusters. It is the Postgres counterpart of what Vitess does for MySQL, and it is in platform preview.

Every step below was measured on 2026-09-10 against a real PlanetScale Postgres database (PostgreSQL 18.6, PS-10) and a real Neki database (PostgreSQL 18.6, PS-10, same region), using a 12-table schema covering every value family sluice knows about. Where something was not tested, this page says so rather than implying coverage.

There is no neki driver, and that is deliberate. --target-driver neki does not exist. sluice detects Neki from the server's own version() string and adapts the handful of behaviours that differ. Worth stating because PlanetScale's own CLI takes pscale database create --engine neki, so it is reasonable to go looking for the same word here.

    sluice migrate \
      --source-driver postgres --source "$PS_POSTGRES_DSN" \
      --target-driver postgres --target "$NEKI_DSN"

## Before you start

Connection strings. pscale role reset-default <db> <branch> --format json returns a database_url carrying sslmode=verify-full. That works anywhere the system CA store is populated. In a container without CA certificates it fails with root certificate file "/root/.postgresql/root.crt" does not exist — use sslmode=require, or mount a CA bundle. Applies to both ends.

Create your extensions on the target first. sluice does not install them — extensions are surfaced, never silently auto-handled. Check the source and mirror the set you actually use:

    -- on the source
    SELECT extname, extversion FROM pg_extension ORDER BY 1;
    -- on the target, for each one your schema uses
    CREATE EXTENSION IF NOT EXISTS btree_gist;

Not every extension in the catalog can actually be created. The default role Neki hands you is not a superuser (rolsuper = false), and the platform allows a specific set rather than everything pg_available_extensions lists. Measured on a live Neki database, 2026-09-10:

installs · refuses with permission denied to create extension (SQLSTATE 42501) ·

btree_gist, btree_gin, citext, hstore, ltree, pg_trgm, pgcrypto, uuid-ossp, vector · postgis, postgres_fdw, pg_stat_statements ·

Check the target before you plan the migration, not during it — postgis in particular is listed in pg_available_extensions at 3.6.4 and still cannot be created, so its presence there proves nothing. And the allowlist is not PostgreSQL's own trusted flag: vector is marked untrusted and installs anyway, while postgres_fdw and pg_stat_statements are equally untrusted and do not. Treat the table above as measurements rather than a rule to extrapolate from, and probe the specific extensions your schema needs.

If a needed extension is missing on the target, sluice refuses with SLUICE-E-SCHEMA-EXTENSION-NOT-ENABLED naming the extension and the exact command — not PostgreSQL's raw "no default operator class" message. That refusal is what you want; a postgis source is a reason to stop and talk to PlanetScale, not something to work around.

Nothing to configure for CDC. Measured on PlanetScale Postgres: wal_level is already logical and the default postgres role already has rolreplication. There is no operator action here, unlike most managed PostgreSQL. max_replication_slots was 20.

Tables with no primary key need a replica identity — only if you use sync. A one-shot migrate does not care. For sync, PostgreSQL cannot identify rows for UPDATE/DELETE without one, and sluice refuses at preflight with SLUICE-E-SOURCE-REPLICA-IDENTITY naming the table:

    ALTER TABLE public.events REPLICA IDENTITY FULL;

…or take it out of scope with --exclude-table. Do this before starting — the refusal fires before anything is copied.

## Option A — one-shot migration

Right when you can take a window.

    sluice migrate \
      --source-driver postgres --source "$PS_POSTGRES_DSN" \
      --target-driver postgres --target "$NEKI_DSN" \
      --migration-id ps-to-neki

Measured: 12 tables, exit 0, every table byte-identical to the source afterwards.

## Option B — minimal downtime

Copies, then tails changes until you cut over.

    sluice sync start \
      --source-driver postgres --source "$PS_POSTGRES_DSN" \
      --target-driver postgres --target "$NEKI_DSN" \
      --stream-id ps-to-neki \
      --slot-name psneki \
      --publication-name sluice_pub_psneki

The cold copy runs, the stream reports entering CDC mode, and changes apply continuously. Measured live: inserts, updates and deletes made on the PlanetScale Postgres source after the handoff — including NaN, -0 and Infinity in float and numeric columns, astral-plane text, an enum change, a range change, a composite-key delete and an insert into a keyless table — all landed on the Neki target, with every table still byte-identical.

Use a dedicated --publication-name per stream. sluice refuses to re-scope a publication another slot is reading, which is the right behaviour and easy to trip over if you run more than one stream against the same source.

### Cutover

- Stop writes to the PlanetScale Postgres source.

- Wait for the stream to drain — sluice sync status --stream-id ps-to-neki.

- Verify (below).

- Point the application at Neki.

- sluice sync stop --stream-id ps-to-neki.

## Verifying

Do not take exit 0 as proof. Compare values, computed the same way on both servers:

    SELECT md5(coalesce(string_agg(rowtext, ',' ORDER BY rowtext), '')) AS ck, count(*) AS n
    FROM (SELECT coalesce("col1"::text,'~NULL~') || '|' || coalesce("col2"::text,'~NULL~')
          FROM public."your_table") s(rowtext);

Casting every column to text on the server compares what each side actually stores, rather than what a client decoded. Take the column list from the source, so a dropped or invented column shows up as a mismatch instead of being excluded from both sides.

sluice schema diff between the two is a useful second opinion — it reads both catalogs independently of the copy path.

## Before you shard

A migration lands on an unsharded Neki database, where everything above holds and PostgreSQL semantics are intact. Sharding later changes two things that matter:

Uniqueness becomes per-shard. A PRIMARY KEY, UNIQUE or EXCLUDE constraint is enforced only within a shard unless its columns contain the shard key. Neki accepts the declaration either way, so the guarantee weakens silently. Measured: a table with email text NOT NULL UNIQUE accepted two rows with the same email once they routed to different shards. This is inherent to distributed storage — Vitess and Citus behave the same way — but it means a schema ported from PostgreSQL keeps the constraint on paper and loses it in fact.

And sluice requires the shard key to be in the primary key to keep syncing into a sharded table, refusing with SLUICE-E-TARGET-SHARD-KEY-NOT-IN-UPSERT-KEY otherwise. That refusal exists because ON CONFLICT on a sharded table is evaluated only on the shard the incoming row routes to, so an upsert can insert a duplicate of the key instead of updating it.

Both point the same way: if you intend to shard, get the shard key into the primary key of the tables that will be sharded — ideally before the migration.

## Not supported: Neki as a continuous-sync source

migrate out of Neki works, including from a sharded database. sync out of it does not, and the reason is earlier and more absolute than this page previously said: the router does not accept a replication connection at all.

    sluice: error: pipeline: open snapshot stream: postgres: snapshot: open replication conn:
      FATAL: replication connections must target a specific shard (SQLSTATE 0A000)

Measured 2026-09-10, and measured against an unsharded Neki database — so this is not a sharding consequence you can avoid by keeping one shard. Logical replication in Neki is a per-shard facility; the endpoint an application connects to is not one. sluice fails here, at the snapshot open, before any of the downstream questions arise.

An earlier version of this page attributed the limitation to snapshot import — pg_export_snapshot() / SET TRANSACTION SNAPSHOT being unimplemented. That would be a real obstacle if you got that far; you do not, because the connection is refused first. Corrected because a wrong mechanism sends you looking for a workaround at the wrong layer. Plan a cutover window if you ever need to move back off Neki.

## What we have not tested

Stated so this page cannot be read as broader than it is:

- Migrating into an already-sharded Neki database. Every measurement here targeted an unsharded one, which is where a migration lands by default.

- Volume — the fixture was correctness-shaped (every value family, adversarial values), not volume-shaped.

- Multiple schemas. Everything here used public.

- Online DDL running underneath a live stream. A reshard and a MoveTables underneath a live stream are both tested and clean — no loss, no duplication, source and target checksums equal afterwards.

MoveTables underneath a live stream is measured (2026-09-10, a 3-shard cluster, 2,000 rows byte-identical end to end). Two things are worth knowing before you run one:

- move_tables_create and move_tables_switch_reads are transparent to a running sluice stream. The write switch is not: it blocks the table on the database it came from, and sluice halts on the next statement with SLUICE-E-TARGET-TABLE-BLOCKED-BY-WORKFLOW (v0.151.0), which names __neki.list_blocked_tables() and __neki.move_tables_status() and both end states. That is the intended outcome — nothing is lost, the persisted position stops before the block, and restarting after you finish or reverse the move replays the gap. Do not treat the halt as a failure to work around.

- A table created with a plain CREATE TABLE is not enrolled in Neki's data topology, so move_tables_create refuses it (NK604, "table doesn't exist in the existing topology") even though the table plainly exists and holds rows. Add it with __neki.set_data_topology() first.

Neki is in platform preview and its surface moves. Treat the behaviours above as measured-on-a-date rather than permanent, and re-check before relying on a limitation staying put.

---
Canonical page: https://sluicesync.com/docs/planetscale-postgres-to-neki/ · Full docs index: https://sluicesync.com/llms.txt
