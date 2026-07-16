# Configuration

> Connection strings, environment variables, the YAML config file, and the global flags every command shares.

## Connection strings

Every data-moving command takes a source and target driver + DSN:

Engine · Driver name · DSN format ·

MySQL · mysql · user:pass@tcp(host:3306)/dbname ·

Postgres · postgres · postgres://user:pass@host:5432/dbname?sslmode=require ·

PlanetScale · planetscale · MySQL DSN against the PlanetScale host (TLS required). ·

Vitess (self-hosted) · vitess · MySQL DSN against vtgate — the self-hosted Vitess flavor (VStream CDC; warm-resume since v0.99.44). ·

SQLite · sqlite · A file path (./app.db) or a wrangler d1 export .sql dump (auto-detected). Migrate source and target (no CDC). ·

Cloudflare D1 · d1 · d1://<account_id>/<database_id> (or d1://<database_id> + CLOUDFLARE_ACCOUNT_ID); token via the env var CLOUDFLARE_API_TOKEN (never a flag). Migrate source. ·

Postgres (slot-less) · postgres-trigger · Same as postgres; pairs with trigger setup. ·

SQLite / D1 (CDC) · sqlite-trigger / d1-trigger · Trigger-based continuous CDC over a SQLite file / live D1; pair with trigger setup --source-driver. ·

## Environment variables

Keep credentials out of your shell history by passing DSNs via the environment:

Variable · Equivalent flag ·

SLUICE_SOURCE · --source ·

SLUICE_TARGET · --target ·

## YAML config file

For anything beyond a handful of flags, pass a YAML file with --config / -c. CLI flags take
precedence over config values. Common keys:

    # sluice.yaml
    include_tables: ["app_*"]
    exclude_tables: ["app_audit"]

    # force target column types (CLI: --type-override)
    mappings:
      - column: products.attrs
        type: jsonb
        binary: true

    # replace generated-column bodies verbatim (CLI: --expr-override)
    expression_mappings:
      - column: orders.total_cents
        expression: "(price_cents * qty)"

    # PII redaction (CLI: --redact)
    redactions:
      - rule: users.email=hash:sha256
      - rule: users.ssn=mask:ssn

    # dictionaries referenced by tokenize:dict / randomize:dict strategies
    dictionaries:
      first_names:
        values: ["Alex", "Sam", "Jordan"]

Then run, for example:

    sluice migrate -c sluice.yaml --source-driver mysql --source ... --target-driver postgres --target ...

## Global flags

These apply to every command:

Flag · Default · Purpose ·

--config, -c · — · Path to a YAML config file. ·

--log-level, -l · info · Verbosity: debug / info / warn / error. ·

--log-format · text · text or json — one JSON object per line, for Loki / Datadog / CloudWatch ingestion of a long-running sync. (v0.99.31) ·

--pprof-listen · off · Bind net/http/pprof at an address to diagnose stalls (e.g. :6060). ·

--mysql-sql-mode · strict · Override sluice's forced strict sql_mode. Pass '' (empty) to migrate legacy MySQL data with zero-dates. ·

--zero-date · error · How to carry MySQL zero / partial dates (0000-00-00, YYYY-00-DD, YYYY-MM-00): error refuses loudly naming the column; null carries them as NULL (itself refused on a NOT NULL column); epoch substitutes 1970-01-01. A silent-loss-class control — the default is the safe one. ·

--sqlite-date-encoding · iso · How a SQLite / D1 source decodes columns declared date/time (SQLite has no native temporal storage): iso reads ISO-8601 TEXT; unixepoch / unixmillis read INTEGER/REAL unix seconds/milliseconds; julian reads a REAL/INTEGER Julian day. A value whose storage class doesn't match is refused loudly naming the row — never a silently-wrong date (use --type-override <col>=text to carry an outlier raw). Per-source override: ?sqlite_date_encoding=… on the source DSN. ·

--stage-dir · system temp · Directory for sluice's large scratch files: the csv/tsv/ndjson staged SQLite copy (roughly the source file's size), the D1 --stage-local replica, and the backup export-as-parquet per-table scratch. Override on hosts whose /tmp is a small tmpfs — the ADR-0145 hazard class. The directory must already exist (a missing path is refused loudly). Env: SLUICE_STAGE_DIR. (The sqlite .sql-dump materialize path does not honor it yet.) (v0.99.259) ·

--max-memory · off · Soft ceiling on the Go heap (e.g. 2GiB, 512MiB), applied via SetMemoryLimit at startup to bound RSS. Unlike --max-buffer-bytes (raw buffered bytes only), this bounds the whole heap. Honors the GOMEMLIMIT env var when unset. (v0.99.10) ·

--version, -V · — · Print version and exit. ·

Migrating legacy MySQL data? sluice forces a strict sql_mode on every MySQL connection to close the silent-clamp / silent-zero-date class. Data that was only accepted under a relaxed mode (pre-5.7 zero-dates, silently-truncated values) will refuse loudly — pass --mysql-sql-mode='' to fall through to the server default. Zero / partial dates specifically are governed by --zero-date (default error): use --zero-date=null to carry them as NULL or --zero-date=epoch to substitute 1970-01-01 rather than refusing.

## Source-DSN tuning parameters

A handful of throughput / observability knobs are passed as query parameters on the source DSN rather than as CLI flags — they are engine-specific and parsed inside the engine, so they're stripped before reaching the database session. Append them to the source connection string (e.g. ...&vstream_copy_table_parallelism=4).

Parameter · Applies to · Purpose ·

copy_table_parallelism=N · native MySQL source · ADR-0101/0102 (v0.99.70–71): cold-copy N tables concurrently under one FTWRL window, each a consistent-snapshot reader. Composes with --copy-fanout-degree for W&times;D total write concurrency. Absent / 0 / 1 = the serial single-snapshot path. Falls back to serial (loud WARN) without the RELOAD privilege. ·

vstream_copy_table_parallelism=K · VStream (PlanetScale / Vitess) source · ADR-0099/0100 (v0.99.67/69): open K concurrent COPY streams over a disjoint table partition for the cold-copy. Absent / 0 / 1 = serial. Not auto-clamped into the connection-budget preflight — the operator must keep K &times; D &le; --max-target-connections (sluice WARNs naming the contract). ·

vstream_copy_single_stream=true · VStream source · ADR-0095 (v0.99.63): opt out of the auto-shard VStream COPY and restore the legacy single interleaved stream (and its ADR-0071 memory-refusal floor). Auto-shard is on by default for a fresh cold-start of more than one table. ·

vstream_idle_warn_timeout=DUR · VStream source · v0.99.43: tune the idle-stall WARN that fires when the source is alive (heartbeats flowing) but sending no change events — the throttled-or-idle signal. Default 30s; 0 disables the WARN only (the hard liveness/progress guards are unaffected). ·

## Prometheus /metrics export

Pass --metrics-listen ADDR to sync start (or metrics-watch) to bind a Prometheus-format /metrics endpoint (plus /readyz on sync start) for the life of the process. Beyond the stream's apply/throughput counters it exports:

- sluice_build_info{version,commit,go_version} — a constant-1 gauge carrying the build metadata.

- A Go-runtime block — sluice_go_goroutines, sluice_go_gomaxprocs, heap (sluice_go_memstats_heap_*), and GC stats.

- The sluice_target_* gauge family — target CPU / memory / storage utilisation and replica lag — when PlanetScale telemetry is configured (--planetscale-org + the metrics-token flags). Without telemetry these gauges are simply absent.

## What sluice creates in your databases

To make migrations resumable and continuous sync durable, sluice writes a small, predictable set of sluice_-prefixed bookkeeping objects — state tables on the target, and a replication slot / publication / triggers on the source. They're excluded from schema diff and verify, so they never look like drift. For the full inventory — what each object is, when it appears, and how to remove it — see Objects sluice creates.

---
Canonical page: https://sluicesync.com/docs/configuration/ · Full docs index: https://sluicesync.com/llms.txt
