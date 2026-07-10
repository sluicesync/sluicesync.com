# Import SQLite or Cloudflare D1

> Move a SQLite file, a wrangler D1 export, or a live Cloudflare D1 into Postgres or MySQL — losslessly.

sluice imports SQLite and Cloudflare D1 into Postgres or MySQL through the same migrate pipeline as everything else — parallel copy, cross-engine type translation, deferred indexes, --dry-run, verify — with no pgloader or external tool. Reach for this when you're graduating a SQLite/D1 app onto a server database, or pulling D1 data into an analytics warehouse. There are three source shapes; pick by what you have.

## A local SQLite file

Point --source-driver sqlite at the file (a bare path, a file: URI, or a sqlite:// URL — opened read-only) and migrate as usual:

    sluice migrate \
        --source-driver sqlite   --source ./app.db \
        --target-driver postgres --target 'postgres://user:pass@host:5432/db?sslmode=require'

Large tables parallel-copy automatically (PK-range / keyset chunks, tuned by --bulk-parallelism), the same as any other source. A .db file is read byte-exact — sluice reads the int64 straight from the file.

## A wrangler D1 export (.sql dump)

wrangler d1 export emits a .sql text dump. sluice ingests one directly — it sniffs the file's header, materializes the dump in-process (no sqlite3 CLI), and auto-skips D1's internal _cf_* tables. So the import is two commands:

    wrangler d1 export <db> --remote --output dump.sql
    sluice migrate --source-driver sqlite --source dump.sql \
        --target-driver postgres --target '<pg-dsn>'

The export rounds big integers. Both of D1's default extraction paths — the wrangler d1 export dump and the bare query API — silently lose integers larger than 253 (≈ 9 ×1015): D1 serializes them through a JavaScript double before sluice ever sees them. For Snowflake-style IDs (Discord/Twitter 64-bit IDs), nanosecond timestamps, or large counters, use the live query-API reader below — it's the only lossless path. For a D1 database without integers that large (the common case), the export path is exact and simple.

## A live Cloudflare D1 (lossless)

--source-driver d1 reads a live D1 over its HTTP query API and is the lossless import. It projects every column through typeof() + CAST(… AS TEXT) / hex(), so integers above 253 round-trip exactly, INTEGER is distinguished from REAL, and BLOBs decode from hex. Reads don't take D1 offline. (Why the text projection instead of the obvious JSON number? See the field note on 253 as a database boundary — wrangler d1 export rounds big integers through float64 before any database sees them.) The API token is read from the environment only — never a flag, never logged:

    export CLOUDFLARE_API_TOKEN=...        # required
    export CLOUDFLARE_ACCOUNT_ID=...       # optional if the account is in the DSN

    sluice migrate \
        --source-driver d1       --source 'd1://<account_id>/<database_id>' \
        --target-driver postgres --target '<pg-dsn>'

DSN forms are d1://<account_id>/<database_id> or the short d1://<database_id> (account from CLOUDFLARE_ACCOUNT_ID). A missing token, account, or database id is refused loudly at startup, before any request.

## Dates, times, and booleans

SQLite and D1 have no native temporal or boolean storage. sluice maps a column whose declared type names one (DATE / DATETIME / TIMESTAMP / TIME, BOOL / BOOLEAN) to the right target type, and you tell it how the values are encoded with --sqlite-date-encoding:

Encoding · Temporal values stored as ·

iso (default) · ISO-8601 TEXT, e.g. '2024-01-02 03:04:05' ·

unixepoch · INTEGER unix seconds ·

unixmillis · INTEGER/REAL unix milliseconds ·

julian · REAL/INTEGER Julian day ·

A value whose storage class doesn't match the chosen encoding — or ISO text matching no layout, or a non-truthy boolean — is refused loudly, naming the row, never a silently-wrong date. Carry a genuine outlier raw with --type-override <col>=text. Preview the resolved types first with schema preview.

Column DEFAULT expressions are carried too: a SQLite datetime('now') / CURRENT_TIMESTAMP default becomes the target's CURRENT_TIMESTAMP (date('now')→CURRENT_DATE, time('now')→CURRENT_TIME). A non-portable default expression is dropped with a loud WARN rather than emitted as an expression the target can't evaluate — the column keeps its type, just without the default.

## Richer target types with --infer-types

Because SQLite/D1 storage is dynamically typed, the safe default maps a source conservatively and losslessly — INTEGER→bigint, TEXT→text. That never fails and never loses data, but a clean dataset often wants native Postgres types. --infer-types (opt-in, SQLite/D1 source only) promotes INTEGER→boolean, ISO-8601 TEXT→timestamptz/timestamp, JSON TEXT→jsonb, and UUID TEXT→uuid — but only after validating the actual data:

    sluice migrate \
        --source-driver d1       --source 'd1://<account_id>/<database_id>' \
        --target-driver postgres --target '<pg-dsn>' \
        --infer-types

Candidates are picked by name hint (is_*/*_flag; *_at/created/updated; *_json/metadata/payload; *_id/*_uuid) and then each is gated by one aggregate pushed down to the source — a boolean column promotes only if no value is outside (0,1), a UUID column only if every value matches an anchored hex-UUID GLOB, and so on. A *_id holding cus_abc123 fails UUID validation and stays text — the exact case that's a total-data-loss failure under name-only type guessing. Temporal handling is tz-aware (timestamptz only when every value carries an offset, else naive timestamp); a mixed offset/naive column or a sub-microsecond fraction is kept text rather than risk a silent UTC-shift or rounding. A structured report names every promotion (with the validated row count) and every column kept safe. An explicit --type-override always wins.

On a live D1, inference stages locally first (automatic). Cloudflare D1's query API rejects the rich-type validation patterns (its GLOB complexity limit), so against --source-driver d1 sluice first replicates the database into a byte-faithful local SQLite file and validates there — engaged automatically when you pass --infer-types (v0.99.167). The staged copy is lossless (exact storage classes, integers above 253 included — unlike wrangler d1 export), so inference sees the original types and decides identically. Pass --stage-local to stage even without inference (a faster local bulk read), or --no-stage-local to force the direct path. A plain D1 migrate without --infer-types streams directly as before. (Not needed for a local SQLite file — it has no such limit.) The war story behind this — a UUID GLOB that passed every local test and died on live D1 with code 7500 — is the field note Cloudflare D1 is not your local SQLite.

## ORM bookkeeping tables

An app's ORM keeps its migration state in a bookkeeping table — Rails schema_migrations, Prisma _prisma_migrations, Drizzle __drizzle_migrations, Laravel migrations, Flyway, Goose, and more. That state describes the source engine's schema history and is meaningless — sometimes actively misleading — on a different target engine. On a cross-engine migrate (e.g. D1→Postgres) sluice skips these by default, announcing each skip by name so nothing vanishes silently. Copy them anyway with --include-orm-tables; on a same-engine run they're kept by default (the history is still valid) unless you pass --skip-orm-tables. Recognition is by distinctive name plus a column-shape guard for the generic names (migrations, schema_migrations), so an app table that merely shares a name isn't skipped by accident.

## SQLite as a target

SQLite is also a migrate target (--target-driver sqlite) — emit a .db from any source (decimals are stored byte-exact as TEXT affinity, not lossy REAL — see the field note SQLite's DECIMAL is a suggestion for why), e.g. to then run wrangler d1 import. D1 itself is not a write target; produce a SQLite .db and import it with wrangler.

    sluice migrate \
        --source-driver postgres --source '<pg-dsn>' \
        --target-driver sqlite   --target ./out.db

## Continuous sync (trigger-CDC)

The base sqlite and d1 engines are migrate-only — SQLite has no logical change stream (its WAL is a physical page-log). For continuous sync, sluice captures changes with triggers, via the sqlite-trigger (local file) and d1-trigger (live D1) engines. The lifecycle is explicit — setup → sync → teardown:

    # 1. install per-table capture triggers + the change-log (each table needs a PRIMARY KEY)
    sluice trigger setup --source-driver sqlite-trigger --dsn ./app.db --tables=users,orders

    # 2. cold-start snapshot, then stream changes continuously
    sluice sync start --source-driver sqlite-trigger --source ./app.db \
        --target-driver postgres --target 'postgres://user:pass@host:5432/db?sslmode=require'

    # 3. remove every trigger + the change-log when done (--keep-data to retain it)
    sluice trigger teardown --source-driver sqlite-trigger --dsn ./app.db --yes

Big integers and BLOBs round-trip exactly through capture and CDC (the trigger encodes each column as a (typeof, text/hex) pair). Enable PRAGMA journal_mode=WAL on a local source so the poller never blocks the app's writes. Because SQLite has no DDL triggers, a source ALTER TABLE isn't auto-captured — re-run trigger setup after a schema change; sync start refuses loudly on schema drift rather than silently dropping a new column. The live d1-trigger path is identical over the HTTP query API (the token is a D1:Edit token); mind D1's per-write billing and the change-log growth — run sluice trigger prune periodically. Full detail: the SQLite/D1 operator doc.

---
Canonical page: https://sluicesync.com/docs/import-sqlite-d1/ · Full docs index: https://sluicesync.com/llms.txt
