<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# Migrate MySQL → Postgres

> The flagship first migration: connect, preview the plan, copy the data, and verify it landed.

A one-shot migrate translates the source schema, creates the target tables, bulk-copies the rows, then builds indexes and constraints — in that order, so the bulk load runs against constraint-free tables and finishes fast. This guide walks MySQL → Postgres end to end, but the same shape works in all four directions (just swap the --source-driver / --target-driver pair). Reach for migrate when you can take a short write-freeze on the source; if you need a zero-downtime cutover, run the continuous-sync flow instead — but even then a clean migrate is the fastest way to learn how sluice translates your schema.

Before a production cutover, freeze writes on the source (or accept that rows written during the copy won't be captured — migrate is a point-in-time copy, not a stream). To keep writes flowing throughout, use continuous sync.

## 1. Point sluice at both databases

Source and target are each a driver name plus a DSN. Because DSNs carry credentials, pass them through the environment to keep them out of your shell history:

    export SLUICE_SOURCE='root:rootpw@tcp(localhost:3306)/app'
    export SLUICE_TARGET='postgres://postgres:pgpw@localhost:5432/app?sslmode=require'

    sluice engines      # confirm 'mysql' and 'postgres' are registered

The MySQL DSN is user:pass@tcp(host:3306)/dbname; the Postgres DSN is a postgres:// URL. See Configuration for every engine's DSN format.

## 2. Dry-run the plan first

--dry-run (-n) reads the source schema and prints exactly what sluice would do — tables, row estimates, the translated types — without touching the target. Always do this first:

    sluice migrate \
        --source-driver mysql    --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --dry-run

For the actual target DDL sluice will emit — column by column, with cross-engine translation notes — use schema preview. That's where you'll catch a type you want to steer with --type-override before any data moves.

## 3. Run the migration

When the plan looks right, drop --dry-run:

    sluice migrate \
        --source-driver mysql    --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET"

sluice copies each table, then builds secondary indexes and constraints in deferred phases. On large schemas it copies several tables at once and splits big tables into parallel chunks automatically — see --table-parallelism / --bulk-parallelism in the migrate reference if you want to tune the connection budget.

Cold-start safety. sluice refuses to bulk-copy into a non-empty target by default — an INSERT into a populated table would collide on the primary key. That refusal is the safety net, not an error to suppress: it means the target already has data. Start from an empty target, or see the recovery flags below.

## 4. If it's interrupted, resume

Migration state is checkpointed per table on the target. If a run dies partway (network blip, OOM, Ctrl-C), re-run the identical command with --resume (-r) and it continues from the last committed checkpoint rather than starting over:

    sluice migrate \
        --source-driver mysql    --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --resume

To deliberately start clean over an already-populated target, --reset-target-data drops the source-schema tables on the target and re-copies. At a terminal it prompts for a typed reset confirmation unless you add --yes; run from a script, a CI job or an agent — any non-terminal stdin — it refuses with SLUICE-E-CONFIRMATION-REQUIRED (exit 3) before touching either database, so --yes is required in automation. It's mutually exclusive with --resume.

## 5. Verify the copy

Once the migration finishes, confirm source and target agree. verify compares per-table row counts by default and returns a non-zero exit code on any mismatch (CI-friendly):

    sluice verify \
        --source-driver mysql    --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --depth count

For content checking — not just counts — escalate to --depth sample (per-table sampled-row content hashes; ~99% confidence on a 5%+ corruption rate). See the validate guide for the depth ladder.

## Migrating legacy MySQL data?

sluice forces a strict sql_mode on every MySQL connection to close the silent-clamp / silent-zero-date class of corruption. Data that was only storable under a relaxed mode — pre-5.7 zero-dates (0000-00-00), silently-truncated values — will refuse loudly rather than land subtly wrong. That's deliberate. Two knobs let you decide how to carry it:

- --zero-date=null carries zero/partial dates as NULL (refused on a NOT NULL column), or --zero-date=epoch substitutes 1970-01-01.

- --mysql-sql-mode='' (explicit empty) falls through to the server's default sql_mode for the broadest legacy tolerance — plus NO_AUTO_VALUE_ON_ZERO, which sluice adds to the live session and reads back on every MySQL connection whatever the mode (v0.156.11+; a server that refuses it is refused with NO-AUTO-VALUE-ON-ZERO-UNSET).

Both are global flags — see Configuration for the full discussion.

### Session time zone: DSN-TIME-ZONE-NOT-UTC

sluice reads and writes every MySQL TIMESTAMP as a UTC instant, which is only correct when the session's time_zone is UTC, so it sets time_zone='+00:00' on every connection. Since v0.156.5, a MySQL, MariaDB, PlanetScale or Vitess DSN whose time_zone parameter names any other zone is refused at connect with an error marked DSN-TIME-ZONE-NOT-UTC. It carries no SLUICE-E- code, so it exits 1. Every spelling of UTC is accepted ('+00:00', 'UTC', 'Etc/UTC', 'GMT' and the like, quoted or URL-encoded), and the variable name is matched the way MySQL reads it (TIME_ZONE=, @@session.time_zone=, @@local.time_zone=, …). A GLOBAL spelling (@@global.time_zone=) is refused whatever its value, because it would change the zone for every client of the server, and SYSTEM is refused because the host's zone cannot be known from the DSN. As a second, independent check, every new connection reads back its own @@session.time_zone and is refused with the same marker unless it is UTC.

If a DSN of yours carried a non-UTC time_zone on v0.8.0 through v0.156.4, sluice honoured it but still read the session's digits as UTC, silently, at exit 0. Every TIMESTAMP a migrate or sync cold copy read from such a source, and every one written into such a target (bulk copy, LOAD DATA, the CDC applier, restore), is off by the zone's offset — measured under '+09:00', a stored 12:00Z read back as 21:00Z. DATETIME columns and values that arrived through the binlog change stream were not shifted. Remedy: remove the parameter (or set it to '+00:00'), then re-copy the affected tables, or correct their TIMESTAMP columns by the offset with CONVERT_TZ. A configuration that ran on v0.156.4 can stop here on upgrade, including a CDC-only stream whose values were never shifted.

---
Canonical page: https://sluicesync.com/docs/migrate-mysql-to-postgres/ · Full docs index: https://sluicesync.com/llms.txt
