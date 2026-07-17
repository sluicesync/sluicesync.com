# Supported directions

> Every source → target pair sluice can move, for one-shot migrate and for continuous sync — and which pairs each surface does not cover.

sluice moves data between database engines through two surfaces: migrate (a one-shot schema + data copy) and sync (continuous change-data-capture). A "direction" is just a source engine → target engine pair. Which pairs are supported differs between the two surfaces, because migrate and sync have different engine roles — a few engines can be read continuously but not written to, and a couple can only ever be a source. The authoritative, always-current list for the binary in your hand is sluice engines; this page is the operator-facing summary of what those roles add up to.

    sluice engines   # lists every engine built into this binary and its role (migrate / CDC, source / target)

## Migrate — one-shot copy

Migrate reads a source once and writes a fresh copy into a target. Every migrate source copies to every migrate target — the cell is never "unsupported", only "faster" on the same-engine diagonal. Cross-engine pairs flow through the typed IR; same-engine pairs take an optimized path but the same fidelity.

Source ↓  /  Target → · MySQL · MariaDB · PlanetScale / Vitess · Postgres · SQLite ·

MySQL · ✓ a · ✓ · ✓ b · ✓ · ✓ ·

MariaDB · ✓ · ✓ a · ✓ b · ✓ · ✓ ·

PlanetScale / Vitess · ✓ · ✓ · ✓ b · ✓ · ✓ ·

Postgres · ✓ · ✓ · ✓ b · ✓ c · ✓ ·

SQLite (file / .sql dump) · ✓ · ✓ · ✓ b · ✓ · ✓ ·

Cloudflare D1 (live) · ✓ · ✓ · ✓ b · ✓ · ✓ ·

CSV / TSV / NDJSON (file, csv/tsv/ndjson) · ✓ · ✓ · ✓ b · ✓ · ✓ ·

mydumper / pscale dump (directory, mydumper) · ✓ · ✓ · ✓ b · ✓ · ✓ ·

a same-engine MySQL or MariaDB uses the native LOAD DATA LOCAL INFILE loader (a MariaDB target falls back to batched multi-row INSERT per table on local_infile=OFF servers and geometry-bearing tables).   b a PlanetScale / Vitess target blocks LOAD DATA LOCAL, so cold-copy falls back to batched multi-row INSERT (use the planetscale / vitess engine name, not mysql, against a Vitess-backed host).   c same-engine Postgres byte-pipes the native COPY stream — the raw-copy fast lane — when there's no transform to apply. See How sluice copies your data for which internal path each cell takes.

MariaDB is a MySQL-family flavor. Use the mariadb engine name (not mysql) against a MariaDB server — sluice fingerprints the server and steers you if they're mismatched. Its migrate cells match the mysql column/row; the one place it diverges from vanilla MySQL is on continuous sync (domain-GTID binlog, below) and a handful of catalog conventions covered in the MariaDB field notes.

Targets are MySQL, MariaDB, PlanetScale / Vitess, Postgres, or SQLite. Cloudflare D1 is a migrate source only (read live over its HTTP API), never a migrate target. The flat-file engines — csv, tsv, ndjson (each staged byte-exact into a temp SQLite database; file conventions declared with the --csv-* flags, never sniffed — ADR-0163) and mydumper (a mydumper / pscale database dump directory, ADR-0161) — are migrate sources only. Plain mysqldump / pg_dump .sql dumps are deliberately not parsed (loud refusal with a scratch-server recipe). The trigger-CDC engines (postgres-trigger, sqlite-trigger, d1-trigger) are sync-only and don't appear here.

## Sync — continuous change-data-capture

Sync does an initial snapshot, then streams every subsequent change from the source until you cut over. It has more sources than migrate — including three trigger-based engines for platforms that can't hand out a native replication feed — but fewer targets: changes are only ever applied to a MySQL-family (MySQL, MariaDB, PlanetScale / Vitess) or Postgres target.

Source ↓  /  Target → · MySQL · MariaDB · PlanetScale / Vitess · Postgres ·

MySQL — binlog · ✓ · ✓ · ✓ · ✓ ·

MariaDB — binlog / domain-GTID d · ✓ · ✓ · ✓ · ✓ ·

PlanetScale / Vitess — VStream · ✓ · ✓ · ✓ · ✓ ·

Postgres — replication slot · ✓ · ✓ · ✓ · ✓ ·

Postgres — slot-less (postgres-trigger) · ✓ · ✓ · ✓ · ✓ ·

SQLite — sqlite-trigger · ✓ · ✓ · ✓ · ✓ ·

Cloudflare D1 — d1-trigger · ✓ · ✓ · ✓ · ✓ ·

d A MariaDB source streams its native binlog, parsing MariaDB's domain-based GTIDs (e.g. 0-100-38) and resuming off them — a distinct format from MySQL's GTIDs, and one MariaDB won't let you pre-check for reachability (the stream itself is the only honest signal; see the field note). Native uuid/inet6/inet4 columns decode faithfully through CDC (v0.99.272).

SQLite and D1 are sync sources, not sync targets. A continuous stream from SQLite or D1 runs through the sqlite-trigger / d1-trigger engines (the plain sqlite / d1 engines have no CDC); a stream never lands into SQLite or D1. For managed Postgres that can't grant a replication slot (Heroku, some RDS/Supabase tiers), postgres-trigger is the slot-less source path.

## The four MySQL ↔ Postgres directions

The combination sluice was built for — the fully bidirectional MySQL ↔ Postgres matrix — is every cell where both sides are one of those two engines, and all four work in both migrate and sync:

- MySQL → Postgres and Postgres → MySQL — cross-engine, through the IR (type translation, value-fidelity checks, PII redaction, overrides).

- MySQL → MySQL and Postgres → Postgres — same-engine, nothing to translate; the native loader / raw-COPY fast lane applies on migrate.

PlanetScale, self-hosted Vitess, and MariaDB are all MySQL-dialect flavors, so anywhere this page says "MySQL" as a direction, they slot into the same cell — you just pick the matching engine name. PlanetScale / Vitess use VStream and batched-insert instead of binlog and LOAD DATA; MariaDB uses the vanilla-MySQL binlog and loader path, differing only in its domain-GTID stream format and a few catalog conventions (the MariaDB field notes cover them).

## Next steps

- How sluice copies your data — the internal path (IR vs raw fast lane) each direction takes, and why the fast lane never trades correctness for speed.

- Command reference: engines — the per-engine role table (bulk-load / CDC capabilities, DSN shapes) this page summarizes.

- Getting started — connect a source and target and run your first migrate.

- Import SQLite or Cloudflare D1 — the SQLite / D1 source specifics end to end.

---
Canonical page: https://sluicesync.com/docs/supported-directions/ · Full docs index: https://sluicesync.com/llms.txt
