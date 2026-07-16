# Migrating from AWS RDS Postgres with sluice

> The rds.logical_replication parameter-group flip, the rds_replication role-membership model (nothing to grant for the master user), force_ssl and the trust bundle, and the trigger-engine fallback.

AWS RDS for PostgreSQL works with sluice's vanilla postgres engine — live-validated 2026-07-16 (PostgreSQL 16.14) as a bulk-migration source with byte-identical md5 ground truth, including NaN-in-numeric[], &plusmn;Infinity, denormal floats, and 2-D arrays with NULL elements. Trigger-CDC (postgres-trigger) was validated end-to-end in the same run. Slot-based CDC was blocked in that run by a sluice-side false refusal — the preflight didn't yet understand RDS's role-membership model while the platform itself was proven slot-capable — and the preflight has since been taught that model, so slot CDC is expected to work with the master user. Aurora Postgres uses the same role model and parameter names.

## Enabling logical replication (parameter group + reboot)

Not postgresql.conf and not a console toggle: attach a custom parameter group with rds.logical_replication = 1. The parameter is static, so a reboot is required (~2 minutes); the GUC wal_level itself is read-only on RDS. Two gotchas the validation surfaced:

- Retention 0 means wal_level=minimal, not replica. RDS couples wal_level to automated backups: with backup-retention-period 0 — the cheapest possible instance shape — the baseline is minimal, one notch below the replica most docs assume. A cost-minimized instance is two steps from CDC-ready, not one — but the remedy is the same either way: the parameter flip forces logical regardless of retention. Don't detour via &ldquo;enable backups.&rdquo;

- After the flip, RDS provisions the slot budget automatically: max_replication_slots=20, max_wal_senders=35. Nothing to size by hand.

    aws rds create-db-parameter-group --db-parameter-group-name sluice-pg16-logical \
        --db-parameter-group-family postgres16 --description 'logical replication for sluice CDC'
    aws rds modify-db-parameter-group --db-parameter-group-name sluice-pg16-logical \
        --parameters 'ParameterName=rds.logical_replication,ParameterValue=1,ApplyMethod=pending-reboot'
    aws rds modify-db-instance --db-instance-identifier mydb --db-parameter-group-name sluice-pg16-logical
    aws rds reboot-db-instance --db-instance-identifier mydb    # static parameter: the reboot is unavoidable

## Roles: membership, not attributes

The RDS master user is not a superuser and never carries the REPLICATION attribute (rolreplication=f) — and ALTER ROLE ... REPLICATION is not available on RDS at all. What actually gates slot creation is membership in the rds_replication role, which the master user has from creation. sluice's replication-capability preflight recognizes that membership (it probes rolsuper OR rolreplication or rds_replication membership when that role exists), so:

- Master user: nothing to grant. It has everything sluice needs on defaults — including CREATE EVENT TRIGGER (via rds_superuser) for sluice trigger setup.

- Custom roles: GRANT rds_replication TO <role>; is the RDS equivalent of the REPLICATION attribute.

## TLS: force_ssl and the trust bundle

rds.force_ssl=1 is the platform default on PG 15+ engines — plaintext connections are refused at pg_hba (no pg_hba.conf entry ... no encryption). sslmode=require works out of the box; verify-full works with the AWS trust bundle passed in the DSN (Postgres endpoints take sslrootcert= in the DSN — the --source-tls-ca flag is for MySQL-family endpoints and refuses on Postgres rather than being silently ignored):

    curl -sO https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

    sluice sync start \
        --source-driver postgres \
        --source 'postgres://master:pass@mydb.abc123.us-east-1.rds.amazonaws.com:5432/app?sslmode=verify-full&sslrootcert=global-bundle.pem' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id rds-app

## RDS Proxy: connect to the instance endpoint

RDS Proxy is untested with sluice and expected CDC-incompatible — it is a transaction-mode pooler, and the replication protocol cannot traverse a pooler (the same class as the Neon and Supabase pooler findings). Point sluice at the instance endpoint (*.<id>.<region>.rds.amazonaws.com), not a proxy endpoint (*.proxy-*.rds.amazonaws.com).

## The trigger-engine fallback

When a replication slot isn't an option — a custom role you can't grant rds_replication to, an organization that forbids the parameter-group reboot, or a need to start CDC before the reboot window — the slot-less postgres-trigger engine runs the same continuous sync off per-table capture triggers, no slot and no replication privilege required. It was validated end-to-end against RDS in the same run (the master user can create the event trigger sluice's DDL detection prefers, via rds_superuser):

    sluice trigger setup \
        --source-driver postgres-trigger \
        --dsn 'postgres://master:pass@mydb.abc123.us-east-1.rds.amazonaws.com:5432/app?sslmode=require' \
        --tables orders,customers,line_items

    sluice sync start \
        --source-driver postgres-trigger --source 'postgres://master:pass@mydb...rds.amazonaws.com:5432/app?sslmode=require' \
        --target-driver postgres         --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id rds-trigger-app

The full lifecycle (setup → run → teardown, payload tuning, pruning) is in Managed Postgres (slot-less).

## What sluice checks for you

- The membership-aware replication preflight — before opening the CDC reader, sluice verifies the role can create a slot via rolsuper OR rolreplication or rds_replication membership (checked only where that role exists, so stock Postgres is unaffected). A genuinely incapable role refuses with SLUICE-E-CDC-REPLICATION-PERMISSION and the RDS-appropriate remedy, instead of failing opaquely at slot creation.

- The wal_level preflight refusal — CDC against replica (or retention-0's minimal) refuses at startup, pointing at the provider matrix with the RDS parameter-group remedy.

- The Aurora HA advisory — a source host matching *.cluster*.rds.amazonaws.com (Aurora cluster endpoints) gets the managed-HA WARN about the idle-slot failover trap, with the heartbeat mitigation.

- Slot-health monitoring — wal_status transitions (unreserved → critical, lost → terminal, exactly-once) and PG 14+ decode-spill counters, the same as any Postgres source.

- Event-trigger capability by attempt, not by role list — sluice trigger setup probes whether the role can actually create an event trigger rather than checking a predefined-role name, so RDS's rds_superuser-patched capability is recognized.

## Next steps

- Prepare a Postgres source — slot lifecycle, retention pressure, and the failover checklist.

- Managed Postgres (slot-less) — the trigger engine's full lifecycle reference.

- Migrating from AWS RDS MySQL — the MySQL sibling: binlog retention, FTWRL, the regional bundle.

- Field note: the idle-slot failover trap — the hazard behind the Aurora HA advisory.

---
Canonical page: https://sluicesync.com/docs/migrate-from-rds-postgres/ · Full docs index: https://sluicesync.com/llms.txt
