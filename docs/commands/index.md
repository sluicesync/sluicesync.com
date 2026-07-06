# Command reference

> Every sluice command, its purpose, the flags that matter most, and worked examples.

The general shape is sluice <command> [flags]. Every command accepts the
global flags (--config, --log-level, …).
Run sluice <command> --help for the complete flag list — the tables below cover the
flags you'll reach for most.

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

  Nine engines are registered today: mysql (binlog CDC), planetscale and self-hosted vitess (both VStream CDC), postgres (logical-replication CDC), sqlite and d1 (migrate sources — sqlite is also a target — no CDC), and the trigger-CDC engines postgres-trigger (slot-less Postgres), sqlite-trigger (local SQLite file), and d1-trigger (live Cloudflare D1). The vitess flavor shares the PlanetScale engine code with a self-hosted-vtgate capability set, and warm-resumes since v0.99.44.

Engine · Role · Notes ·

sqlite · migrate source (file or .sql dump) and target · Pure-Go modernc.org/sqlite, no CGO. Imports a binary .db or an auto-detected wrangler d1 export .sql dump into Postgres / MySQL; as a target emits a .db (decimals byte-exact as TEXT). Migrate only (no CDC). ·

d1 · migrate source (live, lossless) · Reads a live Cloudflare D1 over its HTTP query API (token via CLOUDFLARE_API_TOKEN); per-column typeof() + CAST(… AS TEXT) / hex() projection makes integers above 253 and BLOBs round-trip exactly, and reads don't take D1 offline (ADR-0132). ·

sqlite-trigger · CDC source · Trigger-based continuous sync from a local SQLite file: per-table AFTER triggers + a sluice_change_log watermark for exactly-once resume (ADR-0135). ·

d1-trigger · CDC source · The same trigger-CDC design over a live D1's HTTP query API (ADR-0136). ·

  WAN-fast MySQL CDC apply (ADR-0139/0140). Against a MySQL / PlanetScale-MySQL target, consecutive same-shape INSERTs fold into one multi-row INSERT … ON DUPLICATE KEY UPDATE, UPDATEs apply as that same keyed upsert, and DELETEs coalesce into one DELETE … WHERE pk IN (…) — turning N round trips into one so high-latency / cross-region apply keeps up. A rate-limited INFO line (rows_per_stmt) reports the coalescing ratio so you can see whether it's helping.

  Rich types over continuous CDC. Continuous sync now carries the types that earlier only cold-started: PostgreSQL arrays (int4[], text[], numeric[], …, multi-dimensional preserved), MySQL ENUM and SET, MySQL→PG and PG→PG ENUM, and PostGIS geometry (every subtype/dimension, SRID preserved) — all over the CDC apply path, in both source directions (v0.99.50–v0.99.60). PostGIS geography, arrays of geometry (geometry[]), and arrays of enum (enum[]) remain loudly refused over CDC — no silent loss.

## migrate

### sluice migrate
Run a one-time schema + data migration: translate the schema, create tables, bulk-copy rows, then build indexes and constraints.

Flag · Purpose ·

--source-driver / --source · Source engine name and DSN (or SLUICE_SOURCE). ·

--target-driver / --target · Target engine name and DSN (or SLUICE_TARGET). ·

--dry-run, -n · Print the plan; don't touch the target. ·

--include-table / --exclude-table · Glob-aware table filters (mutually exclusive). Scope the bulk copy — including the PlanetScale (VStream) snapshot — not just the write path. ·

--include-database / --exclude-database / --all-databases · Multi-database fan-out (ADR-0074, MySQL source): migrate several source databases in one run, each to a same-named target namespace. Glob-aware; system databases (information_schema, mysql, …) are always excluded. When any database-scope flag is set the source DSN's database is optional (it's a server connection). ·

--include-schema / --exclude-schema / --all-schemas · Multi-schema fan-out (ADR-0075, Postgres source): the PG-source synonyms of the -database family. System schemas (pg_catalog, information_schema, …) are always excluded. MySQL source uses the -database spelling, PG source uses -schema; supplying both spellings in one invocation is a hard error. ·

--map-database / --map-schema · SRC=DST — rename a namespace on the way (ADR-0142, repeatable). Without it a fan-out lands each source namespace in a same-named target; this routes SRC to a differently-named DST (snapshot and CDC). --map-database for a MySQL source, --map-schema for a Postgres source (same rule as the fan-out spellings). The rename is engine-side only — source-keyed --redact / --type-override still match on the original name. ·

--allow-degraded-fks · PG-target only: tolerate a dirty FK source — when ADD CONSTRAINT FOREIGN KEY fails on orphan rows (SQLSTATE 23503), retry as NOT VALID and surface the degraded constraint at the end (run VALIDATE CONSTRAINT after fixing the orphans). Default off (loud failure on a dirty source). MySQL has no per-constraint NOT VALID and refuses loudly if this is set against a MySQL target. ·

--resume, -r · Resume a failed migration from per-table checkpoints on the target. ·

--bulk-parallelism · Parallel reader/writer pairs per large table (0 = auto, 1 = off). Since v0.99.64 (ADR-0096) within-table chunking covers single non-integer PKs (UUID/string/binary/decimal/temporal) and all-orderable composite PKs via sampled-keyset chunking — not just single-integer PKs. Tables with no usable PK (or a non-orderable PK column like JSON/array/geometry) still take the single-reader path. ·

--bulk-parallel-min-rows · Row-count threshold below which a table is copied with a single reader/writer pair regardless of --bulk-parallelism. 0 = auto (base 80000, dialled down on many-table schemas). ·

--table-parallelism · Tables copied concurrently (0 = auto: 4, 1 = off). Multiplies with --bulk-parallelism; the product is bounded by the target connection budget. ·

--max-target-connections · Connection budget on the target the parallelism product must fit inside. ·

--index-build-parallelism · Postgres-only: deferred indexes built concurrently after the bulk copy. ·

--type-override · TABLE.COLUMN=TYPE — force a target column type (repeatable). ·

--redact · Redact a PII column, e.g. users.email=hash:sha256 (repeatable). ·

--infer-types · SQLite / D1 source only (ADR-0144): opt-in, data-validated promotion of conservatively-typed columns to native target types — INTEGER→boolean, ISO-8601 TEXT→timestamptz/timestamp, JSON TEXT→jsonb, UUID TEXT→uuid — but only after an exhaustive aggregate over the actual data confirms every value qualifies; otherwise the column keeps its safe type. Mixed-offset / sub-µs temporal columns and non-UUID *_id values stay text, never silently coerced. An explicit --type-override always wins. Off by default. Against a live D1, auto-engages --stage-local (below). ·

--stage-local / --no-stage-local · Cloudflare D1 source only (ADR-0145, v0.99.167): first replicate the live D1 into a byte-faithful local SQLite file (verbatim DDL + exact storage classes, integers above 253 included — lossless, unlike wrangler d1 export), then migrate from that file. Sidesteps D1's HTTP query limits (the per-query CPU ceiling and the GLOB pattern-complexity limit that block --infer-types on a live D1). Auto-engaged by --infer-types against a D1 source; set --stage-local explicitly to stage without inference, or --no-stage-local to force the direct path. The staged file is created in the system temp dir and removed when the migrate finishes. Mutually exclusive. ·

--include-orm-tables / --skip-orm-tables · ORM bookkeeping tables (Rails schema_migrations, Prisma _prisma_migrations, Drizzle __drizzle_*, Laravel migrations, Flyway, Goose, …) carry the source engine's migration state, which is meaningless on a different target engine. On a cross-engine migrate they're skipped by default, each skip announced by name; --include-orm-tables copies them anyway. A same-engine run keeps them (the history is still valid) unless you pass --skip-orm-tables. The two flags are mutually exclusive. ·

--target-schema · Postgres-only: land tables under a named schema namespace. ·

--inject-shard-column · NAME=VALUE — ADR-0048 Shape A: inject a sluice-managed discriminator column on a consolidated target so per-shard rows from a multi-shard Vitess source land disjoint via a composite PK. Each per-shard run passes a distinct VALUE. ·

--allow-cross-shard-merge · Opt out of the cross-shard-collision preflight (Bug 152). Off by default the guard is active: a multi-shard Vitess/PlanetScale source without --inject-shard-column refuses to merge into a single PK/UNIQUE target. Pass this only when the key is globally unique across shards. ·

--reset-target-data · Destructive recovery: drop source-schema tables on the target, then cold-start. Prompts (type reset) unless --yes. Mutually exclusive with --resume. ·

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

--slot-name · Postgres replication-slot suffix (default sluice_slot); set per-instance to run several streams off one source. ·

--apply-batch-size · CDC changes per target tx, or auto. Default auto (v0.99.44, ADR-0089): the AIMD latency controller adapts the batch size within [1, ceiling] to a p95 target for >10× throughput over single-row apply. Ceilings: 1000 mysql/postgres, 100 planetscale. Pass =1 for the conservative one-change-per-tx behavior. Tables with no usable identity key (no PK, no unique index) are never batched — each such change commits alone. ·

--no-auto-tune · Disable the AIMD controller. --apply-batch-size=N then becomes a strictly static row cap (floor stays 1) instead of an adaptive ceiling. For workloads where you've hand-tuned the batch size and want no auto-adaptation. ·

--apply-concurrency · CDC apply lane count W (ADR-0104/0105/0106; engine-general — MySQL and Postgres). The merged change stream is fanned across W in-order lanes by primary-key hash (same key → same lane → applied in source order, so dependent INSERT→UPDATE→DELETE never reorder), each lane committing concurrently on its own connection with its own AIMD batch controller. 0 (default, unset) = auto:N — the new fast-by-default adaptive concurrent path: Postgres min(4, slot-budget), MySQL/PlanetScale a fixed 4. 1 = explicit serial opt-out (byte-identical to the pre-fast-by-default behaviour). W>1 honored verbatim. Exactly-once for keyed tables (the position advances only to a boundary durable across all lanes). An in-lane PlanetScale tx-killer (MySQL) or serialization/deadlock (Postgres) is recovered in-lane — split-and-retried idempotently, no stream restart. ·

--schema-changes · forward (default, ADR-0091) auto-applies unambiguous source DDL — ADD/DROP/ALTER COLUMN, CREATE/DROP INDEX, ADD/DROP/MODIFY CHECK — on the target so the sync stays online through schema evolution. refuse restores the conservative pre-v0.92 behavior: any source DDL surfaces loudly with the drained-model recovery hint. RENAME COLUMN and a computed/volatile DEFAULT on ADD COLUMN always refuse loudly. See the warn box below. ·

--copy-fanout-degree · VStream/CDC snapshot cold-start (PlanetScale-MySQL target) only, ADR-0097: WRITE-side fan-out — the incoming snapshot row stream is PK-hash-partitioned out to N concurrent batched-INSERT writers, each on its own connection, to beat the single round-trip-bound INSERT connection vtgate forces. 0 = auto: 4; 1 = serial. Bounded by the target connection budget. ·

--no-auto-resnapshot · Opt out of the automatic re-snapshot when a resume hits a purged/invalid source position (v0.99.51, ADR-0093). By default a resume from a position older than the source's retained binlogs — routine on PlanetScale's retention window — auto-recovers with a fresh cold-start re-snapshot; with this flag set, sluice instead fails loudly with the recovery commands named, so a full re-snapshot of very large tables is a deliberate choice. ·

--inject-shard-column · NAME=VALUE — ADR-0048 Shape A discriminator column for consolidating a multi-shard Vitess source onto one target (per-shard streams pass distinct VALUEs). See the migrate row. ·

--allow-cross-shard-merge · Opt out of the cross-shard-collision preflight (Bug 152) — see the migrate row. Off by default the guard is active. ·

--metrics-listen · Bind a Prometheus /metrics + /readyz endpoint, e.g. :9090. Exports sluice_build_info, a Go-runtime block, and — when PlanetScale telemetry is configured (below) — the sluice_target_* CPU/mem/storage/lag gauge family. See /metrics export. ·

--position-from-manifest · URL of a backup chain (s3://, gs://, azblob://, file:///) whose terminal manifest's EndPosition becomes this stream's resume position — resume CDC from a restored chain's tail without re-bulking. Bypasses the persisted sluice_cdc_state position. PG soft preflight warnings fire here; --strict-preflight promotes them to refusals. (Mutually exclusive with --restart-from-scratch / --reset-target-data.) ·

--planetscale-org · PlanetScale org slug — enables OPTIONAL target-health telemetry (CPU/mem/storage/lag) read from the PlanetScale metrics endpoint (ADR-0107). A control-plane credential, distinct from the data-plane --target DSN. Feeds proactive apply back-off and the sluice_target_* gauges. Opt-in and all-or-nothing: setting the org without both token flags is a loud refusal. Off when unset (default sync unchanged). ·

--planetscale-metrics-token-id / --planetscale-metrics-token · PlanetScale service-token (granted read_metrics_endpoints) ID + secret for --planetscale-org telemetry. Set via the env vars PLANETSCALE_METRICS_TOKEN_ID / PLANETSCALE_METRICS_TOKEN — never on the command line; masked in all logging. ·

--planetscale-metrics-db / --planetscale-metrics-branch · Database (defaults to the --target DSN's database) and branch (default main) the telemetry series is filtered to. Only consulted when --planetscale-org is set. ·

--suppress-target-metrics-history · Disable persisting polled target-health metrics to the sluice_target_metrics_history table (7-day retention, pruned). History is on by default when telemetry is configured; it lets sluice diagnose show the recent CPU/mem/storage/lag trend without scripting the metrics API. Advisory + failure-isolated — never affects the sync. ·

--notify-webhook / --notify-slack · Threshold-alert sinks (also accepted by metrics-watch): a generic webhook (JSON POST) and/or a Slack incoming-webhook. Set the URLs via the env vars SLUICE_NOTIFY_WEBHOOK / SLUICE_NOTIFY_SLACK. Advisory + failure-isolated (a dead sink is logged-and-swallowed); require --planetscale-org telemetry plus at least one threshold below. ·

--notify-storage-util / --notify-cpu-util / --notify-mem-util · Alert when the target's storage / CPU / memory utilisation (a fraction 0–1, used/capacity) is at or above the threshold. Edge-triggered + cooldown'd. 0 disables a rule. ·

--notify-lag-seconds / --notify-storage-growth-per-min · Alert when replica lag (seconds) is at or above the value, or when storage utilisation is climbing at or above this fraction-of-capacity per minute (a pre-grow early warning, e.g. 0.02 = +2%/min). 0 disables. ·

--notify-cooldown · Minimum interval between re-fires of a still-breached alert (default 15m) — a sustained breach reminds at most once per interval, not every poll. ·

--apply-retry-attempts · Max consecutive retriable apply failures absorbed before exiting (ADR-0038, default 8 — tuned for managed-Vitess tx-killer transients). 1 = no retry. The counter resets whenever the persisted CDC position advances. ·

--apply-retry-backoff-base / --apply-retry-backoff-cap · Exponential backoff between retriable apply failures: base 100ms (doubling), capped at 30s. Only consulted when --apply-retry-attempts > 1. ·

--apply-exec-timeout · Per-statement deadline on every apply-path ExecContext (default 60s). Closes the silent-stall mode where a half-closed target connection blocks the apply goroutine inside the driver; on expiry the batch is retried on a fresh connection. 0 disables (unbounded). ·

--source-heartbeat-interval · Write a heartbeat row on the source every interval so the slot/binlog can't be evicted past the consumer against an idle source. ·

--dry-run, -n · Show cold-start vs warm-resume and the planned actions without starting. ·

--schema-already-applied · Skip all cold-start DDL (you promise the target catalog matches). For Atlas/Liquibase-managed or PlanetScale Safe-Migrations targets. ·

--include-table / --exclude-table · Glob-aware table filters (mutually exclusive). Scope the cold-start snapshot and its resume — including the PlanetScale (VStream) snapshot, so an excluded table in a large keyspace is never streamed (v0.99.12–v0.99.13), not just the write path. ·

--force-cold-start · Skip the pre-flight check that refuses to bulk-copy into a populated target. Use with caution — an INSERT into a non-empty table can collide on the primary key. Still warm-resumes from a persisted position (it only skips the check); ignored on the warm-resume path. ·

--reset-target-data · Destructive recovery: delete the CDC-state row, DROP every source-schema table on the target, then run a fresh cold-start. For a wedged-state recovery (e.g. slot-missing fall-through). Prompts (type reset) unless --yes. See ADR-0023. ·

--restart-from-scratch · Force a fresh cold-start re-copy from the beginning, ignoring any persisted resume position (incl. a mid-COPY cursor) — without dropping the target (the idempotent copy absorbs the overlap). For a bad checkpoint. Differs from --force-cold-start (keeps the position) and --reset-target-data (drops tables). (v0.99.10) ·

  Source DDL auto-applies by default (v0.99.45, ADR-0091). A running stream now forwards unambiguous source schema changes onto the target automatically — including a destructive DROP COLUMN, which drops the column (and its data) on the target. This keeps the sync online through routine schema evolution, but it means a source DDL change propagates without operator review. To gate DDL through a separate change-management process, start the stream with --schema-changes=refuse — any source DDL then surfaces loudly instead of applying. (The older --forward-schema-add-column flag is deprecated: it warns and still forwards, subsumed by the new default.)

  Mid-stream reshard is followed automatically (v0.99.62, ADR-0094). A PlanetScale/Vitess source reshard (shard split/merge, MoveTables) used to halt the sync as a loud terminal error. The Streamer now reopens onto the new shard layout from the journal-stamped GTIDs and continues with no gap and no re-snapshot. (Not yet auto-followed when --inject-shard-column is engaged — that interplay keeps the prior loud-terminal behavior.)

  Multi-table Vitess keyspaces cold-copy in one command (v0.99.63, ADR-0095). A full Vitess/PlanetScale keyspace now cold-copies in a single sync start at bounded memory — the engine auto-shards the VStream COPY by table internally, so there's no per-table --include-table workaround. On by default for a fresh multi-table cold-start; opt out with vstream_copy_single_stream=true in the source DSN (see Source-DSN tuning parameters).

  The apply path is adaptive-concurrent by default (v0.99.100+, ADR-0106). With --apply-concurrency unset, CDC apply fans out across an auto-chosen number of PK-hash lanes (Postgres min(4, slot-budget); MySQL/PlanetScale 4) — exactly-once for keyed tables, with per-lane AIMD and in-lane tx-killer/deadlock recovery. To force the old strictly-serial apply, pass --apply-concurrency 1.

  Resilient on managed / PlanetScale targets (no flags needed). sluice automatically rides PlanetScale storage-grow and primary-reparent serving transitions without operator intervention — across cold-copy writes, cold-copy source reads, the coordinated grow-gate, restore reconciliation, and (new in v0.99.118) the post-copy DDL phase (index / constraint / view build). Transient errors during a transition are bounded-retried and loud only on genuine exhaustion.

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

## sync status / stop / health

### sluice sync status · stop · health
Inspect, gracefully stop, and health-check a running stream. All take --stream-id plus the target connection.

- sync status — show the stream's persisted position and phase.

- sync stop — request the stream to drain in-flight changes and exit cleanly. By default it just files the stop request and returns; pass --wait / -w to block until the running streamer drains and clears its stop signal (with --timeout, default 5m; on timeout the CLI exits non-zero and the stop request remains in place). Use --wait to coordinate ALTER windows or scripted teardowns.

- sync health — probe freshness against thresholds and return a cron-friendly exit code (non-zero when stale).

    sluice sync stop   --stream-id app-prod --target-driver postgres --target ... --wait --timeout 10m
    sluice sync health --stream-id app-prod --target-driver postgres --target ... \
        --max-stale-seconds 300   # exit non-zero if the last apply was more than 5 minutes ago

   sync health's freshness check is --max-stale-seconds N (target-side wall-clock seconds since the last apply; 0 = informational only). When you also pass --source-driver + --source the probe reads the source position too and, on a PG→PG pair, exposes --max-lag-bytes N (source LSN bytes ahead of target; MySQL GTID sets aren't byte-distance comparable). Both exit 1 when breached — cron-friendly.

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

    sluice cutover --config sluice.yaml --cutover-sequence-margin 1000

   Run after the snapshot has caught up and just before switching application traffic to the target.

## backup

### sluice backup
Take and verify logical backups — full snapshots and incremental chains, optionally encrypted, to local FS or object storage.

Subcommand · Purpose ·

backup full · Take a full snapshot (chain root). ·

backup incremental · Append an incremental onto the existing chain. ·

backup stream run / stop · Run as a long-lived process appending incrementals at a rolling cadence; stop drains the in-flight rollover and exits cleanly. ·

backup verify · Re-checksum every chunk in a chain and report mismatches. ·

backup prune / compact · Retention: drop the oldest segments, or merge consecutive segments whose gaps fall within --merge-window. Compact splits a merge group at a rotation-boundary coverage gap instead of refusing the run (v0.99.41) — chains stopped while the source was idle stay compactable. ·

Flag · Purpose ·

--output-dir / --target · Destination: a local directory, or a URL (s3://, gs://, azblob://, file:///). Mutually exclusive. ·

--chain-slot · Postgres-only, on backup full: provision the persistent replication slot (named by --slot-name) as the snapshot anchor and ensure the publication, so backup incremental chains with zero gap and no manual slot setup. (v0.99.35) ·

--table-parallelism · Tables read concurrently during the backup sweep (the read-side analog of pg_dump -j); 0 = auto (4). Postgres pins every parallel reader to one shareable exported snapshot; vanilla MySQL coordinates N readers under a brief FTWRL window (v0.99.43, ADR-0088) — both match the serial sweep's cross-table consistency. MySQL falls back to a serial single reader (a loud INFO names why) without RELOAD. (v0.99.39 / v0.99.43) ·

--include-table / --exclude-table · Glob-aware table filters; scope the backup snapshot itself — including the PlanetScale (VStream) snapshot — so an excluded table in a large keyspace is never streamed (v0.99.13), not just what's written. ·

--compression · Per-segment chunk codec: none | gzip | zstd. Default zstd (55–85% faster restore — the DR-critical axis; ~1–5% larger than gzip). none leaves chunks as human-readable .jsonl on a local-FS target. Recorded in lineage.json and read back from there on restore (never inferred from bytes). ·

--encrypt · Enable client-side envelope encryption. Requires exactly one key source (below). The chain rests encrypted; restore / verify / the broker read the same flag to unwrap. ·

--encryption-passphrase-env / --encryption-passphrase-file · Passphrase mode: read the passphrase from an environment variable or a file (preferred over --encryption-passphrase, which lands in shell history). The chain root records the Argon2id params so incrementals and restores re-derive the KEK — operators only remember the passphrase. ·

--kms-key-arn / --gcp-kms-key-resource / --azure-key-vault-id · KMS mode: wrap the CEK through AWS KMS, GCP Cloud KMS, or Azure Key Vault respectively — the root key never leaves the cloud KMS. Mutually exclusive with each other and with the passphrase flags. KMS and passphrase modes can't be mixed within one chain. ·

    sluice backup full --source-driver postgres --source ... --target s3://my-bucket/app-chain --chain-slot
    sluice backup incremental --source-driver postgres --source ... --target s3://my-bucket/app-chain

  Full backups are engine-neutral; incremental chains need a CDC source. backup full works against any registered source — including sqlite (a local file). backup incremental appends changes since the chain root, so it needs a CDC-capable source: Postgres / MySQL natively, or the trigger-CDC engines for SQLite / D1 (sqlite-trigger / d1-trigger). A base sqlite source is migrate-only (no CDC), so it can root a full backup but not extend an incremental chain.

  Values that used to break backups (v0.99.40). IEEE-special floats (NaN, ±Infinity) now ride the chunk codec exactly — one such row no longer makes a table un-backupable, and restores are bit-identical to pg_dump.

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

    sluice restore --from s3://my-bucket/app-chain \
        --target-driver postgres --target ...

   Pair with sync start --position-from-manifest URL — point it at the chain URL whose terminal manifest's EndPosition becomes the stream's resume position, so CDC picks up from the chain's tail without re-bulking. (PG soft preflight warnings — wal_keep_size sufficiency, Patroni-managed source — fire here; --strict-preflight promotes them to refusals.)

   Drive both restore parallelism axes (tables × within-table chunks, product bounded by the target budget):

    sluice restore --from s3://my-bucket/app-chain \
        --target-driver postgres --target ... \
        --table-parallelism 4 --bulk-parallelism 4

   Cross-engine restore (a MySQL backup into a Postgres target): --target-driver accepts any registered engine — the backup's source engine and the restore target need not match.

    sluice restore --from s3://my-bucket/mysql-chain \
        --target-driver postgres --target 'postgres://user:pass@host:5432/app'

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

## schema preview / diff

### sluice schema preview · diff
Inspect translation without moving data: print the target DDL sluice would emit, or diff a live target against what sluice would produce.

    sluice schema preview --source-driver mysql --source ... --target-driver postgres
    sluice schema diff    --source-driver mysql --source ... --target-driver postgres --target ...

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
    sluice slot drop --source-driver postgres --source ... --slot-name sluice_slot

## diagnose

### sluice diagnose
Assemble an operator bundle (source/target capability + role state, debug-zip shape) to attach when filing an issue.

    sluice diagnose --source-driver mysql --source ... --target-driver postgres --target ... --out ./sluice-diagnose.zip

   Supply the five PlanetScale telemetry flags — --planetscale-org, --planetscale-metrics-token-id / --planetscale-metrics-token (env), --planetscale-metrics-db (defaults to the --target DSN's database), --planetscale-metrics-branch (default main) — to add a target-health metrics snapshot (CPU/mem/storage/lag) to the bundle. Control-plane credential, distinct from --target. See sync start for the same flag semantics.

## metrics-watch

### sluice metrics-watch
Standalone PlanetScale control-plane metrics daemon — poll a database's CPU/mem/storage/lag on an interval and fire threshold alerts, with no migration or sync attached. Opens NO connection to the database itself; reads only the PlanetScale metrics API.

Flag · Purpose ·

--engine · Required: mysql | postgres | planetscale | vitess — picks the PlanetScale metric vocabulary for the watched database. No DB connection is opened. ·

--planetscale-org · Required. Org slug whose metrics endpoint the watch reads. Control-plane only. ·

--planetscale-metrics-token-id / --planetscale-metrics-token · Service-token (read_metrics_endpoints) ID + secret. Set via the env vars PLANETSCALE_METRICS_TOKEN_ID / PLANETSCALE_METRICS_TOKEN — never on the command line. ·

--planetscale-metrics-db · Required — the database to watch (there is no --target DSN to derive it from). ·

--planetscale-metrics-branch · Branch to filter the series to (default main). ·

--interval · Poll / print cadence (default 60s — the PlanetScale metrics granularity). ·

--once · Poll a single sample, print / evaluate it, and exit (the one-shot mode for scripts). ·

--quiet · Suppress the per-poll live line; emit only threshold alerts (the alert-only-daemon shape). ·

--metrics-listen · Also serve a Prometheus /metrics endpoint re-exporting the watched database's CPU/mem/storage/lag as the sluice_target_* gauge family — turning the daemon into a standalone PlanetScale-metrics exporter. Ignored with --once. ·

--notify-* · The full alerter set — --notify-webhook / --notify-slack sinks (env SLUICE_NOTIFY_WEBHOOK / SLUICE_NOTIFY_SLACK) and the --notify-storage-util / --notify-cpu-util / --notify-mem-util / --notify-lag-seconds / --notify-storage-growth-per-min thresholds + --notify-cooldown — identical semantics to sync start. ·

  Run as an alert-only daemon (tokens via env; fire on 85% storage):

    export PLANETSCALE_METRICS_TOKEN_ID=...
    export PLANETSCALE_METRICS_TOKEN=...
    sluice metrics-watch --engine planetscale --planetscale-org acme --planetscale-metrics-db app \
        --notify-storage-util 0.85 --notify-slack "$SLACK_URL" --quiet

---
Canonical page: https://sluicesync.com/docs/commands/ · Full docs index: https://sluicesync.com/llms.txt
