# Migrate & sync PlanetScale Postgres

> PlanetScale Postgres is managed PostgreSQL, so sluice drives it with the plain postgres engine — native logical-replication CDC, not the planetscale driver.

PlanetScale Postgres is managed PostgreSQL, not Vitess — no keyspaces, no sharding, no VStream. So unlike PlanetScale MySQL (which needs the planetscale driver and the VStream feed — see the region-move guide), you drive it with sluice's ordinary postgres engine: COPY-based cold copy and native logical-replication (replication-slot) CDC. Both a zero-downtime sync and a one-shot migrate work end-to-end (validated on v0.99.194). Cross-engine value translation applies as usual only if the other side is MySQL or SQLite; Postgres→Postgres is byte-exact.

## Provision & connect

Create the database with the Postgres engine — --engine postgresql is the pscale flag that selects managed Postgres rather than Vitess/MySQL. --replicas 0 is a single node; 2 or more gives you HA. The default branch is main:

    pscale database create app --engine postgresql --region <region> --replicas 0 --wait

Connections use Postgres roles, not the MySQL password/connect flow. pscale connect is Vitess-only and refuses a Postgres database. Instead, take a DSN from a role's database_url field:

- Default role — pscale role reset-default app main --format json returns the stable postgres role's database_url.

- Custom role — pscale role create app main mover --inherited-roles postgres --format json.

The DSN is a standard libpq URL. Note the database is literally postgres and the port is 5432:

    postgresql://<user>:<pass>@<region>.pg.psdb.cloud:5432/postgres?sslmode=verify-full

Prefer environment variables (SLUICE_SOURCE / SLUICE_TARGET) over putting the DSN in argv, so credentials don't land in your shell history or process list.

Keep sslmode=verify-full — it works out of the box. The database_url PlanetScale emits already carries sslmode=verify-full, and you should keep it. PlanetScale Postgres presents a Let's Encrypt certificate (chaining to ISRG Root X1) — a public CA in every standard trust store — and the certificate's hostname matches, so verify-full validates cleanly. sluice's Postgres driver (pgx) checks it against your OS system trust store automatically: Windows, macOS, and a standard Linux host all connect with verify-full as-is (add &sslrootcert=system only if you want it explicit). The one exception is a minimal Linux container with no ca-certificates package — the stock postgres Docker image is one — where the fix is to install ca-certificates, not to weaken TLS. Dropping to sslmode=require skips hostname and CA verification and isn't necessary here — see PlanetScale's note on why verify-full matters.

## Zero-downtime sync

A continuous sync snapshots and bulk-copies the source, then tails native logical-replication CDC — so the source stays writable the whole time and you flip traffic in a brief, controlled window. PlanetScale Postgres ships wal_level=logical with 20 replication slots, so slot-based CDC works out of the box:

    sluice sync start --stream-id ps-pg \
        --source-driver postgres --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET"

Watch it catch up from another shell, gate cutover on freshness, then stop and drain:

    sluice sync status --stream-id ps-pg \
        --target-driver postgres --target "$SLUICE_TARGET"

    sluice sync health --stream-id ps-pg \
        --target-driver postgres --target "$SLUICE_TARGET" --max-stale-seconds 30

    sluice sync stop --stream-id ps-pg \
        --target-driver postgres --target "$SLUICE_TARGET" --wait

sluice creates the slot, snapshots, tails, and applies live INSERT / UPDATE / DELETE with fidelity; sync stop --wait then drains cleanly. Two source-side requirements gate this:

Two requirements on the source role.

- Connect the source as the Default postgres role. Custom pscale_api_* roles lack the REPLICATION attribute and can't create a slot — sluice refuses loudly up front with a SLUICE-E error that names the fix (grant a replication role, or fall back to --source-driver=postgres-trigger). The Default postgres role has REPLICATION; use it for the source.

- The connecting role must own the source tables. Publication management needs table ownership, otherwise you hit must be owner of table / 42501. Cleanest is to create and own the source schema as postgres from the start.

Slot-less fallback. --source-driver postgres-trigger is a trigger-based, slot-less CDC path for managed Postgres that forbids replication (see trigger-based CDC). You don't need it here — the Default postgres role unlocks native slot-based CDC — but it's the escape hatch if a platform ever denies the REPLICATION attribute.

## One-shot migrate

A migrate is a point-in-time COPY with no CDC — a good fit when you can quiesce source writes for the copy window. Copy, then verify:

    sluice migrate \
        --source-driver postgres --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET"

    sluice verify \
        --source-driver postgres --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET"

Postgres→Postgres value fidelity is byte-exact — numeric, timestamptz, jsonb, and boolean all round-trip unchanged.

Give the target tables a stable owner. migrate emits a WARN that the target tables land owned by the ephemeral pscale_api_* role a fresh DSN connects as. Connect the target as the Default postgres role (pscale role reset-default app main) so the tables get a durable owner instead of a short-lived API role.

## Next steps

- Prepare a Postgres source — replication-slot lifecycle, slot invalidation, and failover for the native CDC engine.

- Move PlanetScale regions — the PlanetScale MySQL story (the planetscale driver, VStream, sharded keyspaces).

- Command reference — every flag named here, with defaults.

---
Canonical page: https://sluicesync.com/docs/planetscale-postgres/ · Full docs index: https://sluicesync.com/llms.txt
