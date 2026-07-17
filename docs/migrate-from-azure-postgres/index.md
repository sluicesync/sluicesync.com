# Migrating from Azure Database for PostgreSQL (Flexible Server) with sluice

> The self-grantable REPLICATION attribute (ALTER ROLE ... WITH REPLICATION works as the admin user), the best TLS story in the series (verify-full with zero setup against public roots), and the wal_level flip that needs an explicit restart. The built-in PgBouncer is General-Purpose-tier-plus only.

Azure Database for PostgreSQL (Flexible Server) works with sluice's vanilla postgres engine — live-validated 2026-07-17 (PG 16.14) as a migration and slot-based CDC source: byte-identical bulk migrate on md5 ground truth (NaN in numeric[], &plusmn;Infinity, denormal floats, 2-D arrays with NULL elements) and exact CDC convergence with a clean snapshot → CDC handoff.

## Enabling logical replication (three self-service steps)

No ticket, all self-service — but mind the explicit restart in step 2:

- Set wal_level=logical — Azure exposes the GUC directly (no provider-specific alias). It is static, so the command returns with the change pending:

    az postgres flexible-server parameter set --resource-group <rg> --server-name <server> \
      --name wal_level --value logical

- Restart explicitly — the parameter does NOT take effect until you restart (~1 minute; contrast Cloud SQL, whose patch restarts for you). Verify afterward with SHOW wal_level;:

    az postgres flexible-server restart --resource-group <rg> --name <server>

- Grant the connecting role the REPLICATION attribute — this works as the (non-superuser) admin user, because Azure patches the grant for azure_pg_admin members. It is exactly recovery path (a) in sluice's replication-capability refusal:

    ALTER ROLE <role> WITH REPLICATION;

The platform replication role is grant-restricted and irrelevant here — there is no RDS-style membership model; the attribute is the mechanism. Baseline before the flip: wal_level=replica regardless of backup settings (no RDS-style retention-0 &rArr; minimal trap), max_replication_slots=10 / max_wal_senders=10 (unchanged by the flip), and zero platform slots.

## TLS: the best story in the series

TLS is mandatory (plaintext refused at pg_hba) and the certificate chain is public (Microsoft/DigiCert roots). So sslmode=verify-full works with no CA download and no sslrootcert — use it on every Azure DSN; it is both the strictest and the zero-config mode (better than the per-instance-CA fetch that DigitalOcean, Cloud SQL, and Vultr require). If a client stack with its own bundled CA fails verification, it's missing an OS trust store, not an Azure quirk.

    sluice sync start \
        --source-driver postgres \
        --source 'postgres://myadmin:pass@myserver.postgres.database.azure.com:5432/app?sslmode=verify-full' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id azure-pg-app

## The built-in PgBouncer (General Purpose tier and up)

Azure's built-in PgBouncer requires the General Purpose tier or higher (port 6432 on the same hostname when enabled; it cannot be enabled at all on Burstable) and is expected to strip replication like the Supavisor class — untested. Connect sluice to port 5432.

## Provisioning friction

Microsoft.DBforPostgreSQL provider registration is a one-time subscription step, and region availability differs per subscription even from the MySQL flexible service — a region that provisions MySQL can refuse PG with &ldquo;The location is restricted.&rdquo; Plan a region fallback.

## Decommissioning

A cleanly stopped sluice stream leaves its (resumable) replication slot in place; when you're done for good, drop it — an abandoned slot retains WAL and will eventually fill the instance disk:

    sluice slot drop --yes <slot>

## What sluice checks for you

- SLUICE-E-CDC-REPLICATION-PERMISSION — if the connecting role lacks the REPLICATION attribute, the preflight refuses with the exact ALTER ROLE &hellip; WITH REPLICATION remedy (recovery path (a)), which on Azure the admin user can run itself.

- wal_level preflight refusal — CDC before the parameter flip + restart refuses at startup rather than failing opaquely mid-cold-start.

- Slot-lifecycle honesty — sluice slot list / slot drop surface and manage the replication slot explicitly, so a crashed stream's leftover slot is visible rather than a silent WAL leak.

## Next steps

- Migrating from Azure Database for MySQL — the MySQL sibling and its required row-image knob.

- Migrating from Google Cloud SQL Postgres — the other managed PG where ALTER ROLE &hellip; WITH REPLICATION is self-service.

- Prepare a Postgres source — the full slot lifecycle, retention, and failover story.

- Field note: replication slots don't die with your process — why an abandoned slot pins WAL.

---
Canonical page: https://sluicesync.com/docs/migrate-from-azure-postgres/ · Full docs index: https://sluicesync.com/llms.txt
