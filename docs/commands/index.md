# Command reference

> Every sluice command, its purpose, the flags that matter most, and worked examples.

The general shape is sluice <command> [flags]. Run sluice <command> --help for the
complete flag list — the tables below cover the flags you'll reach for most.

Every command accepts the global flags, described in full on the
configuration page: --config/-c and --log-level/-l;
--log-format (text or json — one object per line, for Loki / Datadog / CloudWatch ingestion of a long-running sync);
--no-progress (force plain structured-log output even at an interactive terminal, disabling the pretty progress view);
--max-memory (soft ceiling on the Go heap, e.g. 2GiB, to bound RSS);
--stage-dir (where the large scratch files land);
--pprof-listen (bind net/http/pprof at an address for the life of the subcommand — the tool for diagnosing a silent stall: fetch /debug/pprof/goroutine?debug=2 for every goroutine's stack);
the legacy-MySQL controls --mysql-sql-mode and --zero-date;
the SQLite/D1 --sqlite-date-encoding;
the flat-file declarations --csv-header / --csv-no-header / --csv-null / --csv-delimiter;
--version/-V; and --skill (print an installable agent skill file and exit &mdash; see agent-guide below).

Parallelism flags mean different things per command. The same flag name maps to a different axis depending on the verb — read this row before tuning.

Flag · What it controls ·

--table-parallelism · Tables processed concurrently. On migrate = tables copied at once; on backup = tables read at once (the read-side analog of pg_dump -j); on restore = tables bulk-applied at once (pg_restore -j). On sync start it governs the PG-source cold-start sweep only. ·

--bulk-parallelism · Within-table concurrency (a single table's chunks at once). On migrate / restore it multiplies with --table-parallelism, the product bounded by the target connection budget. ·

--apply-concurrency · CDC apply lane count (PK-hash, exactly-once). Used by sync start, sync from-backup, and the incremental-replay leg of restore. ·

--copy-fanout-degree · VStream/CDC cold-start write fan-out (PlanetScale-MySQL target) on sync start. ·

On sync start, --table-parallelism / --bulk-parallelism are PG-source-only — they're inert on MySQL / VStream sources. For a MySQL or Vitess/PlanetScale source's cold-copy concurrency, use the source-DSN knobs copy_table_parallelism (native MySQL) / vstream_copy_table_parallelism (VStream) for read concurrency, and --copy-fanout-degree for write fan-out.

## engines

### sluice engines
List the database engines built into this binary and their bulk-load / CDC capabilities.

    sluice engines

  14 engines are registered today: mysql (binlog CDC), planetscale and self-hosted vitess (both VStream CDC), mariadb (a MySQL-family flavor — bulk migrate source and target, backup/restore/verify, and continuous CDC sync since v0.99.271: sluice parses MariaDB's domain-based GTIDs and resumes off them; native uuid/inet columns are the one CDC-refused shape, steered to bulk migrate), postgres (logical-replication CDC), sqlite and d1 (migrate sources — sqlite is also a target — no CDC), the trigger-CDC engines postgres-trigger (slot-less Postgres), sqlite-trigger (local SQLite file), and d1-trigger (live Cloudflare D1), and the flat-file migrate sources csv, tsv, ndjson (ADR-0163) and mydumper (a mydumper / pscale database dump directory, ADR-0161). The vitess flavor shares the PlanetScale engine code with a self-hosted-vtgate capability set, and warm-resumes since v0.99.44.

Engine · Role · Notes ·

mysql · CDC source · migrate source & target · Vanilla MySQL: binlog (row-based) CDC and bulk LOAD DATA cold-copy. DSN user:pass@tcp(host:3306)/db. ·

planetscale · CDC source · migrate source & target · PlanetScale MySQL flavor: VStream (gRPC) CDC and batched-insert cold-copy — Vitess blocks LOAD DATA, so use this, not mysql, against a *.psdb.cloud host. Auto-discovers the keyspace shard layout. ·

vitess · CDC source · migrate source & target · Self-hosted Vitess/vtgate: shares the planetscale engine code (VStream CDC) with a self-hosted-vtgate capability set; warm-resumes since v0.99.44. ·

mariadb · CDC source · migrate source & target · MySQL-family flavor: binlog/domain-GTID CDC (parses MariaDB domain GTIDs like 0-100-38 and resumes off them, v0.99.271/ADR-0170), bulk migrate source & target, and backup/restore/verify. Native uuid/inet6/inet4 columns decode faithfully through CDC as of v0.99.272/ADR-0171; SHOW BINLOG STATUS / SHOW BINARY LOG STATUS / SHOW MASTER STATUS fallback covers 10.11→13.1. ·

postgres · CDC source · migrate source & target · Logical-replication (replication-slot) CDC and COPY cold-copy. Roles, extensions, and slot lifecycle are surfaced explicitly, never silently auto-handled. ·

sqlite · migrate source (file or .sql dump) and target · Pure-Go modernc.org/sqlite, no CGO. Imports a binary .db or an auto-detected wrangler d1 export .sql dump into Postgres / MySQL; as a target emits a .db (decimals byte-exact as TEXT). Migrate only (no CDC). ·

d1 · migrate source (live, lossless) · Reads a live Cloudflare D1 over its HTTP query API (token via CLOUDFLARE_API_TOKEN); per-column typeof() + CAST(… AS TEXT) / hex() projection makes integers above 253 and BLOBs round-trip exactly, and reads don't take D1 offline (ADR-0132). ·

postgres-trigger · CDC source · Slot-less Postgres trigger-CDC: per-table AFTER triggers + a change-log watermark, for managed Postgres where a logical-replication slot isn't available. ·

sqlite-trigger · CDC source · Trigger-based continuous sync from a local SQLite file: per-table AFTER triggers + a sluice_change_log watermark for exactly-once resume (ADR-0135). ·

d1-trigger · CDC source · The same trigger-CDC design over a live D1's HTTP query API (ADR-0136). ·

csv / tsv · migrate source (file) · RFC 4180 delimited files (ADR-0163), staged into a temp SQLite database with every value byte-exact TEXT (007.1500 stays 007.1500; integers above 253 stay exact) and read through the validated SQLite surface; --infer-types auto-engages to recover rich target types. File conventions are declared, never sniffed — see the flat-file note below. tsv is the same engine with the delimiter fixed to TAB. Migrate only (no CDC). ·

ndjson · migrate source (file) · One JSON object per line (ADR-0163). Numbers land as their raw source text — never through a float64 — so integers above 253 and arbitrary-precision decimals stay byte-exact; nested objects/arrays land as raw JSON text; a duplicate key within an object or a top-level JSON array refuses loudly (the message carries the jq -c '.[]' conversion). Migrate only (no CDC). ·

mydumper · migrate source (directory) · A mydumper or pscale database dump directory (ADR-0161): metadata + per-table -schema.sql + extended-INSERT data chunks (plain, gzip, or zstd). Values decode through the live MySQL engine's own decoder — byte-identical to a live read; single-precision FLOAT display-rounding baked into the dump file itself is WARNed per table. Migrate only (no CDC). ·

  Flat-file imports: conventions are declared, never sniffed (ADR-0163). RFC 4180 encodes neither NULL nor header presence — both are producer conventions, and guessing either is the #1 CSV silent-loss class (a wrong header guess eats a data row or turns data into column names; a wrong NULL guess silently turns empty strings into NULLs or vice versa). So the csv/tsv drivers require the conventions on the command line:

Flag · Purpose ·

--csv-header / --csv-no-header · One is required. Declare whether the first record carries the column names (--csv-no-header names columns col1..colN in file order). Opening a csv/tsv source without either is refused loudly (SLUICE-E-CSV-HEADER-UNDECLARED). Mutually exclusive. ·

--csv-null · The UNQUOTED field text that means SQL NULL: --csv-null='' (the PostgreSQL COPY CSV convention — an unquoted empty field is NULL), --csv-null='\N', or --csv-null=NULL. A QUOTED field is always data ("NULL" is the four-character string; "" is the empty string). Without this flag a file containing an unquoted empty field is refused loudly (SLUICE-E-CSV-NULL-AMBIGUOUS) — a file with no empty unquoted fields needs no flag. ·

--csv-delimiter · csv driver only: the field delimiter — a single ASCII character, or \t/tab for TAB (default ,). The tsv driver is fixed to TAB. ·

  Plain mysqldump / pg_dump .sql dumps and pg_dump -Fc archives are deliberately not parsed by any driver — they refuse with SLUICE-E-SOURCE-FOREIGN-DUMP and the message carries the exact scratch-server-replay recipe; a recognisable format handed to the wrong driver (a mydumper directory to csv, a .tsv through the comma lexer, a gzip'd or UTF-16 file) refuses with SLUICE-E-SOURCE-WRONG-DRIVER naming the right driver or preparation step.

  WAN-fast MySQL CDC apply (ADR-0139/0140). Against a MySQL / PlanetScale-MySQL target, consecutive same-shape INSERTs fold into one multi-row INSERT … ON DUPLICATE KEY UPDATE, UPDATEs apply as that same keyed upsert, and DELETEs coalesce into one DELETE … WHERE pk IN (…) — turning N round trips into one so high-latency / cross-region apply keeps up. A rate-limited INFO line (rows_per_stmt) reports the coalescing ratio so you can see whether it's helping.

  Rich types over continuous CDC. Continuous sync now carries the types that earlier only cold-started: PostgreSQL arrays (int4[], text[], numeric[], …, multi-dimensional preserved), MySQL ENUM and SET, MySQL→PG and PG→PG ENUM, and PostGIS geometry (every subtype/dimension, SRID preserved) — all over the CDC apply path, in both source directions (v0.99.50–v0.99.60). Arrays of geometry (geometry[]) and arrays of enum (enum[]) remain loudly refused over CDC — no silent loss. PostGIS geography is carried first-class since v0.120.0 — registered on both spatial type OIDs across every write path, byte-exact with the SRID held by the per-row guard; toward a MySQL-family target a 2D geography lands as planar geometry (bytes + SRID exact) with the geodesic→planar semantic flatten surfaced as a schema preview note since v0.124.0, and Z/M-dimensional spatial columns toward MySQL refuse at preflight (MySQL 8 has no Z/M geometry).

## agent-guide

### sluice agent-guide
Print sluice's AI-agent operating guide (the embedded AGENTS.md) &mdash; the command taxonomy (read-only vs state-changing vs production-mutating vs destructive), the standard workflow, and the flags that require explicit human approval. Built for driving sluice from an agent with no repo or docs-site access.

    sluice agent-guide                  # the bare guide
    sluice --skill > sluice.skill.md    # an installable agent skill file

  sluice --skill (a global flag) and sluice agent-guide --skill emit the guide as an installable agent skill file: YAML frontmatter (name + description, for trigger-based loading) followed by the full guide &mdash; write it into a skills directory so a skill-aware assistant cold-starts on how to drive sluice, without the repo or the docs site. See the agent skills guide for the task-scoped playbooks sluice ships alongside it.

## migrate

### sluice migrate
Run a one-time schema + data migration: translate the schema, create tables, bulk-copy rows, then build indexes and constraints.

Flag · Purpose ·

--source-driver / --source · Source engine name and DSN (or SLUICE_SOURCE). ·

--target-driver / --target · Target engine name and DSN (or SLUICE_TARGET). ·

--dry-run, -n · Print the plan; don't touch the target. ·

--include-table / --exclude-table · Glob-aware table filters (mutually exclusive). Scope the bulk copy — including the PlanetScale (VStream) snapshot — not just the write path. ·

--include-database / --exclude-database / --all-databases · Multi-database fan-out (ADR-0074, MySQL source): migrate several source databases in one run, each to a same-named target namespace. Glob-aware; system databases (information_schema, mysql, …) are always excluded. When any database-scope flag is set the source DSN's database is optional (it's a server connection). ·

--include-schema / --exclude-schema / --all-schemas · Multi-schema fan-out (ADR-0075, Postgres source): the PG-source synonyms of the -database family. System schemas (pg_catalog, information_schema, …) are always excluded. MySQL source uses the -database spelling, PG source uses -schema; supplying both spellings in one invocation is a hard error. Each selected schema goes through the same partitioned-table and inheritance-parent preflights as a single-schema run — --exclude-table=<parent> clears the door — and since v0.138.0 a multi-schema sync start cold start runs them too (through v0.137.4 it ran neither, so sync start --include-schema copied a partitioned parent flattened alongside its leaves, duplicating the rows, and exited 0 where migrate --include-schema refused). Since v0.139.0 a multi-schema sync start runs a third preflight of its own — the source-side replica-identity refusal, which migrate has no counterpart to because only CDC needs a row identity. ·

--map-database / --map-schema · SRC=DST — rename a namespace on the way (ADR-0142, repeatable). Without it a fan-out lands each source namespace in a same-named target; this routes SRC to a differently-named DST (snapshot and CDC). --map-database for a MySQL source, --map-schema for a Postgres source (same rule as the fan-out spellings). The rename is engine-side only — source-keyed --redact / --type-override still match on the original name. ·

--allow-degraded-fks · PG-target only: tolerate a dirty FK source — when ADD CONSTRAINT FOREIGN KEY fails on orphan rows (SQLSTATE 23503), retry as NOT VALID and surface the degraded constraint at the end (run VALIDATE CONSTRAINT after fixing the orphans). Default off (loud failure on a dirty source). MySQL has no per-constraint NOT VALID and refuses loudly if this is set against a MySQL target. ·

--resume, -r · Resume a failed migration from per-table checkpoints on the target. ·

--bulk-parallelism · Parallel reader/writer pairs per large table (0 = auto, 1 = off). Since v0.99.64 (ADR-0096) within-table chunking covers single non-integer PKs (UUID/string/binary/decimal/temporal) and all-orderable composite PKs via sampled-keyset chunking — not just single-integer PKs. Tables with no usable PK (or a non-orderable PK column like JSON/array/geometry) still take the single-reader path. ·

--bulk-parallel-min-rows · Row-count threshold below which a table is copied with a single reader/writer pair regardless of --bulk-parallelism. 0 = auto (base 80000, dialled down on many-table schemas). ·

--table-parallelism · Tables copied concurrently (0 = auto: 4, 1 = off). Multiplies with --bulk-parallelism; the product is bounded by the target connection budget. ·

--max-target-connections · Connection budget on the target the parallelism product must fit inside. ·

--index-build-parallelism · Postgres-only: deferred indexes built concurrently after the bulk copy. ·

--type-override · TABLE.COLUMN=TYPE — force a target column type (repeatable). ·

--redact · Redact a PII column, e.g. users.email=hash:sha256 (repeatable). The selector is [schema.]table.column: the bare form matches the table in every namespace the run reads; a schema-qualified rule matches only a table stamped with that namespace — and a single-database MySQL run stamps none, so a qualified rule there is refused at preflight since v0.138.0 (through v0.137.4 it passed, and the column shipped in clear through bulk copy and backup at exit 0 while CDC rows were redacted). Use the bare form, or --include-database=<db> so tables are namespaced. See Preflight refusals. ·

--where · TABLE=<predicate> — copy only the rows of TABLE matching a native source-SQL boolean predicate (repeatable, source-keyed; ADR-0173). Pushed into the source read (SELECT … WHERE (<predicate>)), evaluated on the source. Use for per-tenant/region carve-outs or GDPR-scoped extracts. Filtering a parent table orphans its children (SLUICE-E-WHERE-FK-ORPHAN) — filter consistently or pass --allow-degraded-fks. A key naming no table refuses (SLUICE-E-WHERE-UNKNOWN-TABLE). Run verify with the SAME --where. See Split rows by region. On sync, the same flag drives continuous filtered replication (and sync adds --where-strict-collation to force byte-exact string matching). ·

--allow-degraded-fks · Postgres target: when a filtered copy orphans a foreign key (SQLSTATE 23503), attach it NOT VALID instead of refusing — the FK still rejects new orphaning writes; run VALIDATE CONSTRAINT after reconciling. Refused on a MySQL target (no per-constraint NOT VALID). ·

--infer-types · SQLite / D1 source only (ADR-0144): opt-in, data-validated promotion of conservatively-typed columns to native target types — INTEGER→boolean, ISO-8601 TEXT→timestamptz/timestamp, JSON TEXT→jsonb, UUID TEXT→uuid — but only after an exhaustive aggregate over the actual data confirms every value qualifies; otherwise the column keeps its safe type. Mixed-offset / sub-µs temporal columns and non-UUID *_id values stay text, never silently coerced. An explicit --type-override always wins. Off by default. Against a live D1, auto-engages --stage-local (below). ·

--stage-local / --no-stage-local · Cloudflare D1 source only (ADR-0145, v0.99.167): first replicate the live D1 into a byte-faithful local SQLite file (verbatim DDL + exact storage classes, integers above 253 included — lossless, unlike wrangler d1 export), then migrate from that file. Sidesteps D1's HTTP query limits (the per-query CPU ceiling and the GLOB pattern-complexity limit that block --infer-types on a live D1). Auto-engaged by --infer-types against a D1 source; set --stage-local explicitly to stage without inference, or --no-stage-local to force the direct path. The staged file is created in the system temp dir (override with the global --stage-dir, v0.99.259) and removed when the migrate finishes. Mutually exclusive. ·

--include-orm-tables / --skip-orm-tables · ORM bookkeeping tables (Rails schema_migrations, Prisma _prisma_migrations, Drizzle __drizzle_*, Laravel migrations, Flyway, Goose, …) carry the source engine's migration state, which is meaningless on a different target engine. On a cross-engine migrate they're skipped by default, each skip announced by name; --include-orm-tables copies them anyway. A same-engine run keeps them (the history is still valid) unless you pass --skip-orm-tables. The two flags are mutually exclusive. ·

--target-schema · Postgres-only: land tables under a named schema namespace. ·

--inject-shard-column · NAME=VALUE — ADR-0048 Shape A: inject a sluice-managed discriminator column on a consolidated target so per-shard rows from a multi-shard Vitess source land disjoint via a composite PK. Each per-shard run passes a distinct VALUE. ·

--allow-cross-shard-merge · Opt out of the cross-shard-collision preflight (Bug 152). Off by default the guard is active: a multi-shard Vitess/PlanetScale source without --inject-shard-column refuses to merge into a single PK/UNIQUE target. Pass this only when the key is globally unique across shards. ·

--reset-target-data · Destructive recovery: drop source-schema tables on the target, then cold-start. Prompts (type reset) unless --yes. Mutually exclusive with --resume. ·

--source-tls-ca / --target-tls-ca · Path to a PEM CA certificate for CA-pinned verify-ca TLS to a MySQL source / target (ADR-0158): trust this CA, verify the server certificate chains to it, skip the hostname check — the strongest mode that works against MySQL's SAN-less auto-generated certs. On the source it covers both the data connection and the binlog/CDC stream. Refused if the DSN already sets tls=; refused on non-MySQL endpoints (Postgres uses sslrootcert=/path/ca.pem in the DSN instead). Also accepted by sync start, verify, backup, and restore (target side). ·

--planetscale-org · On migrate this arms the automatic deploy-request index-build fallback on a planetscale target (ADR-0148) — on restore and sync start the same flag serves both this fallback and the telemetry opt-in, each arming on its own token pair (v0.99.259). When a deferred post-copy ADD INDEX hits PlanetScale's statement-time wall (errno 3024) or the safe-migrations direct-DDL block (errno 1105), sluice builds it via a dev branch + deploy request instead. Requires safe migrations ON (sluice never toggles it) plus a service token (PLANETSCALE_SERVICE_TOKEN_ID / PLANETSCALE_SERVICE_TOKEN env). Control-plane only, distinct from the data-plane --target DSN; ignored on non-planetscale targets; off when unset (the migrate is unchanged). ·

--planetscale-database / --planetscale-branch · Database name (defaults to the --target DSN's database) and production branch (default main) for the ADR-0148 index-build fallback. Only consulted when --planetscale-org is set. ·

--csv-null / --csv-header / --csv-no-header / --csv-delimiter · Flat-file source declarations (ADR-0163) for --source-driver csv|tsv — see the flat-file note under engines. Refused (never silently ignored) when the source driver is not a flat-file engine. ·

--include-view / --exclude-view / --skip-views · View filters, the sibling of the -table family (comma-separated, repeatable, glob-aware; include and exclude are mutually exclusive). --skip-views drops view processing entirely — the flag for schemas whose views are managed out-of-band by Atlas / sqitch / Liquibase. All three are also accepted by sync start (cold-start schema-apply only — CDC never replicates views) and by schema preview / diff. ·

--enable-pg-extension · Opt a Postgres extension type into passthrough (repeatable; ADR-0032). Recognised: vector (pgvector), pg_trgm, hstore, citext. Same-engine PG → PG preserves the source-native shape; on a MySQL target only hstore (→ JSON) and citext (→ VARCHAR with a case-insensitive collation) have built-in translators — the rest keep the loud-failure default. Each named extension must be installed on both ends: sluice preflights pg_extension before any data moves. Also on sync start and schema preview / diff. ·

--keyset-source · Required when any --redact rule uses hash:hmac-sha256 or tokenize:dict (PII Phase 4, ADR-0041). Forms: file:PATH (keyset YAML on disk), env:VARNAME, or db:DSN (a sluice_keysets table on the named DSN — the form that keeps surrogates stable across streams). Resolved once at startup: rotating a keyset takes effect on the next process start, never hot. Also on sync start, backup full, and schema preview. ·

--migration-id · Stable identifier this run's progress is keyed under in sluice_migrate_state — the key --resume looks up. Auto-generated from source/target host info when unset, so set it explicitly if the DSNs may change between the run and its resume. ·

--bulk-batch-size · Rows per committed batch on the resume copy path (default 5000). Each batch commits with an updated cursor in sluice_migrate_state.table_progress, so a crash mid-table resumes without re-copying the prefix — lower values shorten the replay window, higher ones amortise the per-transaction cost. Only consulted on resume: a cold-start migrate takes the faster plain-INSERT / COPY path. Tables with no PK fall back to truncate-and-redo regardless. On sync start the same flag sizes the ADR-0079 fast cold-start's within-table cursor path (PG source; inert on MySQL / VStream, whose cold-copy is engine-internal). ·

--upfront-indexes · Build every secondary index before the bulk copy — right after the bare tables are created — instead of the default deferred post-copy build, so the load maintains the indexes as it writes. Trades a slower copy for no post-copy ADD INDEX; the motivating case is a large PlanetScale-MySQL target, where a deferred ALTER … ADD INDEX on a multi-GB table can hit the statement-time wall (errno 3024) and die after an otherwise-correct copy. Engine-neutral (it calls the same index-creation path the deferred phase does, so MySQL and Postgres targets both). FK ordering is unchanged — foreign keys are still created last. Also on sync start for its cold-start. ·

--index-build-mem · Postgres target only: per-build maintenance_work_mem for the deferred index phase, which runs against an otherwise-idle target. A human size (512MB, 2GB) or a raw byte count; default auto probes pg_settings and raises well above the provider's steady-state ~4%-of-RAM default (the dominant index-build speedup), flooring at the current value — sluice only ever raises. auto also lifts max_parallel_maintenance_workers toward the max_worker_processes ceiling. Best-effort: a denied SET WARNs and the build proceeds untuned, never failing the phase. Inert on MySQL targets. Also on sync start's cold-start. ·

--analyze-after · Refresh the target's planner statistics once the copy, constraints, and views are in place — one per-table ANALYZE (Postgres), ANALYZE TABLE (MySQL), or ANALYZE (SQLite). A freshly bulk-loaded table has stale statistics, so the first post-cutover queries plan badly until autovacuum or a background analyze catches up; this closes that window at cutover time. Advisory — a per-table failure WARNs and never fails the migration. Off by default. Also on sync start (cold-start only; steady-state CDC apply is unaffected). ·

--skip-foreign-keys · Don't create foreign-key constraints on the target — and instead ensure each skipped FK's referencing column tuple is indexed (an index is synthesized only when no existing target index already covers those columns as a left-prefix). Engine-agnostic. The flag for a target with limited FK support (a sharded Vitess / PlanetScale keyspace) or FKs managed out-of-band: it lets an FK-bearing source transition without stripping FKs from the source first, and on a MySQL target it preserves the backing index MySQL would otherwise only create alongside the FK. Mutually exclusive with --allow-degraded-fks — opposite intents. Also on sync start (cold-start schema-apply is the only phase that creates FKs). See PlanetScale region move and Foreign keys on Vitess. ·

--raw-copy-format · Wire format for the same-engine raw-copy fast lane (ADR-0078, PG → PG): text (default) is cross-major safe; binary is used only when the source and target server majors match — sluice probes both and downgrades to text loudly on a mismatch; auto requests binary and lets the probe decide. The lane itself engages only for a no-transform copy (no --redact, --type-override, --expr-override, or --inject-shard-column); any transform falls the copy back to the IR path. The win is skipping the per-value decode/re-encode, not text-vs-binary. Also on sync start's fast cold-start (ADR-0079); inert on MySQL / VStream sources. ·

--reap-stale-backends · Postgres target only: authorise pg_terminate_backend on sluice's own orphaned backends found during the cold-start preflight — typically a SIGKILL'd or OOM'd prior run whose server-side COPY backend still holds a target-table lock and a connection slot. Detection runs always and reports loudly; this flag is only the authorisation to act, and is off by default because a legitimately-running concurrent sluice on the same target is a real possibility (you see the report first and decide). An orphan is narrowly defined: a backend whose application_name carries the sluice/ prefix, owned by the connecting role, not the current session, and either idle-in-transaction or holding a lock on a relation sluice is about to write. It never touches another role's or a non-sluice session and needs no superuser grant. Inert against engines with no backend model (MySQL). Also on sync start. ·

--planetscale-raise-query-timeout · Opt-in, PlanetScale target only (ADR-0182): raise the keyspace's queryserver-config-query-timeout to its 3600s maximum for the duration of the migration, then put it back. Read the cost before using it — this is a keyspace-wide config change whose rollout is a rolling tablet restart (~2–6m each way, and again on revert) that affects everyone else on the keyspace. Requires --planetscale-org plus the service token; refused loudly on a non-PlanetScale target or without them. Skipped with an INFO line when no table is large enough to approach the wall. Crash-safe: the raise is recorded in sluice_migrate_state and a --resume or bare re-run reverts a dangling raise before anything else. Composes with --upfront-indexes and the deploy-request fallback — headroom on a fast-enough tier, not a guarantee. Also on sync start, where only the cold-start raises (a warm resume has no copy to protect) and the record lives in sluice_cdc_query_timeout_raise keyed by stream-id. ·

--diagnose-on-crash-dir / --diagnose-on-crash-privacy · Auto-write a diagnose bundle to a directory if the command exits with an error (ADR-0056). Off by default and opt-in only — an unattended bundle landing on disk is itself a privacy risk. The privacy level defaults to basic (the safest: state-table dumps only, no DSN locators, no version metadata, no logs) rather than diagnose's own standard default; standard / verbose opt up explicitly. The privacy flag is only consulted when the directory is set. Also on sync start. ·

  Filtered dry run, then apply:

    sluice migrate --source-driver mysql --source ... --target-driver postgres --target ... \
        --include-table 'app_*' --exclude-table 'app_audit' --dry-run

  Redact PII as it copies:

    sluice migrate --source-driver mysql --source ... --target-driver postgres --target ... \
        --redact users.email=hash:sha256 \
        --redact users.ssn=mask:ssn

  Import a SQLite file / .sql dump, or a live Cloudflare D1: point --source-driver at sqlite (a .db file or an auto-detected wrangler d1 export .sql dump) or d1 (a d1:// DSN; token via CLOUDFLARE_API_TOKEN). Big integers above 253 round-trip exactly; declared DATE / DATETIME columns are decoded per --sqlite-date-encoding. SQLite is also a target (--target-driver sqlite).

    sluice migrate --source-driver sqlite --source ./app.db \
        --target-driver postgres --target 'postgres://...?sslmode=disable'
    sluice migrate --source-driver d1 --source 'd1://<account_id>/<database_id>' \
        --target-driver mysql --target 'user:pass@tcp(host:3306)/app'

  No-PRIMARY-KEY tables (v0.99.13). A source table with no declared PRIMARY KEY but a NOT-NULL UNIQUE key now migrates and syncs MySQL→Postgres without a manual schema change — sluice promotes the unique key for an idempotent copy (this already worked MySQL→MySQL). A table with no PK and no NOT-NULL unique key is still refused loudly.

## sync start

### sluice sync start
Start (or resume) a continuous-sync stream: consistent snapshot → bulk copy → ongoing CDC. Identified by --stream-id for clean restart.

Flag · Purpose ·

--stream-id · Stream identifier; the key its position is persisted under on the target. ·

--slot-name · Postgres replication-slot suffix (default sluice_slot); set per-instance to run several streams off one source. Since v0.139.0 it also reaches a multi-schema run (--include-schema / --all-schemas), on both the cold start and the warm resume — a logical slot is database-wide, so a spanning sync uses exactly one. Through v0.138.0 the fan-out ignored the flag and always took the default name, so two multi-schema streams against one database could not coexist and the slot recorded in the CDC state row was not the one you asked for. ·

--publication-name · Postgres publication suffix (default sluice_pub); the sibling of --slot-name and required alongside it to run several streams with different --include-table scopes off one source — sharing a publication would silently de-scope the other stream, so sluice refuses that rescope loudly. See staged (wave) migration. ·

--apply-batch-size · CDC changes per target tx, or auto. Default auto (v0.99.44, ADR-0089): the AIMD latency controller adapts the batch size within [1, ceiling] to a p95 target for >10× throughput over single-row apply. Ceilings: 1000 mysql/postgres, 100 planetscale. Pass =1 for the conservative one-change-per-tx behavior. Tables with no usable identity key (no PK, no unique index) are never batched — each such change commits alone. ·

--no-auto-tune · Disable the AIMD controller. --apply-batch-size=N then becomes a strictly static row cap (floor stays 1) instead of an adaptive ceiling. For workloads where you've hand-tuned the batch size and want no auto-adaptation. ·

--apply-concurrency · CDC apply lane count W (ADR-0104/0105/0106; engine-general — MySQL and Postgres). The merged change stream is fanned across W in-order lanes by primary-key hash (same key → same lane → applied in source order, so dependent INSERT→UPDATE→DELETE never reorder), each lane committing concurrently on its own connection with its own AIMD batch controller. 0 (default, unset) = auto:N — the new fast-by-default adaptive concurrent path: Postgres min(4, slot-budget), MySQL/PlanetScale a fixed 4. 1 = explicit serial opt-out (byte-identical to the pre-fast-by-default behaviour). W>1 honored verbatim. Exactly-once for keyed tables (the position advances only to a boundary durable across all lanes). An in-lane PlanetScale tx-killer (MySQL) or serialization/deadlock (Postgres) is recovered in-lane — split-and-retried idempotently, no stream restart. ·

--schema-changes · forward (default, ADR-0091) auto-applies unambiguous source DDL — ADD/DROP/ALTER COLUMN, CREATE/DROP INDEX, ADD/DROP/MODIFY CHECK — on the target so the sync stays online through schema evolution (shape support; whether a given shape actually arrives depends on the source engine's CDC surface — see the per-source matrix in the schema-changes guide). refuse restores the conservative pre-v0.92 behavior: any source DDL surfaces loudly with the drained-model recovery hint. RENAME COLUMN and a computed/volatile DEFAULT on ADD COLUMN always refuse loudly. See the warn box below. ·

--copy-fanout-degree · VStream/CDC snapshot cold-start (PlanetScale-MySQL target) only, ADR-0097: WRITE-side fan-out — the incoming snapshot row stream is PK-hash-partitioned out to N concurrent batched-INSERT writers, each on its own connection, to beat the single round-trip-bound INSERT connection vtgate forces. 0 = auto: 4; 1 = serial. Bounded by the target connection budget. ·

--no-auto-resnapshot · Opt out of the automatic re-snapshot when a resume hits a purged/invalid source position (v0.99.51, ADR-0093). By default a resume from a position older than the source's retained binlogs — routine on PlanetScale's retention window — auto-recovers with a fresh cold-start re-snapshot; with this flag set, sluice instead fails loudly with the recovery commands named, so a full re-snapshot of very large tables is a deliberate choice. A purged position is not the only cause: since v0.137.2 a MySQL file/pos position whose recorded server_uuid no longer matches the source's (instance replaced, rebuilt, restored from backup, failed over) is the same invalid-position class and takes the same fall-through — a fresh cold start against the new instance by default, a hard stop with this flag. See the MySQL resume signals below. ·

--inject-shard-column · NAME=VALUE — ADR-0048 Shape A discriminator column for consolidating a multi-shard Vitess source onto one target (per-shard streams pass distinct VALUEs). See the migrate row. ·

--allow-cross-shard-merge · Opt out of the cross-shard-collision preflight (Bug 152) — see the migrate row. Off by default the guard is active. ·

--metrics-listen · Bind a Prometheus /metrics + /readyz endpoint, e.g. :9090. Exports sluice_build_info, a Go-runtime block, and — when PlanetScale telemetry is configured (below) — the sluice_target_* CPU/mem/storage/lag gauge family. See /metrics export. ·

--position-from-manifest · URL of a backup chain (s3://, gs://, azblob://, file:///) whose terminal manifest's EndPosition becomes this stream's resume position — resume CDC from a restored chain's tail without re-bulking. Bypasses the persisted sluice_cdc_state position. PG soft preflight warnings fire here; --strict-preflight promotes them to refusals. (Mutually exclusive with --restart-from-scratch / --reset-target-data.) The manifest's position is bound to the instance that produced it. On a mysql-flavor source in file/pos mode (gtid_mode=OFF or OFF_PERMISSIVE), backups taken by v0.137.2+ stamp the source's @@server_uuid onto the EndPosition, and a resume that finds a different @@server_uuid on the source — the instance was replaced, rebuilt, restored from backup, or failed over, so its binlog lineage reuses the same filenames but shares none of the bytes — is refused as an invalid position and falls through to a fresh cold start (or a hard stop under --no-auto-resnapshot), rather than streaming from a byte offset in an unrelated binlog. Through v0.137.1 the backup capturers did not stamp it and such a resume was accepted; one reproduced end to end on two MySQL 8.0.46 instances skipped three rows at exit 0. A manifest written before v0.137.2 carries no identity and still resumes on the binlog-filename check alone, with an UNVERIFIED-INSTANCE-IDENTITY WARN naming it — one fresh backup full moves that chain onto the identity check. The stamp is not needed elsewhere: a GTID set is instance-bound by construction, MariaDB is always in GTID mode, PlanetScale/Vitess resume on VStream positions, and a Postgres position is pinned by its own (system_id, timeline) identity. ·

--planetscale-org · PlanetScale org slug, consumed by both optional PlanetScale integrations — each arms on its own token pair (v0.99.259): (1) target-health telemetry (CPU/mem/storage/lag) read from the PlanetScale metrics endpoint (ADR-0107), feeding proactive apply back-off and the sluice_target_* gauges — opt-in and all-or-nothing with the metrics-token pair (org + a partial metrics pair is a loud refusal); (2) the ADR-0148 deploy-request index-build fallback for the cold-start index phase on a planetscale target — opportunistic, WARN-at-most, arming on the service-token pair (a fallback-only arming never trips the telemetry refusal). A control-plane credential, distinct from the data-plane --target DSN. Unlike migrate's flag it has no ambient PLANETSCALE_ORG env binding here — arming needs the explicit flag (the tokens still come from env). Off when unset (default sync unchanged). ·

--planetscale-metrics-token-id / --planetscale-metrics-token · PlanetScale service-token (granted read_metrics_endpoints) ID + secret for --planetscale-org telemetry. Set via the env vars PLANETSCALE_METRICS_TOKEN_ID / PLANETSCALE_METRICS_TOKEN — never on the command line; masked in all logging. ·

--planetscale-metrics-db / --planetscale-metrics-branch · Database (defaults to the --target DSN's database) and branch (default main) the telemetry series is filtered to. Only consulted when --planetscale-org is set. ·

--planetscale-database / --planetscale-branch / --planetscale-service-token-id / --planetscale-service-token / --planetscale-deploy-timeout · ADR-0148 index-build fallback inputs — same set and defaults as migrate's: database defaults to the --target DSN's, branch to main, deploy deadline 1h; the service token (branch + deploy-request scopes) via env PLANETSCALE_SERVICE_TOKEN_ID / PLANETSCALE_SERVICE_TOKEN. Before v0.99.259 the cold-start's walled PlanetScale index build always ended at the SLUICE-E-INDEX-* hint; armed, sluice builds it via a deploy request. An unarmed run is byte-identical. ·

--suppress-target-metrics-history · Disable persisting polled target-health metrics to the sluice_target_metrics_history table (7-day retention, pruned). History is on by default when telemetry is configured; it lets sluice diagnose show the recent CPU/mem/storage/lag trend without scripting the metrics API. Advisory + failure-isolated — never affects the sync. ·

--notify-webhook / --notify-slack · Threshold-alert sinks (also accepted by metrics-watch): a generic webhook (JSON POST) and/or a Slack incoming-webhook. Set the URLs via the env vars SLUICE_NOTIFY_WEBHOOK / SLUICE_NOTIFY_SLACK. Advisory + failure-isolated (a dead sink is logged-and-swallowed). The sinks themselves are ungated — pair one with a threshold below; only the util / control-plane-lag / growth thresholds additionally need --planetscale-org telemetry. ·

--notify-sync-lag-seconds · Alert when sluice's own apply lag (sluice_sync_lag_seconds) is at or above N seconds. Ungated — works on MySQL and Postgres alike, needing only a sink; no PlanetScale telemetry. 0 disables. ·

--notify-dead-tuple-ratio / --notify-xid-age · Postgres-target autovacuum advisories (v0.99.288). The first fires (warning) when the worst user table's dead-tuple ratio (n_dead_tup/(n_dead_tup+n_live_tup), a fraction 0–1) is at or above the threshold — the alert names the table, the dead/live counts, and when autovacuum last completed there; tables under a 1000-dead-tuple floor are ignored. The second fires (critical) when the database's age(datfrozenxid) wraparound headroom reaches N XIDs (Postgres force-stops near ~2.1B; healthy is ~200M). Ungated — probed from the target's own catalog, needing only a sink. Postgres targets only (elsewhere sluice warns once and the rules stay inert); 0 disables. Also accepted as fleet-YAML keys notify-dead-tuple-ratio / notify-xid-age. ·

--notify-storage-util / --notify-cpu-util / --notify-mem-util · Alert when the target's storage / CPU / memory utilisation (a fraction 0–1, used/capacity) is at or above the threshold. Edge-triggered + cooldown'd. 0 disables a rule. A value outside 0–1 refuses at start with the corrected value named (since v0.124.0 — 85 meaning 85% previously armed a rule that could never fire, silently). Requires --planetscale-org telemetry. ·

--notify-lag-seconds / --notify-storage-growth-per-min · Alert when the target's control-plane replica lag (seconds) is at or above the value, or when storage utilisation is climbing at or above this fraction-of-capacity per minute (a pre-grow early warning, e.g. 0.02 = +2%/min). 0 disables. Requires --planetscale-org telemetry. ·

--notify-cooldown · Minimum interval between re-fires of a still-breached alert (default 15m) — a sustained breach reminds at most once per interval, not every poll. ·

--notify-schema-drift · On by default (ADR-0157; inert unless a --notify-* sink is configured): fire a critical notification when a source schema change stalls the sync — a DDL sluice cannot auto-forward (e.g. RENAME COLUMN on MySQL). The alert carries the drift detail + recovery steps. Ungated from PlanetScale telemetry — works on every engine pair. Pass --notify-schema-drift=false to disable while keeping metrics alerts. Advisory + failure-isolated: a delivery problem never affects the (already stalled) sync. ·

--notify-slot-health · On by default (ADR-0059; inert unless a sink is configured; fires only for Postgres logical-replication sources — the structured slog WARNs fire regardless): notify when the source replication slot crosses a health threshold — WAL retention pressure at 70% (warning) / 85% (critical) of max_slot_wal_keep_size, 30m slot inactivity (warning), wal_status unreserved (critical — invalidation at the next checkpoint), and the terminal events (wal_status lost, slot dropped mid-stream) each page critical exactly once and latch. A sustained slot-health probe outage (5 consecutive failures) pages a warning — the net never goes silently blind. Pass --notify-slot-health=false to keep the slog WARNs only. Advisory + failure-isolated. ·

--source-tls-ca / --target-tls-ca · CA-pinned verify-ca TLS to a MySQL source / target (ADR-0158) — PEM CA path; covers the data connection and the binlog/CDC stream on the source. See the migrate row for the full semantics. ·

--apply-retry-attempts · Max consecutive retriable failures absorbed before exiting (ADR-0038, default 8 — tuned for managed-Vitess tx-killer transients). 1 = no retry. The counter resets whenever the persisted CDC position advances. Since v0.99.288 the same budget also covers transient network failures while a retry attempt re-establishes its connections (a dead pool connection, reset/refused, timeouts) — previously those exited the stream. ·

--apply-retry-backoff-base / --apply-retry-backoff-cap · Exponential backoff between retriable apply failures: base 100ms (doubling), capped at 30s. Only consulted when --apply-retry-attempts > 1. ·

--apply-exec-timeout · Per-statement deadline on every apply-path ExecContext (default 60s). Closes the silent-stall mode where a half-closed target connection blocks the apply goroutine inside the driver; on expiry the batch is retried on a fresh connection. 0 disables (unbounded). ·

--source-heartbeat-interval · Write a heartbeat row on the source every interval so the slot/binlog can't be evicted past the consumer against an idle source. ·

--no-source-heartbeat / --source-heartbeat-table-name / --source-heartbeat-prune-window · The rest of the source-heartbeat family (ADR-0061), all consulted only when --source-heartbeat-interval > 0. --no-source-heartbeat is the opt-out escape hatch — it skips the writer even when an interval is configured (in YAML, say), for managed DBs and read-replicas where the table DDL is restricted; sluice already WARNs-once-and-skips on a permission error, so this exists to silence that warning deliberately. --source-heartbeat-table-name renames the table (default sluice_heartbeat) for namespaces where a DBA pre-creates it. --source-heartbeat-prune-window (default 1h) is the age above which heartbeat rows are periodically deleted; 0 disables the prune and the table grows unbounded. ·

--heartbeat-interval · Cadence of sluice's own log heartbeat — an INFO stream: heartbeat line on a wall-clock timer (default 60s, 0 disables). Distinct from --source-heartbeat-interval, which writes a row on the source database. This one exists to tell a silent stall (process alive, applying nothing, logging nothing) apart from a wedge (process alive, not even heartbeating). ·

--dry-run, -n · Show cold-start vs warm-resume and the planned actions without starting. ·

--schema-already-applied · Skip all cold-start DDL (you promise the target catalog matches). For Atlas/Liquibase-managed or PlanetScale Safe-Migrations targets. ·

--include-table / --exclude-table · Glob-aware table filters (mutually exclusive). Scope the cold-start snapshot and its resume — including the PlanetScale (VStream) snapshot, so an excluded table in a large keyspace is never streamed (v0.99.12–v0.99.13), not just the write path. ·

--where · TABLE=<predicate> — continuous filtered replication: replicate only the rows of TABLE matching a native source-SQL boolean predicate (repeatable, source-keyed; ADR-0173/0174). Unlike migrate's one-shot --where, this scopes both the cold-start copy and the ongoing CDC tail — a change that moves a row into scope replays as an INSERT, one that moves it out replays as a DELETE, so the target stays a faithful filtered replica instead of accumulating orphans. Same rules as migrate's: filtering a parent orphans its children (SLUICE-E-WHERE-FK-ORPHAN — filter consistently or pass --allow-degraded-fks), a key naming no table refuses (SLUICE-E-WHERE-UNKNOWN-TABLE). A string predicate is classified under the column's real collation so a row-move matches the source's own = (case/accent folding, and PAD-SPACE trailing-space semantics on legacy collations); on a PlanetScale/Vitess source a PAD-SPACE-collation predicate is filtered client-side so trailing-space rows aren't dropped (v0.99.283). ·

--where-strict-collation · sync-only. Refuse any --where string predicate whose collation can't be reproduced byte-exact, instead of folding under the column's collation. By default a string --where compares the way the source's = does — a case/accent-insensitive column folds, which is the faithful default; this flag opts out, allowing only byte-exact (_bin / binary) collation columns and refusing loudly (SLUICE-E-WHERE-CDC-UNSUPPORTED-PREDICATE) on a case/accent-insensitive one. Use when the filter's string equality must be exactly memcmp — e.g. a downstream that must never receive case/accent-folded matches. ·

--force-cold-start · Skip the pre-flight check that refuses to bulk-copy into a populated target. Use with caution — an INSERT into a non-empty table can collide on the primary key. Still warm-resumes from a persisted position (it only skips the check); ignored on the warm-resume path. ·

--reset-target-data · Destructive recovery: delete the CDC-state row, DROP every source-schema table on the target, then run a fresh cold-start. For a wedged-state recovery (e.g. slot-missing fall-through). Prompts (type reset) unless --yes. See ADR-0023. ·

--restart-from-scratch · Force a fresh cold-start re-copy from the beginning, ignoring any persisted resume position (incl. a mid-COPY cursor) — without dropping the target (the idempotent copy absorbs the overlap). For a bad checkpoint. Differs from --force-cold-start (keeps the position) and --reset-target-data (drops tables). (v0.99.10) ·

--copy-table-parallelism · Native (self-managed, non-Vitess) MySQL source only: the cold-copy read axis — how many concurrent FTWRL-coordinated pinned-snapshot reader connections the copy opens (ADR-0101). Consistency is identical to serial: one FTWRL cut, one binlog position. 0 (default) means unset — fall back to the source DSN's copy_table_parallelism, then to the engine default (auto: 4, clamped to the table count). An explicit flag value wins over the DSN parameter; 1 opts out to serial. A source without the RELOAD privilege (RDS / Aurora) falls back to serial with a loud WARN. Inert on Postgres and VStream sources — this is why --table-parallelism is PG-source-only here. ·

--vstream-copy-table-parallelism · VStream (PlanetScale / Vitess) source only: the cold-copy read axis — how many concurrent single-table COPY streams the auto-shard cold-copy runs (ADR-0099), the read-side sibling of the write-side --copy-fanout-degree. 0 (default) = unset, falling back to the DSN's vstream_copy_table_parallelism and then the engine default of 1 (serial single stream); an explicit value wins over the DSN parameter. Inert on Postgres and native-MySQL sources. ·

--no-intra-table-stealing · Native-MySQL concurrent cold-copy only (--copy-table-parallelism > 1, which the engine default already is): turn off intra-table PK-range work-stealing (ADR-0119). By default a large chunk-eligible table is split into PK ranges so an idle reader can steal a chunk of the last big table, keeping the copy N-wide to the tail instead of tapering to a single reader; with this set, every table is one whole-table work item. A throughput knob, not a correctness one — chunk coverage is gap-free and overlap-free either way. Inert on PG / VStream sources and on a serial copy. ·

--strict-float / --no-float-exact-reread · VStream (PlanetScale / Vitess) source cold-start only. vttablet's rowstreamer renders single-precision FLOAT at mysqld's 6-significant-digit display precision (8388608 → 8388610), so a VStream COPY lands those columns rounded. By default sluice re-reads them exactly over SQL (the ADR-0153 (col * 1E0) projection) and UPDATEs the target rows by PK before CDC begins, restoring float32 exactness — one extra read pass. --no-float-exact-reread skips that repair and keeps the rounding. --strict-float goes the other way: refuse loudly (SLUICE-E-VSTREAM-FLOAT-LOSSY, exit 3) before any row moves for a table the re-read cannot repair — no primary key to target it, or a single-precision FLOAT inside the primary key — where the default is a WARN plus rounded values. Passing both is refused (one disables the exactness the other demands). Both inert on sources whose snapshot is already float-exact (native MySQL, Postgres) and on schemas with no single-precision FLOAT column. backup full takes the same pair plus --float-reread-max-rows. ·

--vstream-preserve-skew · VStream CDC only: opt back in to vtgate's MinimizeSkew hold — a commit-time-ordered merged stream across shards — on the steady-state multi-shard stream. Since ADR-0120 it is off by default: both shards stream and drain concurrently, because a real cross-region A/B showed the old on-by-default freezing the lagging shard under an apply-deficit backlog. Set this only if you specifically need strict cross-shard commit-time delivery and accept the catch-up-wedge risk. The DSN form vstream_preserve_skew=true also works; the flag wins. Inert on PG / native-MySQL sources and on a single-shard keyspace. ·

--apply-delay · Delayed-replica mode (ADR-0121) — the MySQL MASTER_DELAY "oops window" pattern. Hold each steady-state change until its source commit timestamp plus this duration has elapsed, so a target deliberately kept N behind lets you stop sluice before an accidental DROP TABLE or runaway DELETE replicates, and recover from the still-intact target. Only the steady-state CDC apply is delayed; the cold-start copy is not. Exactly-once survives a crash mid-window: a held-but-unapplied change never advances the durable position, so it is re-read on restart. Held changes backpressure to the source read (bounded memory, no large in-heap buffer) — for delays approaching the source's replication idle timeout (wal_sender_timeout, net_write_timeout) raise that server-side value or the source may reap the connection and sluice reconnects-and-replays. The configured delay is subtracted from sluice_sync_lag_seconds, so a healthy delayed replica reads ~0 lag rather than delay. 0 (default) disables. ·

--apply-tune-target-latency · Override the AIMD apply controller's p95 target latency (ADR-0052). Engine defaults when unset: 5s on planetscale (Vitess's 20s transaction killer with 4× headroom), 10s on mysql / postgres. Only consulted while the controller is active — --no-auto-tune makes it moot. ·

--control-keyspace · MySQL / PlanetScale / Vitess target only: put sluice's three CDC control tables (sluice_cdc_state, sluice_cdc_schema_history, sluice_shard_consolidation_lease) in this unsharded sidecar keyspace rather than the connection's default one. A sharded Vitess keyspace requires a primary vindex on every table and the control tables have none, so a sync against a sharded target otherwise dies with VT09001: table sluice_cdc_state does not have a primary vindex. Usually you can omit it: against a sharded target sluice auto-detects the sole unsharded sidecar and refuses loudly if there are zero or several candidates. On a sharded target the position write becomes a best-effort cross-keyspace commit — acceptable, since that apply is already cross-shard and resume is idempotent. Empty on an unsharded or non-Vitess target is unchanged behaviour; inert on non-MySQL targets. The same flag is accepted by sync status / stop / health / decommission and schema add-table (where it must match what the stream was started with), and by restore for a chain restore's incremental-replay leg. ·

--no-coordinate-live-ddl · Disable live cross-shard DDL coordination (ADR-0054). Coordination is on whenever --inject-shard-column is set: one shard's stream takes a lease, applies the DDL once on the consolidated target and records the schema version plus a DDL checksum; the peer shards verify the checksum, skip the apply, and keep streaming. This flag restores the pre-v0.73 drained model instead — you run sync stop --wait on every shard, migrate the schema once, then re-run sync start with each shard's same --stream-id (which warm-resumes) on every shard. A no-op when --inject-shard-column is unset. ·

--shard-coordination-lease-duration / --shard-coordination-renew-deadline / --shard-coordination-retry-period · Timings for that DDL-coordination lease (ADR-0054), consulted only when --inject-shard-column is set and --no-coordinate-live-ddl is absent. The holder writes lease_expires_at = now + lease-duration every retry-period; a stalled holder loses the lease after the duration and the takeover stream probes-and-records. Defaults 30s / 20s / 10s, and the ordering retry-period < renew-deadline < lease-duration is enforced. Raise the lease to something like 300s if you run ALTERs on tables large enough that the apply window exceeds 30s. ·

--backfill-added-column · After a forwarded ADD COLUMN lands, populate the already-shipped target rows with real source values instead of leaving them on the column's DEFAULT (NULL if none) — ADR-0058. The streamer issues a bounded PK-cursor SELECT (pk, new_col) against the source and emits synthetic UPDATE events. Off by default and knowingly opt-in: the cost is proportional to the table's source row count. Consulted whenever schema-change forwarding is active — i.e. under the default --schema-changes=forward; --schema-changes=refuse makes it moot, as do --inject-shard-column (whose own boundary router handles the shape) and multi-database streams (which don't forward DDL at all). ·

--auto-prune-change-log / --auto-prune-interval / --auto-prune-keep · Trigger-CDC sources only (postgres-trigger / sqlite-trigger / d1-trigger) — a no-op on every other engine, which has no change log. Reap consumed rows from the source's sluice_change_log in-stream so it can't grow unbounded on a continuous sync (ADR-0137): equivalent to cronning sluice trigger prune, without the cron. Off by default — auto-DELETEing rows on the source is an explicit opt-in. Only rows below the target's persisted CDC frontier (minus --auto-prune-keep, default 1000) are removed, so warm-resume is never starved, and a prune failure is logged and swallowed. Multi-stream safe: every trigger-CDC sync records its applied frontier in the source's sluice_change_log_consumers table and the cut is taken at the minimum across registered consumers. Two caveats before enabling it on a shared source — a change log predating that registry is refused (nothing is pruned) until you re-run sluice trigger setup to migrate it, and a peer sync on an older sluice never registers at all, so upgrade every sync on the source first. Cadence via --auto-prune-interval (default 5m). ·

--patroni-mode · Control the Patroni / HA-managed Postgres source detection. auto (default) runs the engine heuristics plus a DSN hostname-pattern check and warns if any signal fires; on skips the heuristics and forces the warning (for tenant-isolated managed PG the heuristics miss); off suppresses it entirely (you have confirmed a self-hosted single-node PG with no HA). Pair --patroni-mode=on with --strict-preflight to turn the warning into a hard refusal. ·

--notify-smtp-host + family · Email sink for threshold alerts — one relay covers every transactional provider (SendGrid / Mailgun / SES / Postmark are all SMTP) and self-hosted relays. Opt-in: the sink is inert until --notify-smtp-host is set, and setting it makes --notify-smtp-from and at least one --notify-smtp-to (repeatable) required. --notify-smtp-tls picks the transport — starttls (default), implicit (TLS from connect), or none (cleartext, trusted local relay only) — and --notify-smtp-port defaults from it (587 for starttls/none, 465 for implicit). --notify-smtp-auth is none (default), plain, or login; the latter two need --notify-smtp-username (e.g. apikey for SendGrid) and the password, which is read only from the SLUICE_NOTIFY_SMTP_PASSWORD env var (--notify-smtp-password is never to be passed on the command line; it is masked in all logging). Advisory and failure-isolated like the other sinks — a dead relay is logged and swallowed. The identical set is accepted by metrics-watch. ·

Shared with migrate · The copy-phase flags documented under migrate apply to the cold-start here with the same meaning: --upfront-indexes, --index-build-mem, --analyze-after, --skip-foreign-keys, --bulk-batch-size, --raw-copy-format, --reap-stale-backends, --planetscale-raise-query-timeout, --enable-pg-extension, --keyset-source, --redact, --type-override, the view filters --include-view / --exclude-view / --skip-views, and --diagnose-on-crash-dir / --diagnose-on-crash-privacy. Only the cold-start is affected — steady-state CDC apply builds no indexes, creates no constraints, and replicates no views. The source-side preflights are shared too: since v0.138.0 a multi-schema cold start (--include-schema / --all-schemas) runs the partitioned-table and inheritance-parent refusals per selected schema exactly as migrate does — through v0.137.4 it ran neither, and a partitioned parent was copied flattened alongside its leaves at exit 0. Since v0.139.0 the fan-out also runs the source-side replica-identity refusal (SLUICE-E-SOURCE-REPLICA-IDENTITY) per selected schema, and runs it before the spanning snapshot rather than inside the per-schema copy loop: on this path the snapshot open is what creates the FOR ALL TABLES publication, and Postgres refuses UPDATE/DELETE on a published table that has no replica identity — so a refusal arriving any later would land after the source application's own writes had already started failing. Through v0.138.0 the fan-out skipped this preflight entirely and streamed such a table. Stated residual: the publication is FOR ALL TABLES, so the preflight covers the selected namespaces while the publication exposes every table in the database. ·

  Source DDL auto-applies by default (v0.99.45, ADR-0091). A running stream now forwards unambiguous source schema changes onto the target automatically — including a destructive DROP COLUMN, which drops the column (and its data) on the target. This keeps the sync online through routine schema evolution, but it means a source DDL change propagates without operator review. To gate DDL through a separate change-management process, start the stream with --schema-changes=refuse — any source DDL then surfaces loudly instead of applying. (The older --forward-schema-add-column flag is deprecated: it warns and still forwards, subsumed by the new default.)

  Mid-stream reshard is followed automatically (v0.99.62, ADR-0094). A PlanetScale/Vitess source reshard (shard split/merge, MoveTables) used to halt the sync as a loud terminal error. The Streamer now reopens onto the new shard layout from the journal-stamped GTIDs and continues with no gap and no re-snapshot. (Not yet auto-followed when --inject-shard-column is engaged — that interplay keeps the prior loud-terminal behavior.)

  Multi-table Vitess keyspaces cold-copy in one command (v0.99.63, ADR-0095). A full Vitess/PlanetScale keyspace now cold-copies in a single sync start at bounded memory — the engine auto-shards the VStream COPY by table internally, so there's no per-table --include-table workaround. On by default for a fresh multi-table cold-start; opt out with vstream_copy_single_stream=true in the source DSN (see Source-DSN tuning parameters).

  Tables the target lacks: skip-and-count, never halt (v0.123.0). When the stream carries changes for a table the target doesn't have — a drifted publication scope, a table dropped on the target, a keyspace-wide stream whose target was migrated with --include-table — every engine's applier skips those events instead of halting: the source still holds every skipped row (recoverable with sluice schema add-table), while a halted stream lags every table and past binlog/slot retention loses the resume position itself. A skip is never log-only: one WARN per table, every event counted durably in the per-target sluice_cdc_skipped_tables control table (cumulative count + first/last skipped position tokens), rendered by sync status and the sync stop summary — and sync health exits 1 while any count is nonzero. Remedies: re-attach with schema add-table, make the exclusion explicit with a table filter — or, when the cause is revoked privileges rather than a missing table (the catalog hides tables the apply role cannot see), restore the grant and the skip clears on the next change, no re-snapshot.

  The apply path is adaptive-concurrent by default (v0.99.100+, ADR-0106). With --apply-concurrency unset, CDC apply fans out across an auto-chosen number of PK-hash lanes (Postgres min(4, slot-budget); MySQL/PlanetScale 4) — exactly-once for keyed tables, with per-lane AIMD and in-lane tx-killer/deadlock recovery. To force the old strictly-serial apply, pass --apply-concurrency 1.

  Resilient on managed / PlanetScale targets (no flags needed). sluice automatically rides PlanetScale storage-grow and primary-reparent serving transitions without operator intervention — across cold-copy writes, cold-copy source reads, the coordinated grow-gate, restore reconciliation, and (new in v0.99.118) the post-copy DDL phase (index / constraint / view build). Transient errors during a transition are bounded-retried and loud only on genuine exhaustion.

  MySQL resume signals (v0.137.2–v0.139.0). A self-hosted MySQL source resumes on one of two arms — a GTID set, or a binlog file and offset — and the arms are not equally strong: a GTID set is instance-bound by construction, whereas a binlog file/offset is instance-local and carries no provenance — a replaced, rebuilt or restored server starts a fresh lineage that reuses mysql-bin.000001. On the file/pos arm sluice binds every persisted position to the source's @@server_uuid and refuses a mismatch; both the backup capturers (since v0.137.2) and the CDC capturers stamp it. The markers and refusals below say where a given resume stands; none is toggled by a flag. Since v0.138.0 the other MySQL-family arms ask the lineage question in their own terms — the GTID arm against @@gtid_executed, MariaDB through a BINLOG_GTID_POS anchor recorded with the position, the PlanetScale/Vitess flavors per shard ahead of the retention check — and those rows are marked v0.138.0+. Postgres is out of scope here.

  Which arm a position uses is decided by the source, not by the command. Since v0.139.0 every capture door — the backup doors, the from-now open, and both sync cold-start snapshot openers — records a GTID position when the source has gtid_mode=ON, and a file/offset one stamped with the server's server_uuid when it does not. Before v0.139.0 the two sync openers always recorded file/offset, so a sync chain on a GTID-mode source could not follow a failover to a promoted replica: the identity check refused the new server and the stream fell through to a fresh cold start. Positions written by earlier releases keep resuming on the arm they were written with, so an upgrade needs nothing — the change takes effect at the next cold start.

Signal at CDC open · When · What it means ·

POSITION-MODE (info) · mysql-flavor source with gtid_mode=OFF or OFF_PERMISSIVE, at every CDC open including the cold-start snapshot's. v0.137.3+. · This source resumes from a binlog file and offset. Supported and correct — and the weaker of the two arms, for the reason above: a resume against a replaced source is caught only by the @@server_uuid stamp, where a GTID set would catch itself. Enabling gtid_mode=ON on the source is the stronger configuration if the platform gives you the choice. It is an INFO, not a WARN, on purpose: a warning on a working configuration is what teaches people to ignore warnings. Nothing to do. ·

UNVERIFIED-INSTANCE-IDENTITY (warn) — no identity recorded · The persisted file/pos position carries no server_uuid: a backup manifest written by v0.137.1 or earlier, or a capture that could not read the value. v0.137.3+ names it; earlier binaries were silent. · The position is unverifiable, not wrong, and it is accepted — refusing would force a full re-copy on chains that are almost certainly fine. What protects it is the binlog filename check alone, which a replaced source reusing the same name defeats. Taking one fresh backup full moves that chain onto the identity check; this population cannot grow, since every capture door now stamps, so it drains as chains are re-rooted. ·

UNVERIFIED-INSTANCE-IDENTITY (warn) — source unreadable · The position carries an identity, but the source's @@server_uuid could not be read on this open, so the check could not run. v0.137.3+. · A probe failure on a refusal-gating check, which is a different thing from an old position. It is allowed through so a transient read failure cannot force a re-snapshot, but a replaced source would not be caught on this resume. Once is noise; a recurring one is a real finding — find out why the source will not answer SELECT @@server_uuid for this connection. ·

"source instance identity changed since the persisted position was captured … refusing to resume" (refusal) · The recorded server_uuid and the source's differ: the instance was replaced, rebuilt, restored from backup, or failed over. v0.137.2+ for backup-captured positions; CDC-persisted positions have carried the stamp, and been checked, since v0.69.5. · The guard doing its job. The binlog lineage does not carry over, so the position is refused as invalid rather than streamed from an unrelated file. sync start falls through to a fresh cold start against the new instance by default, or a hard stop naming the recovery commands under --no-auto-resnapshot; backup incremental refuses and the remedy is a fresh backup full. Through v0.137.1 a backup-captured position had no identity to check, and this case resumed silently — see the --position-from-manifest row above. ·

"the resume GTID set is not contained in the source's @@global.gtid_executed … the source is a different lineage" (refusal) · mysql-flavor source resuming on the GTID arm. The arm now asks GTID_SUBSET(resume, @@gtid_executed) — did this server ever execute what the position claims to have consumed? — before the purge check. v0.138.0+; through v0.137.4 the arm ran only the purge check, which a fresh instance's empty gtid_purged passes (the empty set is a subset of every set), so a position from instance A resumed against unrelated instance B and streamed B's whole history as the continuation. · A fresh, reset or rebuilt instance, or a replica promoted without transactions the old primary had (which sluice already applied to the target). Refused as an invalid position and routed exactly like the identity-mismatch row above. A promoted replica passes (its executed set is a superset of what it replicated), as does a restore with --set-gtid-purged=ON. When every source UUID in the resume set is present and only sequence numbers are ahead, the refusal says instead that "the source is BEHIND the resume position" — a lagging replica behind a load-balanced or failover endpoint, or a primary rolled back past the position — the same route, a different diagnosis. ·

"the source is a different lineage" (refusal) — MariaDB lineage anchor · MariaDB source, either position mode. A position captured by v0.138.0+ carries a lineage anchor: the binlog (file, offset) the capture read, together with BINLOG_GTID_POS(file, offset) — the GTID state at that byte of this server's binlog. MariaDB GTIDs (domain-server-seq) carry no instance identity and there is no @@server_uuid, so neither the set nor a filename says which server produced it; at resume the source is asked the same question. · The same set answers back: same lineage, resume proceeds. NULL with the anchor's file still present, or a different set: a rebuilt or foreign instance whose GTIDs happen to collide — refused as invalid. The anchor's file absent: treated as purged by retention on the same lineage only when the oldest retained binlog's own start state (BINLOG_GTID_POS(file, 4)) covers the anchor's set in every domain — an INFO, and retention of the resume point itself stays the server's question (error 1236); otherwise refused. A GTID-mode position must also name only domains present in @@gtid_binlog_state. ·

UNVERIFIED-INSTANCE-IDENTITY (warn) — no lineage anchor (MariaDB) · A MariaDB position persisted by v0.137.4 or earlier, before anchors were recorded. v0.138.0+ names it. · Accepted, unverifiable: a rebuilt source whose history reads the same GTIDs would not be caught on this resume. One fresh backup full or cold start moves the chain onto the lineage check. ·

"names a source UUID the shard has never executed … the source is a different lineage" (refusal) · PlanetScale/Vitess (VStream) source, per shard: GTID_SUBSET(resume, @@gtid_executed) asked of the shard up front, ahead of the purged-GTID retention check. v0.138.0+. · A fresh, reset, rebuilt or replaced keyspace/shard — refused as an invalid position. vttablet refuses such a resume set itself ("GTIDSet Mismatch"), but that refusal does not reliably reach sluice: vtgate marks the refusing tablet ignorable and blocks waiting for another, so a backup incremental window expired into a clean close with an empty end position and the next link started from "current" on the unrelated cluster. A probed tablet that is merely behind (every UUID present, lower sequence numbers) is replica lag — logged at INFO and left to vtgate's tablet picker. ·

UNVERIFIED-INSTANCE-IDENTITY (warn) — lineage probe failed (VStream) · The shard's GTID_SUBSET(resume, @@gtid_executed) probe itself errored. v0.138.0+. · The position could not be checked against the shard's lineage; the retention check still runs and the resume proceeds. A replaced keyspace would not be caught on this resume — once is noise, a recurring one is a real finding. ·

  Run as a service with metrics + idle-source heartbeat:

    sluice sync start --source-driver postgres --source ... --target-driver mysql --target ... \
        --stream-id reporting \
        --metrics-listen :9090 \
        --source-heartbeat-interval 30s

  With PlanetScale target-health telemetry + a storage alert (tokens via env, control-plane credential distinct from --target):

    export PLANETSCALE_METRICS_TOKEN_ID=...   # the read_metrics_endpoints service token
    export PLANETSCALE_METRICS_TOKEN=...
    export SLUICE_NOTIFY_SLACK=https://hooks.slack.com/services/...
    sluice sync start --source-driver mysql --source ... --target-driver planetscale --target ... \
        --stream-id app-prod \
        --planetscale-org acme --planetscale-metrics-db app \
        --notify-storage-util 0.85 --notify-slack "$SLUICE_NOTIFY_SLACK"

## sync status / stop / health / decommission

### sluice sync status · stop · health · decommission
Inspect, gracefully stop, health-check, and retire a stream. All take --stream-id plus the target connection (decommission takes the source too).

- sync status — show the stream's persisted position and phase. --watch DURATION re-renders on that interval until interrupted (--watch 2s is the usual operator cadence; 0, the default, prints once and exits). --summary prepends an aggregate header — stream count, oldest and most-recent ages — which is what makes a fleet listing skimmable rather than a wall of rows.

- sync stop — request the stream to drain in-flight changes and exit cleanly. By default it just files the stop request and returns; pass --wait / -w to block until the running streamer drains and clears its stop signal (with --timeout, default 5m; on timeout the CLI exits non-zero and the stop request remains in place). Use --wait to coordinate ALTER windows or scripted teardowns.

- sync health — probe freshness against thresholds and return a cron-friendly exit code (non-zero when stale).

- sync decommission — retire a finished stream's durable footprint in one gated command (v0.99.291): drops its replication slot on the source (a leftover slot pins WAL and, on Postgres, blocks later differently-scoped cold starts under the scope guard), drops its recorded per-stream publication (never the shared sluice_pub), then clears its control row last — so a partially-failed run keeps the record and an idempotent re-run finishes the job. Takes the cross-DSN sync start shape (--source-driver/--source --target-driver/--target --stream-id); refuses on a live stream (SLUICE-E-DECOMMISSION-STREAM-ACTIVE — run sync stop --wait first) and without --yes; --dry-run previews without touching anything. MySQL-family sources have no source-side objects (the binlog is the stream), so decommission clears the control row and says so; trigger-CDC change-log tables belong to trigger prune/teardown.

    sluice sync stop   --stream-id app-prod --target-driver postgres --target ... --wait --timeout 10m
    sluice sync health --stream-id app-prod --target-driver postgres --target ... \
        --max-stale-seconds 300   # exit non-zero if the last apply was more than 5 minutes ago
    sluice sync decommission --stream-id wave-1 --source-driver postgres --source ... \
        --target-driver postgres --target ... --yes   # drained wave: drop slot + publication, clear control row

   sync health's freshness check is --max-stale-seconds N (target-side wall-clock seconds since the last apply; 0 = informational only). When you also pass --source-driver + --source the probe reads the source position too and, on a PG→PG pair, exposes --max-lag-bytes N (source LSN bytes ahead of target; MySQL GTID sets aren't byte-distance comparable). Both exit 1 when breached — cron-friendly. Since v0.123.0 the exit-1 set has a third member with no threshold flag: a nonzero skipped-tables count (skipped_tables in the JSON — see the skip-and-count note under sync start), because skipped tables only resolve through operator action.

## sync run / sync tui

### sluice sync run --config syncs.yaml
Supervise many syncs from one process (ADR-0122): each sync is failure-isolated with bounded-backoff restart, and a bad neighbor never takes the fleet down.

Flag · Purpose ·

--config, -c · Required (the global flag). Path to a syncs.yaml fleet config — a syncs: list of per-sync specs (each a curated subset of the sync start knobs) plus an optional fleet-wide restart: policy. Load-time validation refuses a duplicate stream-id, a colliding Postgres slot name, or an unknown/misspelled key (a typo'd knob is a loud failure, never a silent drop). ·

--dashboard-listen · Serve a read-only fleet dashboard — a self-contained HTML page plus a stable GET /api/fleet JSON API — on ADDR (e.g. :9300). Empty = off. It exposes only what sync status --all does (stream-ids, states, errors — no DSNs, no row data) and has no authentication: bind to localhost or a trusted network. A bind failure is loud-fatal (the fleet won't start without the dashboard you asked for). ·

--dry-run, -n · Validate the fleet config (required fields, stream-id + slot-name uniqueness, retry bounds) and print the resolved plan — start nothing. ·

  The process blocks until every sync exits; Ctrl-C / SIGTERM stops them all cleanly. Live reload without a restart: edit syncs.yaml and send the process SIGHUP — sluice re-reads and re-validates the file, then reconciles the live fleet (starts added syncs, drains removed ones, restarts changed ones, leaves unchanged ones untouched). A reload that fails to parse or validate is refused loudly and the running fleet keeps going on the old config. SIGHUP is POSIX-only; on Windows, restart the process to change the fleet. The full walkthrough is in Operate a sync fleet.

    # validate + print the plan, start nothing
    sluice sync run --config syncs.yaml --dry-run

    # run the fleet with a read-only dashboard API on :9300
    sluice sync run --config syncs.yaml --dashboard-listen :9300

    # reload the running fleet after editing syncs.yaml (POSIX)
    kill -HUP "$(pgrep -f 'sluice sync run')"

### sluice sync tui --connect ADDR
A full-screen terminal dashboard for a running fleet (ADR-0125) — it polls a 'sync run --dashboard-listen' server's /api/fleet endpoint, so it works locally or over an SSH tunnel without disturbing the fleet process.

Flag · Purpose ·

--connect · Required. host:port or URL of a running sync run --dashboard-listen server — :9300, localhost:9300, http://host:9300, or a full …/api/fleet URL. The TUI polls its /api/fleet endpoint. ·

--refresh · How often to poll /api/fleet for a fresh fleet view (default 2s). ·

  The TUI keeps the last-known fleet on screen with an "unreachable" banner if a poll fails, instead of blanking.

    # terminal 1: run the fleet with the dashboard API exposed
    sluice sync run --config syncs.yaml --dashboard-listen :9300

    # terminal 2 (local or over an SSH tunnel): live terminal view
    sluice sync tui --connect :9300 --refresh 2s

## schema add-table

### sluice schema add-table <table>
Bring a new source table into an active stream's scope without a destructive --reset-target-data cycle. Drain the stream first via 'sluice sync stop --wait'.

Flag · Purpose ·

<table> (argument) · Unqualified name of the new source table; its schema/database is inferred from --source. ·

--stream-id · Required — must match the active stream's id (run sluice sync status to confirm). ·

--type-override / --expr-override · Per-column overrides for the new table (repeatable). ·

--target-schema · Postgres-only: must match the active stream's --target-schema, or be omitted to inherit the recorded value. ·

--no-drain · Phase 2 live add: run against an actively-streaming sync without first running sync stop --wait. PG-only in this release; MySQL sources still require the drained workflow. ·

--dry-run, -n / --yes, -y · Print the plan without modifying anything / skip the typed-confirmation prompt. ·

    # drain first, add the table, then resume
    sluice sync stop --stream-id app-prod --target-driver postgres --target ... --wait
    sluice schema add-table new_events \
        --source-driver mysql --source ... --target-driver postgres --target ... \
        --stream-id app-prod
    sluice sync start --stream-id app-prod --source-driver mysql --source ... --target-driver postgres --target ...

## sync from-backup

### sluice sync from-backup run · stop
Replay a backup chain into a target as a long-running broker — polls a chain root (S3/GCS/Azure/local) for new incrementals and applies them. No direct source↔target connectivity required.

Flag · Purpose ·

--backup-target / --backup-dir · The chain location: a URL (s3://, gs://, azblob://, file:///) or a local directory. Mutually exclusive. ·

--backup-endpoint / --backup-region / --backup-path-style · S3-compatible-provider knobs (R2 / B2 / MinIO / Wasabi / Tigris); only meaningful when --backup-target is an s3:// URL. ·

--target-driver / --target · Target engine name and DSN (or SLUICE_TARGET). ·

--stream-id · Required. The key the broker's chain-state position is persisted under on the target — needed for clean restart resume. ·

--apply-concurrency · Key-hash concurrent-apply lane count W for incremental replay (the same machinery sync start uses). 0 (default) = auto:4; 1 = serial; W>1 honored. Matters for high-latency / cross-region targets — without it a large incremental replays through a single RTT-bound stream. Exactly-once preserved. ·

--reset-target-data · Cold-start recovery: drop target tables, run a chain restore (full + every incremental), then transition to live polling. Prompts (type reset) unless --yes. Mutually exclusive with --at-chain-id. ·

--at-chain-id · Operator-asserted resume: treat the target as currently at chain ID <ID> (e.g. after a manual sluice restore), write a fresh state row, and tail forward. Mutually exclusive with --reset-target-data. ·

--poll-interval · Cadence each broker tick runs at (default 30s); new incrementals are applied within ~one interval of their source-side commit. ·

--apply-batch-size · CDC changes per target transaction during replay (default 100). Idempotent applier semantics keep replay-on-crash safe. ·

--max-buffer-bytes · Soft cap on per-batch buffered memory in the CDC applier. Default 67108864 (64 MiB). ·

  The full walkthrough — producing the chain, cold-start vs warm-resume, stopping — is in the backup-chain sync guide.

    sluice sync from-backup run \
        --backup-target s3://my-bucket/app-chain \
        --target-driver postgres --target ... \
        --stream-id app-broker --apply-concurrency 4 --poll-interval 30s

    sluice sync from-backup stop --backup-target s3://my-bucket/app-chain

## cutover

### sluice cutover
Two-phase sequence priming at cutover: re-read source sequence / AUTO_INCREMENT state and apply it to the target with a safety margin, so the first post-cutover INSERT can't collide on the primary key.

    sluice cutover --config sluice.yaml --sequence-margin 1000

   Run after the snapshot has caught up and just before switching application traffic to the target.

   --sequence-margin (default 1000) is the headroom added on top of every source sequence value before it is applied — cover for in-flight source-side INSERTs between the read and the apply, and between the apply and the moment you actually flip traffic. The same margin doubles as the idempotency tolerance: a re-run within margin rows of the first does not refuse. (The older spelling --cutover-sequence-margin still works as a deprecated alias.)

## backup

### sluice backup
Take and verify logical backups — full snapshots and incremental chains, optionally encrypted, to local FS or object storage.

Subcommand · Purpose ·

backup full · Take a full snapshot (chain root). ·

backup incremental · Append an incremental onto the existing chain. It streams from the parent manifest's EndPosition, and refuses — "source cannot serve the parent's terminal position (WAL/binlog pruned past it, or the source identity changed); take a fresh full backup" — rather than record an unrelated lineage's changes as the chain's delta. The identity half of that is the v0.137.2 guard: on a mysql-flavor source in file/pos mode the parent's position carries the @@server_uuid it was captured from, and an incremental run against a different instance (replaced, rebuilt, restored, failed over) is refused; the remedy is a fresh backup full. A parent captured before v0.137.2 has no identity to check and proceeds on the binlog-filename check alone, with an UNVERIFIED-INSTANCE-IDENTITY WARN. ·

backup stream run / stop · Run as a long-lived process appending incrementals at a rolling cadence; stop drains the in-flight rollover and exits cleanly. ·

backup verify · Read-only chain check. Re-checksums every chunk against the manifest and reports mismatches; --depth read additionally parses every chunk back through the reader restore uses. ·

backup prune / compact · Retention: drop the oldest segments, or merge consecutive segments whose gaps fall within --merge-window. Compact splits a merge group at a rotation-boundary coverage gap instead of refusing the run (v0.99.41) — chains stopped while the source was idle stay compactable. ·

backup keygen · Generate an Ed25519 signing keypair for --sign-key / --verify-key (ADR-0154 Phase 2): the private key (PKCS#8 PEM, written 0600) signs backups, the public key (SPKI PEM, distributable freely) verifies them. --out-dir DIR writes sluice-sign-key.pem + sluice-verify-key.pem, or name the paths with --priv + --pub (mutually exclusive with --out-dir); --force overwrites — by default keygen refuses to clobber an existing private key (losing/replacing it strands the signing of any chain it already signed). ·

backup export-as-parquet · One-shot, read-only transcode of a backup's row chunks into Parquet for analytics — own section below. ·

Flag · Purpose ·

--output-dir / --target · Destination: a local directory, or a URL (s3://, gs://, azblob://, file:///). Mutually exclusive. ·

--chain-slot · Postgres-only, on backup full: provision the persistent replication slot (named by --slot-name) as the snapshot anchor and ensure the publication, so backup incremental chains with zero gap and no manual slot setup. (v0.99.35) ·

--table-parallelism · Tables read concurrently during the backup sweep (the read-side analog of pg_dump -j); 0 = auto (4). Postgres pins every parallel reader to one shareable exported snapshot; vanilla MySQL coordinates N readers under a brief FTWRL window (v0.99.43, ADR-0088) — both match the serial sweep's cross-table consistency. MySQL falls back to a serial single reader (a loud INFO names why) without RELOAD. (v0.99.39 / v0.99.43) ·

--include-table / --exclude-table · Glob-aware table filters; scope the backup snapshot itself — including the PlanetScale (VStream) snapshot — so an excluded table in a large keyspace is never streamed (v0.99.13), not just what's written. ·

--compression · Per-segment chunk codec: none | gzip | zstd. Default zstd (55–85% faster restore — the DR-critical axis; ~1–5% larger than gzip). none leaves chunks as human-readable .jsonl on a local-FS target. Recorded in lineage.json and read back from there on restore (never inferred from bytes). ·

--encrypt · Enable client-side envelope encryption. Requires exactly one key source (below). The chain rests encrypted; restore / verify / the broker read the same flag to unwrap. ·

--encryption-passphrase-env / --encryption-passphrase-file · Passphrase mode: read the passphrase from an environment variable or a file (preferred over --encryption-passphrase, which lands in shell history). The chain root records the Argon2id params so incrementals and restores re-derive the KEK — operators only remember the passphrase. ·

--kms-key-arn / --gcp-kms-key-resource / --azure-key-vault-id · KMS mode: wrap the CEK through AWS KMS, GCP Cloud KMS, or Azure Key Vault respectively — the root key never leaves the cloud KMS. Mutually exclusive with each other and with the passphrase flags. KMS and passphrase modes can't be mixed within one chain. ·

--sign · Sign the backup manifest + lineage catalog with a detached HMAC-SHA-256 keyed off the chain KEK (ADR-0154 Phase 1). Requires --encrypt with a passphrase (HMAC-off-KEK signs only encrypted chains); extending an already-signed chain signs automatically. Mutually exclusive with --sign-key. ·

--sign-key · Sign with an Ed25519 private key (PKCS#8 PEM — generate a pair with sluice backup keygen), or via a cloud KMS signing key given as kms://<provider>/<key-ref> (aws / gcp / azure — the private key stays in the HSM). Selects the asymmetric scheme over the --sign HMAC default; works on both plaintext and encrypted backups. Accepts a file path, env:VAR, or kms://...; never logged. ·

--verify-key · Read side (restore / backup verify / the broker / export-as-parquet): the public key that verifies an asymmetrically-signed chain — an SPKI PEM file (the offline DR path) or kms://... to fetch the trusted key online. Required for such a chain — the KEK does NOT verify an asymmetric signature, and the recorded manifest key reference is never trusted; verification anchors on the key you name. Absent it, the chain WARNs present-but-unverified and proceeds (DR-safe) unless --require-signature. ·

--require-signature · Strict-always signature policy on restore/verify: a signed chain that cannot be verified (no matching key supplied) is refused rather than warned. An INVALID signature is always refused regardless of this flag. Leave off for the DR-safe default (never fail a restore for a signature it cannot check). ·

--encrypt-mode · per-chain (one content key for the whole chain — one KEK derive or KMS Decrypt per restore) or per-chunk (one content key per chunk — defence in depth, at the cost of a wrap per chunk). Omit it to inherit the chain's existing mode; a fresh full defaults to per-chain. Extending an encrypted chain with the wrong mode is refused, so in practice you set this once, on the chain root. ·

--kms-region / --azure-wrap-algorithm · Provider knobs for KMS mode. --kms-region overrides the AWS region for KMS calls (otherwise AWS_REGION or the SDK's own resolution). --azure-wrap-algorithm overrides the Azure Key Vault wrap algorithm, which defaults to RSA-OAEP-256 and works for software-protected RSA keys — an HSM-backed AES key needs A256KW. Both are accepted by every command that touches an encrypted chain (backup full / incremental / stream run / verify / prune / compact / export-as-parquet, restore, and the from-backup broker). ·

--keyset-source · On backup full, the companion to --redact when a rule uses hash:hmac-sha256 or tokenize:dict — same file: / env: / db: forms as migrate's. Redaction is applied at chunk-write time, so the chain rests PII-clean; a restore reproduces the redacted shape and never re-applies (or undoes) it. ·

--chunk-size · Maximum rows (on full) or changes (on incremental / stream run) per chunk file; the writer rolls over on reaching it. Default 100000. Smaller chunks restore faster — the per-chunk SHA-256 verification fails fast on the smallest possible unit — but inflate the manifest. ·

--since · On incremental / stream run: the BackupID of the parent manifest this run chains off. Empty (default) picks the most recent manifest at the destination. The parent's EndPosition must be one the source can still serve and, on a MySQL file/pos source, one this instance produced — its recorded @@server_uuid is checked against the source's (v0.137.2), so a chain cannot be extended across an instance replacement; take a fresh full instead. ·

--window / --max-changes · backup incremental's two window bounds. --window (default 5m) is the wall-clock duration it streams CDC events for; --max-changes stops after N events, 0 (default) meaning time-bound only. Both are approximate in the same way: transaction framing counts as events (a one-row transaction is three), and the window always extends to the next TxCommit so a chain never ends mid-transaction — and never closes before it has passed the parent's end position. ·

--rollover-window / --rollover-max-changes / --rollover-max-bytes · backup stream run's rollover thresholds — the long-lived process's equivalent of the above; whichever fires first commits the rollover. Defaults: 5m, 100000 events, 64 MiB of buffered chunk bytes. The byte bound is checked at chunk-flush boundaries, so the buffer can transiently exceed it by up to one chunk. ·

--include-empty · On backup stream run: commit a manifest even for a rollover that captured zero changes. Off by default — an idle window adds nothing to the chain, and stream_state.json already covers liveness without polluting it. ·

--rollover-hook · Shell command run after each rollover commits successfully, with SLUICE_ROLLOVER_MANIFEST_PATH, _PARENT_BACKUP_ID, _BACKUP_ID, _CHANGES, _BYTES, and _ELAPSED_MS in the environment — the hook for driving downstream catalog updates or notifications. 30s timeout; a hook error is WARN-logged and never fails the stream. ·

--retain-rotate-at / --retain-rotate-at-chain-length · In-process segment rotation on backup stream run (ADR-0046): cap the open segment and start a fresh one over the same CDC handle once it reaches this age, or once this many incrementals have been committed to it — no operator wrapper, no stream exit. Either threshold firing wins; 0 disables each. Pair with backup prune to bound total disk. ·

--retry-attempts / --retry-backoff-base / --retry-backoff-cap · backup stream run's retry budget for consecutive retriable rollover failures: how many it absorbs before giving up (default 8; 1 disables retry), the base interval (default 100ms, doubling), and the per-interval ceiling (default 30s). Mirrors the sync stream's --apply-retry-* knobs, whose spellings are accepted here as aliases. ·

--keep-incrementals / --keep-duration · backup prune's retention policy — keep at least the N most-recent incrementals, or keep those younger than a duration (168h = 7d, 720h = 30d). Mutually exclusive. Both round up to a segment boundary, because prune retires only whole segments: you always keep more than you asked for, never fewer. ·

--smart-compaction / --smart-compaction-off / --compaction-pk-strategy · backup compact's event-level collapse (ADR-0064): within each merge group's change-chunks, INSERT+UPDATE becomes an INSERT, UPDATE+UPDATE an UPDATE, INSERT+DELETE nothing, UPDATE+DELETE a DELETE. Off by default — opt in when an update-heavy workload makes the CPU cost worth the smaller chain; --smart-compaction-off states that default explicitly, as an audit trail or as the recovery flag after a refuse-loudly on a corrupt PK. The two are mutually exclusive. --compaction-pk-strategy picks the row identity the collapse keys on and has no effect without --smart-compaction: pk (default) uses the declared primary key, replica-identity is a PG-facing alias for pk today, and none disables per-row collapse (a debugging escape hatch). ·

--depth · backup verify's two depths — hash (default) or read. hash re-hashes every chunk's stored bytes against the manifest SHA-256, plus (with --encrypt and the chain's key) the real authenticated open every encrypted chunk gets at restore. read additionally streams every chunk — data and change chunks — through its own real reader and discards the rows, which is the only evidence verify has that is not the artifact it is checking: it catches an over-long row line, a truncated stream, and a wrong recorded codec, all of which hash perfectly and then fail at restore (SLUICE-E-BACKUP-CHUNK-UNREADABLE, the Bug 226 shape). It subsumes the hash depth (the reader hashes as it goes and decrypts at open). It costs one full read + decompress + decrypt + decode per chunk, which is why the cheap depth stays the default for a cron probe against object storage. On an encrypted chain read requires --encrypt + key material and refuses up front without it — parsing is all it does, so it cannot degrade to the key-less depth the way hash can. A parse proves the chunk decodes, not that its values are correct: only sluice verify against the source answers that, and only a test-restore proves the rows apply. Assert the reported Chunks / Decrypted / Depth fields rather than the exit status. ·

--dry-run, -n · On backup prune and backup compact — the two chain-hygiene verbs, which are the only backup subcommands that irreversibly drop history or rewrite the catalog. Prints the plan (which segments would be retired or merged) and exits without touching the chain. Run it first, read the plan, then run for real: prune's retention rounds up to a segment boundary, so the number of incrementals it actually retains is usually larger than the one you asked for, and the dry run is where you see that before it happens rather than after. ·

--rebuild-catalog · backup verify repair mode: rebuild lineage.json from scratch by walking the conventional one-segment layout (manifest.json + manifests/incr-*.json), then exit. For a single-segment backup that was manually mutated. The compression codec is sniffed from the chunk magic bytes; on an encrypted chain also pass --encrypt plus the passphrase / KMS reference, since the codec is sealed inside the envelope. It cannot repair a rotated, multi-segment chain: that sub-directory structure is not reconstructable from a bare walk — lineage.json is the structural record there. ·

--strict-float / --no-float-exact-reread / --float-reread-max-rows · backup full from a VStream (PlanetScale / Vitess) source only. The same single-precision-FLOAT repair described under sync start: by default sluice re-reads FLOAT columns exactly from the source and patches the archived rows, so the backup stores exact float32. The cost is a bounded within-row temporal skew — the FLOAT reflects a read instant just after the snapshot VGTID; it is zero on a quiescent source, and it self-heals on a chain restore because incrementals replay from the full's position forward, so it persists only for a standalone-full restore of a source taking concurrent FLOAT writes. --no-float-exact-reread keeps the rounded-but-perfectly-consistent snapshot for operators who value within-row consistency over FLOAT precision. --strict-float refuses (SLUICE-E-VSTREAM-FLOAT-LOSSY, exit 3) instead of falling back to a WARN for any table that cannot be made exact. --float-reread-max-rows caps the per-table row buffer the repair uses so it stays bounded-memory — 0 (default) means 2,000,000 rows, a few hundred MB worst case; a larger FLOAT-bearing table falls back (WARN, or refusal under --strict-float) rather than buffering. A keyless table keeps the rounding regardless: there is no key to target the re-read. ·

    sluice backup full --source-driver postgres --source ... --target s3://my-bucket/app-chain --chain-slot
    sluice backup incremental --source-driver postgres --source ... --target s3://my-bucket/app-chain

    # signed chain: generate an Ed25519 pair once, sign on write, verify on read
    sluice backup keygen --out-dir ~/.sluice/keys
    sluice backup full --source-driver postgres --source ... --target s3://my-bucket/app-chain \
        --sign-key ~/.sluice/keys/sluice-sign-key.pem
    sluice restore --from s3://my-bucket/app-chain --target-driver postgres --target ... \
        --verify-key ~/.sluice/keys/sluice-verify-key.pem --require-signature

  Full backups are engine-neutral; incremental chains need a CDC source. backup full works against any registered source — including sqlite (a local file) — and the restore/replay side reads the stored chain on any engine pair the restore supports. backup incremental (and the continuous backup stream producer) appends changes since the chain root, so it needs a CDC-capable source — the full set: d1-trigger, mariadb, mysql, planetscale, postgres, postgres-trigger, sqlite-trigger, vitess. A base sqlite source is migrate-only (no CDC), so it can root a full backup but not extend an incremental chain.

  Values that used to break backups (v0.99.40). IEEE-special floats (NaN, ±Infinity) now ride the chunk codec exactly — one such row no longer makes a table un-backupable, and restores are bit-identical to pg_dump.

## backup export-as-parquet

### sluice backup export-as-parquet
One-shot, read-only transcode of an existing backup's row chunks into one zstd-compressed Parquet file per table plus a parquet_index.json export manifest — the analytics exit surface over the chain sluice already captured (ADR-0164).
The export represents one snapshot — the latest full by default, or the full named by --backup-id. Incremental change-windows after that full are not folded in (a loud WARN names the count); operators who need point-in-time state restore the chain and re-export. Exit-only: sluice never reads its Parquet output back — sluice restore keeps the JSON-Lines path. The Parquet files themselves are written plaintext even from an encrypted chain — the analytics destination's encryption posture is a separate operator choice.

Flag · Purpose ·

--from-dir / --from · The backup to export: a local directory (the same one --output-dir wrote to), or a URL (s3://, gs://, azblob://, file:///). One is required; mutually exclusive. ·

--output-dir / --output · Destination for the Parquet files + parquet_index.json: a local directory (created if absent) or a URL (s3://bucket/prefix, gs://, azblob://, file:///). One is required; mutually exclusive. ·

--backup-endpoint / --backup-region / --backup-path-style · S3-compatible-provider overrides (endpoint, region, path-style addressing) — apply to both --from and --output when they are s3:// URLs. ·

--include-table / --exclude-table · Glob-aware table filters (comma-separated, repeatable; mutually exclusive) — export a subset of the snapshot's tables. ·

--backup-id · Export the segment full snapshot with this BackupID instead of the latest one (chain-to-a-point at snapshot granularity; find ids in the chain's manifests or lineage.json). Incremental ids are refused — their change-windows are not exportable. ·

--force-overwrite · Replace a prior export at the destination. By default the command refuses when parquet_index.json is already present. ·

--encrypt + key flags / --verify-key / --require-signature · Read-side encryption + signature flags, mirroring restore: an encrypted chain needs --encrypt + the chain's passphrase / KMS reference; a signed chain is verified (strictly, with --require-signature) before any chunk is decoded. ·

    sluice backup export-as-parquet --from s3://my-bucket/app-chain \
        --output-dir ./warehouse-drop \
        --exclude-table 'audit_*'

  Never a silent narrow: a column type or value with no faithful Parquet representation — a multi-dimensional array, a TIME outside a calendar day (MySQL TIME reaches ±838h), a PG NUMERIC NaN/Infinity, a sub-microsecond timestamp — is refused loudly with SLUICE-E-EXPORT-UNREPRESENTABLE (exclude the table and export the rest, or query that table's JSON-Lines chunks directly — DuckDB reads them natively). The documented string downgrades (unbounded NUMERIC, TIMETZ) carry the exact value text and are WARNs, not refusals.

## restore

### sluice restore
Restore a logical backup chain (full + every incremental up to the tail) into a target database.

Flag · Purpose ·

--from-dir / --from · Backup location: a local directory, or a URL (s3://, gs://, azblob://, file:///). Mutually exclusive. ·

--target-driver / --target · Target engine name and DSN. Accepts any registered engine — a backup taken from one engine can be restored into another (e.g. a MySQL chain into a Postgres target). ·

--table-parallelism · Tables bulk-applied concurrently (the write-side analog of pg_restore -j); 0 = auto (4), works on both engines; incremental change replay stays ordered. (v0.99.39) ·

--bulk-parallelism · Within-table chunk parallelism — a single table's chunks applied concurrently (ADR-0112). 0 = auto: min(8, NumCPU); 1 = serial. Engages only for tables with ≥2 chunks; multiplies with --table-parallelism (table × chunk), with the product bounded by the target connection budget. Applies to chain restores too. ·

--apply-concurrency · Key-hash concurrent-apply lane count for the incremental-replay leg of a chain restore (ADR-0104/0105). The full-restore row load is the bulk COPY (governed by the two parallelism flags above); a chain's incremental change-replay would otherwise run through a single serial stream and stall RTT-bound on a high-latency / cross-region target. 0 (default) = auto:4; 1 = serial; W>1 honored. Exactly-once preserved. No effect on a single-full restore. ·

--target-schema · Postgres-only: land restored tables under a named schema namespace. ·

--encrypt + key flags / --verify-key / --require-signature · Read-side chain unwrapping and signature verification — the same flags the backup write side takes: an encrypted chain needs --encrypt + the chain's passphrase / KMS reference (a mismatched or missing key mode is refused at preflight with SLUICE-E-BACKUP-ENCRYPTION-MISMATCH); an asymmetrically-signed chain needs --verify-key, strict with --require-signature. ·

--planetscale-org · PlanetScale org slug, consumed by both optional PlanetScale integrations — each arms on its own token pair (v0.99.259): (1) target-health telemetry (ADR-0107/0115) clamping the AUTO restore-parallelism product by live headroom — all-or-nothing with the metrics-token pair (--planetscale-metrics-token-id / --planetscale-metrics-token, env-set); (2) the ADR-0148 deploy-request index-build fallback for restore's deferred index phase on a planetscale target — opportunistic, WARN-at-most, arming on the service-token pair (a fallback-only arming never trips the telemetry refusal). Control-plane only, distinct from the data-plane --target DSN; no ambient PLANETSCALE_ORG env binding on this command. Off when unset. ·

--planetscale-database / --planetscale-branch / --planetscale-service-token-id / --planetscale-service-token / --planetscale-deploy-timeout · ADR-0148 index-build fallback inputs — same set and defaults as migrate's (database from the --target DSN, branch main, deadline 1h; service token via env). Before v0.99.259 a restore's walled PlanetScale index build always ended at the SLUICE-E-INDEX-* hint even with credentials available. On timeout the deploy keeps running in PlanetScale and re-running the restore re-probes and rebuilds only what is still missing. ·

--target-tls-ca · CA-pinned verify-ca TLS to a MySQL target (ADR-0158) — see the migrate row. ·

--control-keyspace · MySQL / PlanetScale / Vitess target, chain restores only: the unsharded sidecar keyspace the incremental-replay leg's CDC control tables live in. That leg writes sluice_cdc_state / sluice_cdc_schema_history / sluice_shard_consolidation_lease, and a sharded target rejects those vindex-less tables — point this at a separate unsharded keyspace to unblock it. Omit to auto-detect the sole unsharded sidecar (a loud refusal if there are zero or several candidates). Inert on non-MySQL targets and on a single-full restore, which replays nothing. Full semantics under sync start. ·

    sluice restore --from s3://my-bucket/app-chain \
        --target-driver postgres --target ...

   Pair with sync start --position-from-manifest URL — point it at the chain URL whose terminal manifest's EndPosition becomes the stream's resume position, so CDC picks up from the chain's tail without re-bulking. (PG soft preflight warnings — wal_keep_size sufficiency, Patroni-managed source — fire here; --strict-preflight promotes them to refusals.) On a MySQL source in file/pos mode the chain's tail position also names the @@server_uuid it was captured from (v0.137.2+), so pointing the stream at a replaced or restored instance refuses and cold-starts instead of resuming into an unrelated binlog; a chain whose tail predates v0.137.2 resumes with a UNVERIFIED-INSTANCE-IDENTITY WARN until one fresh full backup re-roots it — see the MySQL resume signals.

   Drive both restore parallelism axes (tables × within-table chunks, product bounded by the target budget):

    sluice restore --from s3://my-bucket/app-chain \
        --target-driver postgres --target ... \
        --table-parallelism 4 --bulk-parallelism 4

   Cross-engine restore (a MySQL backup into a Postgres target): --target-driver accepts any registered engine — the backup's source engine and the restore target need not match.

    sluice restore --from s3://my-bucket/mysql-chain \
        --target-driver postgres --target 'postgres://user:pass@host:5432/app'

## backfill

### sluice backfill
Backfill or transform a column in place — a same-database, keyset-chunked, resumable, online-safe UPDATE. The 'migrate' step of the expand-contract pattern (ADR-0159).
Backfill is single-endpoint — it runs INSIDE one database (no source/target pair), walking the table's primary key in bounded batches and issuing one UPDATE per batch, so no statement ever locks (or hits the statement-time wall of a managed provider on) more than --batch-size rows. The cursor persists in the same database's sluice_migrate_state control tables, so a killed run resumes where it left off — the crash-replay window is at most one chunk, and the replayed chunk is a no-op under a self-describing --where guard. The --set expressions and the --where predicate are native SQL for the --driver engine, emitted verbatim (same-database, so there is no cross-dialect translation to do).

Flag · Purpose ·

--driver · Required. Engine name for the database (mysql, mariadb, planetscale, vitess, or postgres — the engines that implement the in-place backfill surface). SQLite/D1 refuse with SLUICE-E-BACKFILL-UNSUPPORTED-ENGINE (a single-file/edge database doesn't need the online-safety machinery — run the UPDATE directly). ·

--dsn · Required. Database DSN. Backfill is same-database: it reads and updates this one endpoint. ·

--table · Required. Table to backfill. It must have a usable orderable primary key to cursor on — a keyless table (or a JSON/array/geometry PK) refuses with SLUICE-E-BACKFILL-NO-PRIMARY-KEY; there is no flag to force an unbounded whole-table UPDATE. ·

--set · Assignment 'COL = EXPR' applied to every matched row (repeatable; required except with --verify-only). Split at the FIRST =, so expressions may themselves contain =. A --set column that doesn't exist on the table refuses up front with SLUICE-E-BACKFILL-UNKNOWN-COLUMN (the message lists the table's actual columns). ·

--where · Native-SQL predicate scoping which rows are backfilled. Make it self-describing (e.g. new_col IS NULL) so re-runs and crash-resume skip already-done rows. ·

--batch-size · Rows per bounded UPDATE batch (keyset-chunked walk of the primary key). 0 (default) uses sluice's bulk-copy default. ·

--dry-run · Print the generated per-chunk UPDATE statement and an affected-row estimate, then exit without writing anything. ·

--restart · Discard the stored resume cursor for this exact spec (--set/--where) and start over from the beginning of the table. Refused while another run of the same spec looks live (SLUICE-E-BACKFILL-CONCURRENT-RUN) — it would clear the state row out from under the live walker. ·

--verify · After the run completes, count rows still matching --where: 0 prints the safe-to-contract signal; >0 fails with SLUICE-E-BACKFILL-INCOMPLETE (re-run to catch up, then verify again). Requires --where. ·

--verify-only · Skip the walk and just run the --where remaining-count gate (no UPDATEs, no control-table writes) with the same 0 / >0 exit contract — the scriptable post-migration check. Requires --where; --set is optional. ·

    # expand step done (new column exists); backfill it online, then gate the contract step
    sluice backfill --driver planetscale --dsn 'user:pass@tcp(host)/app' --table users \
        --set "full_name = CONCAT(first_name, ' ', last_name)" \
        --where 'full_name IS NULL' \
        --verify

  Resume vs restart. A killed run resumes from the persisted cursor automatically on re-run; a spec whose stored state is already complete needs --restart to walk again (the SLUICE-E-BACKFILL-INCOMPLETE catch-up loop). A cursor persisted by an older sluice whose JSON store mangled binary or >253 integer PK values is refused loudly (SLUICE-E-BACKFILL-CORRUPT-CURSOR) rather than silently skipping PK ranges — re-run with --restart; a self-describing guard makes the re-walk touch only the rows the interrupted run never reached. A second invocation of the same spec while the first is still walking — its state-row heartbeat fresher than 5 minutes, typically an overlapping cron — is refused with SLUICE-E-BACKFILL-CONCURRENT-RUN (v0.99.260): two concurrent walks would interleave cursor writes and break the at-most-one-chunk replay bound. Heartbeat-only, no lease — a kill -9'd run keeps the spec refused for at most one window.

## expand-contract

### sluice expand-contract
Drive the full expand → migrate → contract schema-change pattern on a PlanetScale database: deploy-request the ADD COLUMN, run the online backfill, verify, and (only with --yes) deploy-request the DROP COLUMN (ADR-0162).
This command mutates a production branch. It is PlanetScale-specific by design: it needs the control-plane service token on top of the data-plane DSN, and the production branch must have safe migrations enabled — deploy requests are the mechanism the expand and contract legs ship through. sluice never flips that toggle for you: with safe migrations off it refuses with SLUICE-E-PS-SAFE-MIGRATIONS-DISABLED. The legs: expand creates a sluice dev branch, applies --expand-ddl, and deploys it via a deploy request (sluice's control tables ride inside the same deploy); migrate runs the backfill against the production data with your --set/--where; verify re-counts the --where guard; contract — a destructive DROP COLUMN — runs only after a clean verify and --yes. Without --yes (or without --contract-ddl) the run stops after verify and prints the exact resume command, so the destructive leg is always an explicit second decision.

Flag · Purpose ·

--org · Required (or env PLANETSCALE_ORG). PlanetScale organization slug. ·

--database · Required. PlanetScale database name. ·

--branch · Production branch the pattern targets (deploy requests merge into it; the backfill runs against its data). Default main. ·

--service-token-id / --service-token · PlanetScale service token (branch + deploy-request scopes). Set via the env vars PLANETSCALE_SERVICE_TOKEN_ID / PLANETSCALE_SERVICE_TOKEN (the pscale CLI convention) — never on the command line; never logged. Required except under --dry-run, which makes no control-plane call. ·

--dsn · Required. Data-plane MySQL DSN for the production branch — the migrate (backfill) leg runs inside it. The engine is fixed to planetscale (no --driver to mis-set). ·

--table · Required. Table the pattern operates on. ·

--expand-ddl · Verbatim ADD COLUMN DDL for the expand leg (e.g. ALTER TABLE t ADD COLUMN full_name VARCHAR(255)), applied on a dev branch and shipped via a deploy request. Required unless --resume-from skips the leg. ·

--contract-ddl · Verbatim DROP COLUMN DDL for the contract leg. Optional: without it the run stops after verify with resume instructions. Runs only after a clean verify AND --yes. ·

--set / --where · The backfill assignment(s) (repeatable; native SQL, emitted verbatim) and the self-describing guard (e.g. new_col IS NULL). --where is required: it scopes the backfill AND is the verify gate that authorizes the contract step. ·

--batch-size · Rows per bounded backfill UPDATE. 0 (default) uses sluice's bulk-copy default. ·

--yes, -y · Confirm the contract leg (a destructive DROP COLUMN deploy request). Without it the run stops after verify and prints the exact resume command. ·

--dry-run · Print the full plan — branches, deploy requests, the rendered backfill statement, the gates — without a single control-plane call and without writing anything. ·

--keep-branches · Keep the sluice dev branches instead of deleting them at the end (debugging aid). ·

--resume-from · Leg to continue from after an interrupted run: expand (default, full pattern), migrate (the ADD COLUMN already deployed), contract (the backfill already completed; still re-verifies — --set is optional here). ·

--poll-interval · Deploy-request / branch state polling cadence. Default 10s. ·

--deploy-timeout · Per-deploy-request deadline. Default 1h — large tables deploy via VReplication: real wall-clock, but async and unbounded by errno 3024. A deploy request that outwaits the deadline still un-deployed keeps the dev branch (deleting it would close the still-open deploy request you were just told to approve); the timeout message names the kept branch and the post-close delete recipe (v0.99.260). ·

    export PLANETSCALE_SERVICE_TOKEN_ID=...
    export PLANETSCALE_SERVICE_TOKEN=...
    sluice expand-contract --org acme --database app \
        --dsn 'user:pass@tcp(aws.connect.psdb.cloud)/app?tls=true' --table users \
        --expand-ddl 'ALTER TABLE users ADD COLUMN full_name VARCHAR(255)' \
        --set "full_name = CONCAT(first_name, ' ', last_name)" \
        --where 'full_name IS NULL' \
        --contract-ddl 'ALTER TABLE users DROP COLUMN first_name, DROP COLUMN last_name' \
        --yes

  The SLUICE-E-PS-* refusal family names each failure precisely. SLUICE-E-PS-SAFE-MIGRATIONS-DISABLED (exit 3): safe migrations is off on the branch — enable it in the PlanetScale UI or via pscale branch safe-migrations enable; sluice never auto-enables a production-branch behavior change. SLUICE-E-PS-DEPLOY-REQUEST-FAILED: a deploy request errored, was closed, computed an empty or stranger-touching diff, or outran --deploy-timeout — the message carries the DR number, state, and URL, and a timed-out expand continues with --resume-from migrate. SLUICE-E-PS-BRANCH-STALE-BASE: a fresh PlanetScale dev branch's schema can lag production (observed live: a branch created 14 minutes after a deploy still lacked the deployed column), and a deploy request from a stale base would silently revert newer production schema — sluice gates every dev branch on freshness, self-heals once via an on-demand backup + branch re-create, and raises this only if still stale. Two more pre-deploy gates ship since ADR-0167 (v0.99.258): the deploy request's computed diff is refused if it touches any object the leg never intended (the stale-base phantom-revert signature), and after a review/deploy wait longer than ~2 minutes production's schema is re-verified against the provisioning baseline — refusing SLUICE-E-PS-BRANCH-STALE-BASE if it moved mid-wait.

  Re-running the pattern on a reused database: when the current run's expand leg actually deployed a schema change, the backfill walk restarts even if a prior cycle left a completed marker for the identical --set/--where spec — the self-describing guard scopes the re-walk to unfinished rows; --resume-from migrate still honors mid-walk cursors and completed markers, and standalone sluice backfill is unchanged (v0.99.258).

## deploy-ddl

### sluice deploy-ddl
Ship ONE verbatim DDL statement to a PlanetScale production branch safely, as one command: dev branch (with the stale-base freshness gate), apply the DDL, deploy request, deploy, finalize, cleanup (ADR-0165).
This command mutates a production branch (through PlanetScale's governed deploy-request channel). It replaces five hand-driven pscale commands plus a hazard the operator can't see — a fresh PlanetScale dev branch can silently propose reverting recent production schema (the SLUICE-E-PS-BRANCH-STALE-BASE gate above catches it). It requires safe migrations ON the branch (the deploy-request prerequisite; without safe migrations, direct DDL works and this command is unnecessary). There is no data-plane DSN: the DDL runs on the dev branch via a just-minted branch password. The named consumer is the one-time control-table bootstrap on a safe-migrations branch — control-tables ddl prints the statements to ship.

Flag · Purpose ·

--org · Required (or env PLANETSCALE_ORG). PlanetScale organization slug. ·

--database · Required. PlanetScale database name. ·

--branch · Production branch the deploy request merges into (must have safe migrations enabled). Default main. ·

--service-token-id / --service-token · PlanetScale service token (branch + deploy-request scopes), via env PLANETSCALE_SERVICE_TOKEN_ID / PLANETSCALE_SERVICE_TOKEN; never logged. Required except under --dry-run. ·

--ddl · Required. The single verbatim DDL statement to ship (e.g. CREATE TABLE ... or ALTER TABLE ...), applied on a dev branch exactly as written and deployed via a deploy request. ·

--dry-run · Print the plan — branch name, the DDL, the deploy-request flow — without a single control-plane call and without writing anything. ·

--keep-branches · Keep the sluice dev branch instead of deleting it at the end (debugging aid). ·

--poll-interval · Deploy-request / branch state polling cadence. Default 10s. ·

--deploy-timeout · Deploy-request deadline. Default 1h (large tables deploy via VReplication — async, unbounded by errno 3024). On a timeout with the deploy request still un-deployed the dev branch is kept — deleting it would close the still-open deploy request; the message names the kept branch and the cleanup recipe (v0.99.260). The same ADR-0167 post-wait freshness recheck as expand-contract guards a >2-minute review wait (operator-authored DDL skips only the diff-scope assertion). ·

    # bootstrap sluice's control tables on a safe-migrations branch:
    sluice control-tables ddl            # prints the exact CREATE statements
    sluice deploy-ddl --org acme --database app \
        --ddl 'CREATE TABLE IF NOT EXISTS sluice_migrate_state (...)'   # one statement per run

## control-tables ddl

### sluice control-tables ddl
Print the exact CREATE statements for sluice's own control tables (migrate-state + cdc-state), single-sourced from the engine's definitions — for bootstrapping a target that refuses direct DDL (ADR-0165).
Read-only, needs no credentials and no org/database — output is pure SQL plus -- comment lines, so it pastes or pipes into any governed channel: deploy-ddl (one statement per run), the PlanetScale UI, or a reviewed migration file. On a PlanetScale branch with safe migrations enabled, direct DDL is refused (Error 1105, surfaced as SLUICE-E-PS-DIRECT-DDL-BLOCKED) — sluice's own ensure paths are detect-first, so pre-creating the control tables this way lets migrate / sync / backfill run against the branch without ever needing a direct CREATE.

Flag · Purpose ·

--engine · Engine whose control-table dialect to print. Default planetscale (the bootstrap consumer — safe migrations blocks direct DDL); mysql / vitess print the same dialect. Engines that don't publish their control-table DDL are refused by name. ·

    sluice control-tables ddl                       # planetscale dialect (default)
    sluice control-tables ddl --engine mysql        # same dialect, spelled for vanilla MySQL

## trigger setup / teardown

### sluice trigger setup
Install a trigger-CDC engine's source-side state — slot-less continuous CDC for managed Postgres that blocks logical replication, a local SQLite file, or a live Cloudflare D1.

Flag · Purpose ·

--source-driver · Trigger-CDC engine to install: postgres-trigger (default), sqlite-trigger (a local SQLite file — --dsn is the file path), or d1-trigger (a live Cloudflare D1 over the HTTP query API — --dsn is the d1:// form, token via CLOUDFLARE_API_TOKEN). ·

--dsn · Source DSN to install the trigger state into. A PG DSN for postgres-trigger, a SQLite file path for sqlite-trigger, or the d1:// form for d1-trigger. ·

--tables · Required, comma-separated (repeatable): the tables to install per-table row + truncate triggers on. Empty-list discovery is a follow-up — the command errors if it's unset. ·

--schema · PG schema the change-log + capture function + per-table triggers live in (postgres-trigger only). Defaults to the DSN's schema query parameter (typically public). ·

--allow-polled-fingerprint · Permit the non-superuser polled schema-fingerprint path when event triggers aren't grantable (e.g. Heroku). Default off: the engine refuses loudly so the weaker DDL-detection mode is acknowledged explicitly. ·

--capture-payload · full (default) / changed / minimal — how much of each row the trigger records. ·

--capture-replicated-writes · Install the capture triggers ENABLE ALWAYS so writes applied under session_replication_role = 'replica' are captured &mdash; the native logical-replication subscriber topology: a locked-down primary you can't install anything on → a CREATE SUBSCRIPTION subscriber → sluice trigger-capture → elsewhere (ADR-0185). Since v0.136.0 the posture covers every trigger the install creates &mdash; the per-table row and TRUNCATE pair and both DDL event triggers (sluice_capture_ddl_trg, sluice_capture_drop_trg). Before that the event triggers stayed plain, so replica-role DML was captured while replica-role DDL silently was not; an install created by v0.133.x/v0.134.x with this flag therefore refuses at its next CDC open, naming sluice_capture_ddl_trg, until trigger setup --capture-replicated-writes is re-run (see upgrading an existing install). Default off: plain triggers capture origin writes only, and the replica-role shapes warn at setup and stream open. Refused (SLUICE-E-CDC-TRIGGER-ECHO-LOOP) when the source also carries sluice's own apply bookkeeping (sluice_cdc_state) &mdash; ENABLE ALWAYS triggers would re-capture another sluice sync's applied rows, an echo loop. The enablement posture is recorded and verified at every stream open; postgres-trigger only. The posture is install-wide, and since v0.137.0 setup keeps it that way in both directions. Widening is automatic: a run with the flag that names only some of the install's captured tables also emits ALTER TABLE &hellip; ENABLE ALWAYS TRIGGER for the ones it doesn't name. Narrowing is not: a run without the flag reverts the install to origin-only capture only when it names every captured table &mdash; if any unnamed table's capture trigger is still ENABLE ALWAYS, setup refuses before applying any DDL (--dry-run included) rather than leaving the install half-converted, and prints both runnable repairs: re-run with --capture-replicated-writes, or re-run with the full --tables= list it spells out. ·

--dry-run, -n · Print the DDL the command would apply and exit; no source-side state is modified. ·

    sluice trigger setup --dsn 'postgres://user:pass@host:5432/app' \
        --tables=orders,customers --allow-polled-fingerprint
    # then stream with the trigger engine:
    sluice sync start --source-driver postgres-trigger --source ... --target-driver mysql --target ... --stream-id app

### sluice trigger teardown
Remove every trace of the trigger engine from the source Postgres database — the counterpart to trigger setup. Run it once the stream is finished to leave the source clean.

Flag · Purpose ·

--dsn · Source Postgres DSN to clean up. ·

--tables · Tables whose per-table triggers to drop. Empty (default) discovers every table with a sluice-installed trigger in the active schema. ·

--schema · PG schema; defaults to the DSN's schema query parameter. ·

--keep-data · Retain sluice_change_log (and the meta table) for forensics. Default drops them — the engine's promise is to remove every trace. ·

--dry-run, -n / --yes, -y · Print the DDL and exit / skip the destructive-action confirmation prompt. ·

    sluice trigger teardown --dsn 'postgres://user:pass@host:5432/app' --yes

### sluice trigger prune
Reap durably-applied rows from a trigger-CDC source's sluice_change_log while a sync is live — the capture path never removes consumed rows, so the change-log grows unbounded for the life of a continuous sync (ADR-0137).

Flag · Purpose ·

--source-driver / --source · The trigger-CDC source whose change-log to prune: postgres-trigger (default), sqlite-trigger, or d1-trigger, and the DSN where sluice_change_log lives (a PG DSN, a SQLite file path, or the d1:// form; token via CLOUDFLARE_API_TOKEN). ·

--target-driver / --target · The target engine + DSN the sync applies to — where the durably-applied CDC position lives. prune reads the target's persisted frontier as the only safe lower bound and refuses loudly if it can't read one (it never prunes blind). ·

--stream-id · Required — the same --stream-id the sync uses. Its durable position bounds the prune; prune cross-checks the recorded source fingerprint to refuse a --source/--stream-id mis-pairing. ·

--keep · Safety margin: keep the most-recent N change-log ids below the durable frontier unpruned (default 1000). Belt-and-suspenders — the frontier itself is already durably applied, so even 0 is safe. ·

--vacuum · After pruning, VACUUM to reclaim file space — sqlite-trigger / d1-trigger only (Postgres relies on autovacuum). Off by default; VACUUM rewrites the whole database. ·

--schema · PG source schema holding sluice_change_log (postgres-trigger only); defaults to the DSN's schema parameter. ·

--dry-run, -n · Compute and print the prune bound without deleting anything. ·

  The correctness crux: a change-log row is pruned only if its id is at or below the watermark the applier has persisted to the target. The exactly-once contract advances that watermark only on durable apply, so the target's persisted position is the durably-applied frontier — pruning on the source's MAX(id), the read cursor, or a TTL would delete not-yet-applied rows and cause silent permanent loss on the next warm-resume. Run it periodically against a live trigger-CDC sync (especially d1-trigger, where change-log growth and per-write billing both matter):

    # preview the bound, delete nothing
    sluice trigger prune --source-driver sqlite-trigger --source ./app.db \
        --target-driver postgres --target 'postgres://user:pass@host:5432/app' \
        --stream-id app --dry-run

    # reap durably-applied rows, keeping a 1000-id margin, then reclaim space
    sluice trigger prune --source-driver sqlite-trigger --source ./app.db \
        --target-driver postgres --target 'postgres://user:pass@host:5432/app' \
        --stream-id app --keep 1000 --vacuum

## schema preview / diff

### sluice schema preview · diff
Inspect translation without moving data: print the target DDL sluice would emit, or diff a live target against what sluice would produce.

    sluice schema preview --source-driver mysql --source ... --target-driver postgres
    sluice schema diff    --source-driver mysql --source ... --target-driver postgres --target ...

Flag · Purpose ·

--include-view / --exclude-view / --skip-views · Scope which views are previewed / diffed (comma-separated, repeatable, glob-aware; include and exclude are mutually exclusive). --skip-views drops views from the comparison entirely — the flag for a target whose views are managed out-of-band, where view drift isn't sluice's concern. Same spellings as migrate's. ·

--ignore-charset-collation · schema diff only: suppress MySQL charset / collation differences, which operators often manage out-of-band via server defaults rather than per-column. ·

--ignore-extras · schema diff only: suppress "extra on target" findings — tables, columns, and indexes present on the target but absent from the source. Use it when the target legitimately hosts other applications' tables, so the diff reports only what sluice would have to change. ·

--enable-pg-extension · Same extension passthrough opt-in as migrate's (vector, pg_trgm, hstore, citext) — pass the same set you intend to migrate with, or the preview / diff will show the loud-failure default instead of the shape you'll actually get. ·

--redact / --keyset-source · schema preview only: annotate which columns your --redact rules would hit, so you can see the plan before committing to it. Each affected column's CREATE TABLE line gains a trailing -- REDACTED via <strategy> comment; the DDL itself is unchanged, since redaction transforms values, not types. --keyset-source takes the same forms as on migrate. ·

## verify

### sluice verify
Compare data integrity between source and target — row counts by default, escalating to sampled or full per-row hashing.

Flag · Purpose ·

--depth · How thorough: count (default — per-table row-count comparison) or sample (counts + per-table sampled-row content hashes; ~99% confidence on a 5%+ corruption rate). A full per-row hash mode is planned, not yet shipped. ·

--sample-rows-per-table / --sample-seed · Sampling size and a deterministic seed. ·

--strict-hash · Require byte-identical per-row hashes. ·

--format / --output · Report format and output destination (for CI gating). ·

    sluice verify --source-driver mysql --source ... --target-driver postgres --target ... --depth count
    sluice verify --source-driver mysql --source ... --target-driver postgres --target ... --depth sample

## matview refresh

### sluice matview refresh
Refresh PostgreSQL materialized views on the target (PG-only). Handy as a scheduled job after a sync catches up.

    sluice matview refresh --target-driver postgres --target ... \
        --matview daily_totals --target-schema reporting

   --matview takes bare matview names (comma-separated, repeatable) that match pg_matviews.matviewname case-sensitively; the schema is named separately with --target-schema (default public). Omit --matview to refresh every matview in the schema. Add --concurrently to emit REFRESH MATERIALIZED VIEW CONCURRENTLY (requires a unique index on the matview; readers stay live).

## slot list / drop

### sluice slot list · drop
Manage source-side Postgres replication slots — list sluice-created slots, or drop an orphaned one left by an interrupted stream.

    sluice slot list --source-driver postgres --source ...
    sluice slot drop --source-driver postgres --source ... --slot-name sluice_slot --if-exists

   slot drop --if-exists treats a missing slot as success rather than an error — the form to use in teardown scripts and re-runnable playbooks, where the slot may already be gone.

## diagnose

### sluice diagnose
Assemble an operator bundle (source/target capability + role state, debug-zip shape) to attach when filing an issue.

    sluice diagnose --source-driver mysql --source ... --target-driver postgres --target ... --out ./sluice-diagnose.zip

   --privacy decides what goes in the bundle, and ADR-0056 holds the full inclusion/exclusion contract. basic is state-table dumps only — no version, no DSN, no logs. standard (the default here) adds redacted CLI args, the sluice version, engine health probes, capabilities, and target-health telemetry. verbose adds a per-table COUNT(*) on the target — a slow path on large tables — plus the last 200 lines of the file named by --log-file. That log path is sluice's own slog output file; empty (the default) means no log is included at any level. Note the auto-on-crash form of this bundle (--diagnose-on-crash-dir) deliberately defaults to basic instead, because nobody is present to review what it wrote.

   Supply the five PlanetScale telemetry flags — --planetscale-org, --planetscale-metrics-token-id / --planetscale-metrics-token (env), --planetscale-metrics-db (defaults to the --target DSN's database), --planetscale-metrics-branch (default main) — to add a target-health metrics snapshot (CPU/mem/storage/lag) to the bundle. Control-plane credential, distinct from --target. See sync start for the same flag semantics.

## metrics-watch

### sluice metrics-watch
Standalone PlanetScale control-plane metrics daemon — poll a database's CPU/mem/storage/lag on an interval and fire threshold alerts, with no migration or sync attached. Opens NO connection to the database itself; reads only the PlanetScale metrics API.

Flag · Purpose ·

--engine · Required: mysql | postgres | planetscale | vitess — picks the PlanetScale metric vocabulary for the watched database. No DB connection is opened. ·

--planetscale-org · Required. Org slug whose metrics endpoint the watch reads. Control-plane only. ·

--planetscale-metrics-token-id / --planetscale-metrics-token · Service-token (read_metrics_endpoints) ID + secret. Set via the env vars PLANETSCALE_METRICS_TOKEN_ID / PLANETSCALE_METRICS_TOKEN — never on the command line. ·

--planetscale-metrics-db · Required — the database to watch (there is no --target DSN to derive it from), unless --fleet replaces it. ·

--fleet / --fleet-concurrency · Watch the whole org instead of one database: every database + branch the org's metrics service discovery returns, fanned out on the same cadence. Mutually exclusive with --planetscale-metrics-db. --fleet-concurrency bounds how many per-branch scrapes run at once each poll (default 4, max 16) — the knob for keeping the fan-out's load on the PlanetScale metrics API in hand. ·

--include-database / --exclude-database · --fleet mode only (ADR-0180) — scope the org-wide fan-out to a subset. Each takes a glob (comma-separated, repeatable), matched against both database and database/branch, so --include-database 'app-*' and --exclude-database '*/dev' both work. They combine, and exclude wins when a database matches both. Note the value domain differs from migrate's same-named table filters: these are PlanetScale database/branch globs, not table names. ·

--sink-file / --sink-file-max-bytes / --sink-file-max-files · Append every polled sample to a rotating JSONL file, one record per line — opt-in durable storage for a portal or warehouse with no Prometheus involved. Rotation size defaults to 64 MiB (0 selects that default; a negative value disables rotation and you own the file's growth), keeping 5 generations by default (PATH.1 … PATH.N). Advisory: a write failure is logged and swallowed, never stalling the poll. ·

--sink-http · POST each polled sample batch as JSON to an endpoint — the same record schema as --sink-file. Treated as a credential: set it via the SLUICE_METRICS_SINK_HTTP env var. Advisory and failure-isolated. ·

--planetscale-metrics-branch · Branch to filter the series to (default main). ·

--interval · Poll / print cadence (default 60s — the PlanetScale metrics granularity). ·

--once · Poll a single sample, print / evaluate it, and exit (the one-shot mode for scripts). ·

--quiet · Suppress the per-poll live line; emit only threshold alerts (the alert-only-daemon shape). ·

--metrics-listen · Also serve a Prometheus /metrics endpoint re-exporting the watched database's CPU/mem/storage/lag as the sluice_target_* gauge family — turning the daemon into a standalone PlanetScale-metrics exporter. Ignored with --once. ·

--notify-* · The telemetry-backed alerter set — --notify-webhook / --notify-slack sinks (env SLUICE_NOTIFY_WEBHOOK / SLUICE_NOTIFY_SLACK) and the --notify-storage-util / --notify-cpu-util / --notify-mem-util / --notify-lag-seconds / --notify-storage-growth-per-min thresholds + --notify-cooldown — identical semantics to sync start, including the whole --notify-smtp-* email-relay family. (The target-probe rules — sync lag and the v0.99.288 vacuum advisories — live on sync start only; the daemon holds no database connection.) ·

  Run as an alert-only daemon (tokens via env; fire on 85% storage):

    export PLANETSCALE_METRICS_TOKEN_ID=...
    export PLANETSCALE_METRICS_TOKEN=...
    sluice metrics-watch --engine planetscale --planetscale-org acme --planetscale-metrics-db app \
        --notify-storage-util 0.85 --notify-slack "$SLACK_URL" --quiet

---
Canonical page: https://sluicesync.com/docs/commands/ · Full docs index: https://sluicesync.com/llms.txt
