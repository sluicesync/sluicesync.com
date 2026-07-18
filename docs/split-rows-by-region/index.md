# Split a database by region — move just the rows for one region

> Data-residency splits with a per-table --where predicate: keep US users in a US-region database and move only the EU users' rows into an EU-region database, in one shot or as a continuous filtered sync.

A common data-residency task: one database holds users from every country, and you now want each region's data to live in its own regional database — US users' rows in a US-region database, EU users' rows in an EU-region one. This is the region-move problem with a filter on top: you are not copying the whole database to the new region, only the rows that belong there. sluice does this with a per-table --where predicate (ADR-0173): each filtered table gets a native-SQL boolean scoping it to the target region, and the destination ends up holding only those rows.

This guide walks the concrete case — a region column on each table, splitting EU rows into an EU-region database — as a one-shot filtered migrate (the natural fit: "the EU database should end up with only the EU rows") and as a continuous filtered sync (zero-downtime, and it keeps handling users whose region changes). Read Before you start first — the referential-integrity point is the one that bites.

## Before you start

- You need a column to filter on. The predicate is native source SQL over the source's own columns — region = 'EU', country IN ('DE','FR','IE'), tenant_id = 42. If "which region" is derivable but not stored (e.g. only a free-text address), materialize it first — a generated or backfilled region column on each table you'll filter — so both the copy and (for a sync) the client-side evaluator can read it directly.

- Filter every related table by the same region key — this is the load-bearing rule. A relational schema couples your filters through its foreign keys. If orders references users and you filter users to region = 'EU' but copy orders whole, the EU target gets orders pointing at users it never received — the deferred ADD CONSTRAINT FOREIGN KEY then fails with SQLSTATE 23503 and sluice refuses loudly (SLUICE-E-WHERE-FK-ORPHAN, naming the constraint). The fix is to filter the whole referential closure consistently: put region = 'EU' on users, orders, order_items, and every table that hangs off them, so every kept child's parent is kept too. This requires that an EU order's user is itself EU — i.e. the region assignment is consistent down the FK graph. Where it genuinely isn't (a shared reference table, say), either don't filter that table or accept a degraded constraint with --allow-degraded-fks (Postgres target: the FK is added NOT VALID, still rejecting new orphaning writes; you run VALIDATE CONSTRAINT after reconciling). See the field note on this trap.

- The predicate is source-dialect and not portable. It runs on (or is evaluated against) the source, so use the source engine's SQL. That's fine here — both ends are usually the same engine — but a Postgres-source predicate uses Postgres syntax, a MySQL-source one uses MySQL syntax.

- Provisioning the regional target is exactly the region-move flow. Create the destination database in the EU region and connect to it just as in Move PlanetScale regions → Provision the target (same global connect host, region chosen by credential; ?tls=true; admin role for DDL). Everything there applies; this guide only adds the --where filtering on top.

## Option A — one-shot filtered migrate

The direct answer to "the EU database should end up with only the EU rows." Give each table a --where scoping it to EU; the predicate is pushed down into the source read (SELECT … WHERE <chunk_bounds> AND (region = 'EU')) and evaluated on the source, so only EU rows ever cross the wire — index-aware, no client-side scan. Preview with --dry-run, run it, then verify with the same predicates:

    # preview
    sluice migrate \
        --source-driver postgres --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$EU_TARGET" \
        --where "users=region = 'EU'" \
        --where "orders=region = 'EU'" \
        --where "order_items=region = 'EU'" \
        --dry-run

    # copy only the EU rows
    sluice migrate \
        --source-driver postgres --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$EU_TARGET" \
        --where "users=region = 'EU'" \
        --where "orders=region = 'EU'" \
        --where "order_items=region = 'EU'"

    # verify — the SAME --where, so counts compare matching-source vs target
    sluice verify \
        --source-driver postgres --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$EU_TARGET" \
        --where "users=region = 'EU'" \
        --where "orders=region = 'EU'" \
        --where "order_items=region = 'EU'"

Tables you don't name are copied in full — so name every table that carries region-scoped data; leave a genuinely global reference table (say currencies) unfiltered and it's copied whole, which is usually what you want. A --where that matches zero rows still creates the (empty) table.

Pass verify --where the same predicate, or it will false-report a mismatch. The target holds only the EU subset, so a plain verify would compare the source's full count against the filtered target and (correctly, but unhelpfully) flag source=100000 target=18000. With the matching --where it compares EU-source against target and passes. A plain verify is still a useful sanity check that the subset really is a strict subset.

A filter disables the raw-copy fast path for that table. The byte-level copy path would bypass the WHERE, so sluice falls back to the regular filtered read for any table with a --where. Unfiltered tables in the same run still use the fast path.

On MySQL the flags are identical — only the driver and the predicate dialect change. Use --source-driver mysql / --target-driver mysql for self-hosted MySQL, or --source-driver planetscale / --target-driver planetscale for PlanetScale MySQL (see the region-move guide for the PlanetScale DSN + admin-role setup), and write the predicate in MySQL SQL:

    sluice migrate \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$EU_TARGET" \
        --where "users=region = 'EU'" \
        --where "orders=region = 'EU'" \
        --where "order_items=region = 'EU'"

The predicate is native source SQL either way — a MySQL source takes MySQL syntax, a Postgres source takes Postgres syntax — because it is pushed down to and evaluated by the source. For a MySQL string literal, mind the quoting: single-quote the value and, if your shell needs it, escape as usual.

## Option B — continuous filtered sync (zero-downtime)

If you can't freeze writes, run a sync with the same predicates. The cold-start snapshot pushes the filter down exactly like migrate, then the CDC leg keeps the EU target current — and it handles the case a one-shot copy can't: a user whose region changes. sluice evaluates the predicate on both the before- and after-image of every change and translates it to the correct target operation:

Change on the source · Effect on the EU target ·

A row is inserted/updated in EU, stays EU · applied as-is (INSERT / UPDATE) ·

A user's region flips US → EU (moves in) · INSERT — the after-image, because the EU target never had this row ·

A user's region flips EU → US (moves out) · DELETE by key — else a now-non-EU row would leak into the EU database ·

A row never in EU changes · dropped (never in scope) ·

    sluice sync start --stream-id eu-split \
        --source-driver postgres --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$EU_TARGET" \
        --where "users=region = 'EU'" \
        --where "orders=region = 'EU'" \
        --where "order_items=region = 'EU'"

Watch it catch up and gate cutover on freshness with sync status / sync health, then cutover / sync stop --wait / verify — the same cutover flow as a region move.

Filtered sync requires full row before-images, and refuses loudly without them. The move-in / move-out decision needs the old value of the region column, so each filtered table needs Postgres REPLICA IDENTITY FULL (or MySQL binlog_row_image=FULL). sluice preflights this at sync-start and refuses with SLUICE-E-WHERE-CDC-BEFORE-IMAGE, naming the table and the exact remedy, rather than run on a partial image it can't evaluate. Set it before you start:
    ALTER TABLE users       REPLICA IDENTITY FULL;
    ALTER TABLE orders      REPLICA IDENTITY FULL;
    ALTER TABLE order_items REPLICA IDENTITY FULL;

Continuous sync --where works across the whole matrix as of v0.99.278 — the one thing to set is full before-images. Postgres, self-hosted MySQL, and PlanetScale MySQL / Vitess all support continuous filtered sync:

- String filters evaluate under the column's real collation. A region = 'EU' filter on a case- or accent-insensitive column (MySQL's default) matches eu, Eu, and accented values exactly as the source would — sluice reproduces the source's own = using the source engine's collation comparator, so the client-side CDC classification can't diverge. Pass --where-strict-collation if you'd rather have the strict byte-exact behavior (refuse any non-byte-exact string comparison). Postgres's deterministic default collation was always fine.

- PlanetScale MySQL / Vitess pushes the filter server-side. The predicate becomes a VStream filter rule (select * from t where (…)), so Vitess filters both the cold-start copy and the stream natively with the source's own collation; sluice classifies the row-moves client-side. Validated end-to-end on a real Vitess cluster — move-in → INSERT, move-out → DELETE, no leak.

The one requirement everywhere: each filtered table must deliver full row before-images so the move-in/move-out decision can read the old value — MySQL binlog_row_image=FULL, Postgres REPLICA IDENTITY FULL. A filtered UPDATE/DELETE whose before-image omits a predicate column is refused loudly (SLUICE-E-WHERE-CDC-BEFORE-IMAGE, naming the column), never silently mis-classified. (On sluice < v0.99.278, MySQL string filters and PlanetScale MySQL sync --where were refused — use migrate --where there, or upgrade.)

The CDC filter accepts a restricted grammar — region = 'EU' is squarely inside it. Because there's no arbitrary source-side stream filter, sluice evaluates the predicate over the decoded row and accepts only comparisons it can reproduce faithfully: a column vs a literal (= != <> < <= > >=), IN, IS [NOT] NULL, combined with AND/OR/NOT. Case- and accent-insensitive string equality is supported (evaluated under the column's collation, v0.99.278+); a function call, a subquery, or a timezone-aware temporal comparison is still refused at sync-start (SLUICE-E-WHERE-CDC-UNSUPPORTED-PREDICATE) — a client-side compare could diverge from the source's own. A plain region/country equality or IN list is exactly the supported shape. See why the grammar is restricted.

## The other side of the split

This produces the EU database. To also slim the original down to only US rows, you have two clean options: point a second filtered run at a fresh US-region database (--where "users=region = 'US'", and so on) and cut both over together; or, if the original database stays in the US region and you only need to remove the migrated EU rows, delete them there once the EU target is verified and live. Keep the EU sync tailing until you've cut EU traffic over, so no EU write is lost in the gap.

Same predicate, both directions. The split is symmetric: the EU run filters region = 'EU', the US run filters region = 'US' (or region != 'EU' to catch everything else). Run them as two independent migrates/syncs, each with its own --stream-id and target — like moving several databases, but scoped by row instead of by keyspace.

## Next steps

- Move PlanetScale regions — the un-filtered region move; its "Before you start" and "Provision the target" apply here verbatim.

- Filtered / subset migration (operator guide) — the full --where reference: push-down, the FK-orphan caveat, and the CDC row-move semantics in depth.

- You can't filter a parent without orphaning its children, the row-move before-image trap, and the predicate you evaluate twice — the three field notes behind this feature.

- Command reference and error codes — --where, --allow-degraded-fks, and the three SLUICE-E-WHERE-* codes.

---
Canonical page: https://sluicesync.com/docs/split-rows-by-region/ · Full docs index: https://sluicesync.com/llms.txt
