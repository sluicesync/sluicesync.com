# Migrate many databases or schemas at once

> Fan a whole MySQL server or a multi-schema Postgres source out to same-named target namespaces in one run.

By default migrate and sync start move the one database (MySQL) or schema (Postgres) named in the source DSN. The multi-namespace flags move all of a server's databases, or all of a Postgres source's schemas, in a single run — snapshot and CDC both — fanning each source namespace out to a same-named target namespace. Reach for this with a multi-tenant MySQL server (one database per tenant), a Postgres database holding several application schemas, or any "migrate the whole server" job.

The unifying idea is that a MySQL database is the rough equivalent of a Postgres schema. So there's one internal routing with two spellings: use the --*-database form on a MySQL source and the --*-schema form on a Postgres source. They're synonyms — mixing both spellings in one invocation is a loud error.

Flag · Meaning ·

--all-databases / --all-schemas · Every non-system namespace on the source. ·

--include-database / --include-schema · Only these (comma-separated, repeatable; glob patterns allowed, e.g. app_*). ·

--exclude-database / --exclude-schema · Every non-system namespace except these. ·

Within a form, include / exclude / all are mutually exclusive. System namespaces are always excluded (information_schema, performance_schema, mysql, sys on MySQL; pg_catalog, information_schema, pg_toast, pg_temp* on Postgres). When any namespace-scope flag is set, the source DSN's database/schema is optional — sluice connects to the server (or, on PG, to the database) rather than a single namespace.

## Postgres source: every schema in one run

A Postgres database holding sales, billing, inventory → one Postgres target, each schema recreated (auto-created if absent) under its own name:

    sluice migrate \
        --source-driver postgres --source 'postgres://user:pw@src/appdb?sslmode=require' \
        --target-driver postgres --target 'postgres://user:pw@dst/appdb?sslmode=require' \
        --all-schemas

Continuous sync is identical — just sync start with a --stream-id. Scope with globs, or take everything except a couple:

    # only the app_* schemas (plus public)
    sluice migrate ... --include-schema 'app_*,public'

    # everything except the staging schemas
    sluice migrate ... --exclude-schema 'scratch,tmp_load'

## MySQL server: every database → Postgres in one run

A MySQL server hosting one database per tenant/service → a single Postgres target, each MySQL database recreated as a same-named PG schema (auto-created). Note the source DSN has no database after the / — with --all-databases it's a server connection:

    sluice migrate \
        --source-driver mysql    --source 'root:pw@tcp(src:3306)/' \
        --target-driver postgres --target 'postgres://user:pw@dst/warehouse?sslmode=require' \
        --all-databases

MySQL shop / crm / analytics land as PG schemas shop / crm / analytics under warehouse. When the target is also MySQL, each source database is recreated via CREATE DATABASE IF NOT EXISTS — same names, no manual pre-creation.

## Fan-IN: many sources → one target namespace

The reverse shape — several independent source databases (e.g. per-microservice MySQL databases) consolidated into one Postgres analytics schema. This isn't a --all-* fan-out; it's N separate runs, each pinned to the same target namespace with --target-schema (Postgres-target-only; it prefixes every emitted object and auto-creates the schema):

    # service A → warehouse.analytics
    sluice migrate --source-driver mysql --source 'root:pw@tcp(svc-a:3306)/orders' \
        --target-driver postgres --target 'postgres://user:pw@dst/warehouse?sslmode=require' \
        --target-schema analytics

    # service B → the SAME warehouse.analytics (run separately)
    sluice migrate --source-driver mysql --source 'root:pw@tcp(svc-b:3306)/users' \
        --target-driver postgres --target 'postgres://user:pw@dst/warehouse?sslmode=require' \
        --target-schema analytics

To avoid table-name collisions across services landing in one schema, pair --target-schema with --inject-shard-column NAME=VALUE, which adds a per-source discriminator and a composite PK. See the migrate reference.

## Rename a namespace on the way

By default every source namespace lands in a same-named target. To route one to a differently-named target — consolidating legacy_app into app, or namespacing each tenant under a prefix — pass --map-database SRC=DST (MySQL source) or --map-schema SRC=DST (Postgres source), repeatable, for both snapshot and CDC:

    # MySQL databases shop / crm → PG schemas storefront / sales (analytics keeps its name)
    sluice migrate \
        --source-driver mysql    --source 'root:pw@tcp(src:3306)/' \
        --target-driver postgres --target 'postgres://user:pw@dst/warehouse?sslmode=require' \
        --all-databases \
        --map-database shop=storefront \
        --map-database crm=sales

The spelling rule matches the fan-out flags — --map-database on a MySQL source, --map-schema on a Postgres source; mixing both in one run is a loud error. The rename is purely a target-side routing: source-keyed --redact and --type-override still match on the original source name, so a remap never quietly disables a redaction rule.

## The documented edges

- Cross-database / cross-schema foreign keys are refused loudly. A fan-out validates that FK referents are inside the selected set; an out-of-scope FK fails loudly at the deferred FK pass (after the copy), never silently dropped.

- Separate Postgres databases are one run each. A PG connection is scoped to a single database, so --all-schemas covers every schema within the connected database; moving N separate PG databases is N runs (one --source DSN each).

- PlanetScale-MySQL is a single keyspace and isn't a multi-namespace target — fanning several source databases into one PS-MySQL branch would collapse and collide. PlanetScale-Postgres behaves like regular Postgres and takes --all-schemas fine.

- Default routing is same-name; rename with --map-database / --map-schema. Each source namespace lands in a target namespace of the same name unless you remap it (see below). For the fan-IN shape use --target-schema.

---
Canonical page: https://sluicesync.com/docs/multi-database/ · Full docs index: https://sluicesync.com/llms.txt
