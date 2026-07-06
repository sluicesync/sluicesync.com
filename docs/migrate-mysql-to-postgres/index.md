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

To deliberately start clean over an already-populated target, --reset-target-data drops the source-schema tables on the target and re-copies (it prompts for a typed reset confirmation unless you add --yes). It's mutually exclusive with --resume.

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

- --mysql-sql-mode='' (explicit empty) falls all the way through to the server's default sql_mode for the broadest legacy tolerance.

Both are global flags — see Configuration for the full discussion.

---
Canonical page: https://sluicesync.com/docs/migrate-mysql-to-postgres/ · Full docs index: https://sluicesync.com/llms.txt
