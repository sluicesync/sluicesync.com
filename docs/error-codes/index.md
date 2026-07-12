# Error codes & exit codes

> The stable SLUICE-E-* error codes and the process exit-code contract — a greppable branching surface for scripts, log pipelines, and agents driving the CLI.

sluice's error messages have always named the remedy in prose — "pass --zero-date=null", "use --resume". Prose is a poor branching surface for scripts, log pipelines, and AI agents driving the CLI, so every error class that carries an operator hint also carries a stable error code: a frozen SLUICE-E-<DOMAIN>-<SLUG> identifier machines can match exactly. The human-facing message is unchanged; the code and a concise remedy ride along as metadata.

A SLUICE-E-* code in sluice's output is stable and greppable — once shipped, the string is frozen (renaming or removing one is a breaking change), and it maps deterministically to an exit code (2 for a config error, 3 for a named refusal). The registry in internal/sluicecode is the single source of truth, and a unit test enforces that it matches this table in both directions. Codes are minted only for errors that already carry an operator hint — it is deliberately not a catalogue of every possible error.

Where the metadata surfaces: under the global --log-format json flag a terminal coded error emits one ERROR record with code, hint, and err attributes (text-format logging shows the same record in slog's text shape); the exit code lets a caller distinguish "sluice refused and named the remedy — retrying won't help" from a generic runtime failure without parsing anything.

## Exit codes

sluice historically exited 0 on success and 1 on everything else. The taxonomy below keeps those two meanings stable and carves two classes out of the generic-failure bucket, so nothing that checks != 0 changes behaviour.

Exit code · Meaning ·

0 · Success. For verify, diff, and sync-health: success and clean. ·

1 · Generic runtime failure. For verify/diff/sync-health this is those commands' long-standing per-command meaning: the check ran and found a mismatch / drift / stale stream. ·

2 · Config error: the --config file could not be loaded or parsed. (The read-side commands verify/diff/sync-health/metrics-watch have always used 2 more broadly for "the check could not run at all".) ·

3 · Named refusal: sluice declined to proceed (or to silently alter a value) and named the remedy — the refusal-class codes below. Retrying without acting on the hint fails identically. ·

80 · Usage error: kong (the CLI parser) exits 80 on unknown flags/commands and missing required arguments, before any sluice code runs. sluice adopts this rather than remapping it. ·

Backward compatibility. Scripts and unit files that check exit != 0 (including a systemd Restart=on-failure) are unaffected — every failure class is still non-zero. Scripts that check exit == 1 specifically should be updated: config errors and named refusals that previously exited 1 now exit 2 and 3.

## Error codes

The class drives the exit code: a terminal refusal exits 3, a terminal runtime code exits 1 like any other failure — the code is in the log record either way.

Code · Class · Meaning · Remedy ·

SLUICE-E-CONNECT-REFUSED · runtime · The database host/port is unreachable from this machine. · Verify the DSN host/port and network reachability. ·

SLUICE-E-CONNECT-AUTH-FAILED · runtime · The database rejected the DSN credentials. · Verify the DSN username and password. ·

SLUICE-E-CONNECT-DATABASE-MISSING · runtime · The DSN names a database that does not exist on the server. · Verify the DSN database name. ·

SLUICE-E-BULKCOPY-TARGET-TABLE-MISSING · runtime · Bulk-copy hit a missing target table — schema-apply failed or wrote into a different schema. · Check the schema-apply phase's output and the target schema/database the DSN points at. ·

SLUICE-E-BULKCOPY-TABLE-FAILED · runtime · A table failed mid-bulk-copy; earlier tables have data but not their declared secondary indexes yet (the indexes phase runs after all tables finish copying). · Fix the offending table and continue with --resume, or skip it with --exclude-table=<name>. ·

SLUICE-E-SCHEMA-PERMISSION-DENIED · runtime · The target role lacks CREATE on the schema. · GRANT the privilege or use a different role. ·

SLUICE-E-INDEX-STATEMENT-TIME-LIMIT · runtime · A post-copy index build hit PlanetScale's statement-time limit (MySQL errno 3024); the data is already copied. · --resume finishes just the indexes with no re-copy (grow the cluster first for a faster build), or start fresh with --upfront-indexes. ·

SLUICE-E-INDEX-DIRECT-DDL-DISABLED · runtime · PlanetScale safe-migrations is enabled on the target branch and blocks direct DDL (errno 1105). · Disable safe-migrations on the branch for the migration; sluice does not yet drive PlanetScale deploy requests. ·

SLUICE-E-CDC-REPLICATION-PERMISSION · runtime · The connecting role lacks the REPLICATION attribute. · ALTER ROLE x REPLICATION; see Prepare a Postgres source. ·

SLUICE-E-COLDSTART-TARGET-NOT-EMPTY · refusal · Cold-start refused: a target table already contains data (usually a previous run died mid-copy). · Sync: re-run with --reset-target-data --yes. Migrate: use --resume. Either mode: --force-cold-start to copy into the populated table anyway (collides on PRIMARY KEY in most cases). ·

SLUICE-E-SCHEMA-EXTENSION-NOT-ENABLED · refusal · A column's type is owned by a PostgreSQL extension the operator has not opted into. · Pass --enable-pg-extension <ext>; see Type mapping. ·

SLUICE-E-VALUE-ZERO-DATE · refusal · A MySQL zero/partial date (0000-00-00 …) has no valid calendar value the target can hold. · Pass --zero-date=null or --zero-date=epoch to carry it. ·

SLUICE-E-VALUE-NUL-BYTE · refusal · A string value carries a NUL byte (0x00), which PostgreSQL text types cannot store. · Clean the source data, or map the column to bytea with --type-override COL=bytea. ·

SLUICE-E-EXPR-BACKSLASH-LITERAL · refusal · A SQLite expression's string literal contains a backslash (or a double-quoted token), which MySQL would silently reinterpret under its default sql_mode. · Rewrite the expression on the SQLite source, or re-create it on the MySQL target post-migration. ·

SLUICE-E-CONFIRMATION-REQUIRED · refusal · A destructive command was run without --yes. sluice is non-interactive and never prompts, so it refuses loudly instead of blocking (slot drop is the current caller). · Re-run with --yes (or -y) to confirm the destructive operation. ·

SLUICE-E-DRIVER-HOST-MISMATCH · refusal · The chosen driver cannot drive the DSN's host — today: the vanilla mysql driver pointed at a PlanetScale endpoint (*.connect.psdb.cloud), whose binlog CDC and LOAD DATA cold-copy Vitess blocks. Caught up front, before any connection. · Pass --source-driver planetscale / --target-driver planetscale for the PlanetScale endpoint. ·

SLUICE-E-VALUE-UNREPRESENTABLE · refusal · A source value has no representable target-type equivalent, so sluice refuses before the driver rather than corrupt it or retry-loop on a misleading server error — today: a NaN/±Infinity float into a MySQL FLOAT/DOUBLE (MySQL has no non-finite floats), or an infinity/pre-Gregorian (BC) Postgres timestamp into a fixed-width target. · Filter or transform the source value (e.g. NULLIF / CASE on the source query). ·

SLUICE-E-BACKUP-MANIFEST-INVALID · refusal · At restore or broker apply, a manifest's recorded BackupID does not match the id recomputed from its content (created_at/source_engine/kind/EndPosition, plus the CDC-position flag on FormatVersion 8) — a corrupt or lazily-edited manifest, caught before any data lands. A corruption backstop, not tamper-proofing; sign chains for that. · Restore from an untampered copy, or sign the chain (--sign + --require-signature). ·

---
Canonical page: https://sluicesync.com/docs/error-codes/ · Full docs index: https://sluicesync.com/llms.txt
