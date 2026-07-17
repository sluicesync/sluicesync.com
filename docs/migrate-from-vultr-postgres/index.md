# Migrating from Vultr Managed PostgreSQL with sluice

> The only provider validated so far that ships CDC-ready with zero preparation: wal_level=logical and a REPLICATION-bearing admin role out of the box. Plus the pghoard_local platform-internal slot you must not drop, and Vultr's managed PgBouncer — the live counter-example where CDC actually traverses the pooler.

Vultr Managed Databases for PostgreSQL works with sluice's vanilla postgres engine — live-validated 2026-07-16 (PG 17.10) as a migration and slot-based CDC source: byte-identical bulk migrate on md5 ground truth (NaN in numeric[], &plusmn;Infinity, denormal floats, 2-D arrays with NULL elements) and exact CDC convergence with a clean snapshot → CDC handoff.

## Enabling logical replication: nothing to do

Vultr (an Aiven-lineage platform) ships CDC-ready — the only provider validated so far where that is true. wal_level=logical is set out of the box, and the master user (vultradmin) carries the REPLICATION attribute from first boot, so sync start works with zero preparation. max_replication_slots / max_wal_senders default to 20/20 and are raisable to 64 via the database's advanced options. For a custom role, ALTER ROLE <role> WITH REPLICATION works as vultradmin (no superuser needed — the platform patches the grant, like Cloud SQL and Azure).

    sluice sync start \
        --source-driver postgres \
        --source 'postgres://vultradmin:pass@vultr-prod-xxx.vultrdb.com:16751/defaultdb?sslmode=require' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id vultr-pg-app

## The pghoard_local slot is platform-internal

Every Vultr PG instance carries an always-active physical replication slot named pghoard_local (Aiven's pghoard backup daemon). sluice knows it: sluice slot list shows it labeled platform-internal, sluice slot drop refuses it without --force, and the slot-health probe (scoped to sluice's own slot) never flags it. Leave it alone — never drop it, and don't count it as a leaked consumer. It's the Aiven-lineage sibling of Neon's wal_proposer_slot.

## TLS

Plaintext is refused server-side; sslmode=require works out of the box, and sslmode=verify-full works with the project CA, which is delivered inline in the database create/get API response (ca_certificate field) — save it and pass it via ?sslrootcert=<path> on the DSN. System roots do not verify (private per-project CA).

## The connection pooler: CDC actually traverses it

Vultr's managed PgBouncer pools listen on the primary hostname at port + 1 with dbname=<poolname> (the API does not expose this — it's the platform convention). Unlike the Neon / Supavisor / RDS-Proxy pooler class, replication connections pass through (modern PgBouncer &ge; 1.24 forwards them 1:1 to the server): both bulk migrate (parallel, snapshot-pinned, no statement-cache trip) and slot-based CDC — slot creation, streaming, warm resume, clean stop — were validated end-to-end through a transaction-mode pool. This is the live counter-example that makes the &ldquo;a pooler always strips replication&rdquo; claim provider-dependent.

Prefer the direct port anyway: a pool sized N permanently holds N of the plan's small connection budget (22 on the cheapest plan). Note that sluice's pooler-host WARN does not fire here — the pool hostname equals the primary's, only the port differs — which on Vultr is harmless, but it also means &ldquo;no WARN&rdquo; is not evidence of &ldquo;not a pooler&rdquo; on this provider.

## Decommissioning

A cleanly stopped sluice stream leaves its (resumable) replication slot in place; when done for good, sluice slot drop --yes <slot> — an abandoned slot retains WAL against the instance disk. (pghoard_local stays; see above.)

## What sluice checks for you

- Slot-health monitoring that ignores pghoard_local — Vultr's platform slot is never flagged as a leaked consumer, and slot drop refuses it without --force.

- SLUICE-E-CDC-REPLICATION-PERMISSION — present as a safety net, though on Vultr the default vultradmin already carries the attribute, so it stays quiet on defaults.

- Parallel copy through the pool with no statement-cache trip — the transaction-mode pool didn't trip pgx's statement cache in the validation run, so parallel copy engaged; a pool-exhaustion risk at high parallelism is the reason to prefer the direct port.

## Next steps

- Migrating from Vultr Managed MySQL — the MySQL sibling, whose binlog retention is the opposite story (no knob, ~10-minute floor).

- Migrating from Neon — another managed PG with an always-present platform slot to leave alone.

- Prepare a Postgres source — the full slot lifecycle, retention, and failover story.

- Field note: replication slots don't die with your process — why an abandoned slot pins WAL on the source.

---
Canonical page: https://sluicesync.com/docs/migrate-from-vultr-postgres/ · Full docs index: https://sluicesync.com/llms.txt
