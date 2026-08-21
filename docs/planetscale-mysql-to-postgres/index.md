# Migrate PlanetScale MySQL to PlanetScale Postgres

> PlanetScale now offers managed Postgres alongside its Vitess/MySQL product. Moving between them is a CROSS-ENGINE migration — MySQL to Postgres — so type translation applies; sluice does it zero-downtime or in one shot.

PlanetScale ships two products: the original Vitess/MySQL platform and, newer, managed Postgres. Moving a database from one to the other is not a region move or a version upgrade &mdash; it crosses an engine boundary, MySQL → Postgres, so sluice's cross-engine type translation is doing real work (a MySQL TINYINT(1) becomes a Postgres boolean, ENUM becomes a native PG enum, AUTO_INCREMENT becomes an identity sequence, and so on). Both a zero-downtime continuous sync and a one-shot migrate work end to end. The two ends connect very differently &mdash; the source is PlanetScale MySQL (the planetscale driver, VStream CDC), the target is PlanetScale Postgres (the ordinary postgres driver, native COPY) &mdash; so read Provision & connect carefully, then pick your flow.

How this differs from the PlanetScale guides next door. The region move is MySQL → MySQL (same engine, no type translation) and the Postgres upgrade is Postgres → Postgres. This one is the cross-engine case, so the preview-the-translation step below matters more here than in either of those.

## Before you start

- The drivers are different on each end. The source is --source-driver planetscale (PlanetScale MySQL speaks VStream, and the mysql driver's LOAD DATA cold-copy is blocked by Vitess). The target is --target-driver postgres &mdash; PlanetScale Postgres is managed PostgreSQL, not Vitess, so it is driven by sluice's ordinary Postgres engine, not the planetscale one.

- Foreign keys are simpler than a MySQL target. Postgres has native foreign keys, so there is none of the "Allow foreign key constraints" enablement dance a PlanetScale MySQL target needs (that guide). Whatever foreign keys your source schema actually declares are emitted on the Postgres target and enforced normally. (PlanetScale MySQL ships with foreign-key support off by default, so many source schemas carry none to begin with &mdash; each column's covering index still comes across regardless.)

- The Vitess-target tuning does NOT apply. Because the target is Postgres, not Vitess, you do not need the region-move guide's --apply-batch-size 25&ndash;50 clamp (that exists to dodge Vitess's 20-second transaction killer) nor --upfront-indexes / --planetscale-raise-query-timeout (those dodge Vitess's per-statement time limit on a deferred ADD INDEX). A Postgres target builds indexes with an ordinary CREATE INDEX and has no such wall. Leave those flags off.

- Preview the type translation. This is the cross-engine step. Run schema preview to see the exact Postgres DDL column by column and steer any type you disagree with using --type-override before any data moves &mdash; see below.

## Provision & connect

Source (PlanetScale MySQL). This is your existing database. Mint a read password and build a standard go-sql-driver DSN &mdash; ?tls=true is required. USERNAME is the generated username field pscale password create returns, not the label you pass it:

    pscale password create app main mover --role reader   # -> username + plain_text

    # SLUICE_SOURCE (CDC read):
    USERNAME:PASSWORD@tcp(aws.connect.psdb.cloud:3306)/app?tls=true

Target (PlanetScale Postgres). Create a Postgres database (--engine postgresql selects managed Postgres rather than Vitess) and take the target DSN from a Postgres role &mdash; pscale connect is Vitess-only and refuses a Postgres database. Connect as the Default postgres role so the tables it creates get a durable owner (a fresh pscale_api_* role is ephemeral, and migrate WARNs when the target tables would land owned by one):

    pscale database create app-pg --engine postgresql --region <region> --replicas 0 --wait
    pscale role reset-default app-pg main --format json      # -> database_url

    # SLUICE_TARGET (write): that database_url, of the form
    postgresql://<user>:<pass>@<region>.pg.psdb.cloud:5432/postgres?sslmode=verify-full

Prefer environment variables (SLUICE_SOURCE / SLUICE_TARGET) over putting either DSN in argv, so credentials don't land in your shell history or process list.

Keep the target's sslmode=verify-full. The database_url PlanetScale emits already carries it, and it works out of the box: PlanetScale Postgres presents a public Let's Encrypt certificate that sluice's pgx driver validates against your system trust store on Windows, macOS, and a standard Linux host. The only place it needs help is a minimal Linux container with no ca-certificates package (the stock postgres image) &mdash; install the package rather than weakening TLS. Full detail in the PlanetScale Postgres guide.

The target role only needs write + DDL &mdash; NOT REPLICATION. The Postgres side here is a write target, so it does not create a replication slot; the REPLICATION-role requirement in the PlanetScale Postgres sync guide applies only when PlanetScale Postgres is the CDC source. Here the change stream is read from the MySQL side over VStream, and the Postgres role just needs to create tables and write rows &mdash; the Default postgres role covers that.

## Preview the translation, then steer it

Because this crosses engines, look at the target DDL before you move data. A dry run prints the plan and row estimates; schema preview prints the exact per-column Postgres DDL with translation notes, which is where you catch a type you want to steer:

    sluice schema preview \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET"

An explicit --type-override <table>.<col>=<pgtype> always wins over sluice's default choice &mdash; reach for it when a column's default translation isn't what you want (see the translation notes below for the cases worth checking).

## Zero-downtime sync + cutover

A continuous sync snapshots and bulk-copies the source, then tails live CDC &mdash; so the PlanetScale MySQL source stays writable the whole time and you flip traffic in a brief, controlled window. Dry-run first, then launch the long-lived stream:

    # review the plan
    sluice sync start --stream-id ps-my2pg \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --dry-run --format json

    # launch (snapshot -> bulk copy -> live CDC apply into Postgres)
    sluice sync start --stream-id ps-my2pg \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET"

Watch it catch up from another shell and gate cutover on freshness, then prime sequences, stop, and verify:

    sluice sync status --stream-id ps-my2pg \
        --target-driver postgres --target "$SLUICE_TARGET"

    sluice sync health --stream-id ps-my2pg \
        --target-driver postgres --target "$SLUICE_TARGET" --max-stale-seconds 30

    # prime the Postgres identity sequences past the source's AUTO_INCREMENT
    sluice cutover \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET"

    sluice sync stop --stream-id ps-my2pg \
        --target-driver postgres --target "$SLUICE_TARGET" --wait

Wait for caught-up before cutover. A trickle of changes can take tens of seconds to appear on the target &mdash; that latency is PlanetScale VStream's roughly 60-second server-side delivery cadence on the source, not sluice (the applier commits within seconds of receiving an event). Gate cutover on sync health / verify reporting caught-up, not a fixed timer. On VStream teardown, sync stop --wait may print a "did not complete drain within&hellip;" message even though the stream drained and exited cleanly &mdash; confirm the process actually exited rather than treating that line alone as a failure.

## One-shot migrate

If you can take a short write-freeze on the source, a one-shot migrate is simpler &mdash; one command, no control tables left behind, and it auto-primes the target sequences so there is no separate cutover step:

    sluice migrate \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" --dry-run

    sluice migrate \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET"

sluice creates the tables, bulk-copies rows, then builds indexes and constraints in deferred phases. Interrupted? Re-run the identical command with --resume and it continues from the last per-table checkpoint. It refuses to copy into a non-empty target by default (a primary-key-collision safety net) &mdash; start from an empty target, or use --reset-target-data to drop-and-recopy.

## Verify

Confirm source and target agree &mdash; count parity by default, escalating to sampled content hashes:

    sluice verify \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --depth count

--depth sample adds per-table sampled-row content hashing (~99% confidence on a 5%+ corruption rate); see the validate guide for the full depth ladder.

## Translation notes worth checking

Postgres value fidelity is high, but a few MySQL → Postgres translations are worth a look in preview:

- TINYINT(1) becomes boolean. MySQL aliases BOOL/BOOLEAN to TINYINT(1), so sluice reads a TINYINT(1) column as a boolean &mdash; correct for the overwhelmingly common case. But (1) is only a display width; the column physically stores the full 8-bit range. If a legacy column declared TINYINT(1) is actually used as a small integer holding values outside {0,1}, sluice refuses loudly (SLUICE-E-VALUE-TINYINT1-RANGE) rather than collapsing every non-zero value to true &mdash; a silent-loss class it will not commit. On a PlanetScale (VStream) source specifically, the fix is to change the source column's type (e.g. ALTER TABLE t MODIFY col SMALLINT): the boolean decision there comes from the replication wire's own column type, so --type-override does not re-type it on this path (it does on a non-Vitess MySQL bulk source). A column that genuinely holds only 0/1 is a clean boolean and needs nothing.

- ENUM / SET. A MySQL ENUM maps to a native Postgres enum type; SET (which Postgres has no native equivalent for) is carried faithfully as text. Both cold-copy and CDC.

- AUTO_INCREMENT becomes an identity sequence, and cutover (sync) or the migrate's own priming (one-shot) advances it past the source's current value with a safety margin, so the application can write to Postgres without primary-key collisions.

- Unsigned integers widen. Postgres has no unsigned types, so an INT UNSIGNED promotes to a wider signed Postgres type that covers its range &mdash; no truncation, visible in preview.

- Legacy MySQL data. sluice forces a strict sql_mode on the MySQL source, so pre-5.7 zero-dates (0000-00-00) and silently-truncated values refuse loudly rather than land subtly wrong. Carry them deliberately with --zero-date=null / --zero-date=epoch, or fall through to the server default with --mysql-sql-mode='' (both global flags).

## Next steps

- Preview & validate &mdash; the schema-preview / --type-override / verify loop, in full.

- PlanetScale Postgres &mdash; the target platform's own guide (roles, TLS, and syncing from PS Postgres).

- Type mapping &mdash; the MySQL &harr; Postgres type-translation contract, column by column.

- Command reference &mdash; every flag named here, with defaults.

---
Canonical page: https://sluicesync.com/docs/planetscale-mysql-to-postgres/ · Full docs index: https://sluicesync.com/llms.txt
