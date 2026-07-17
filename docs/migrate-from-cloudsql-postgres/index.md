# Migrating from Google Cloud SQL Postgres with sluice

> The cloudsql.logical_decoding flag (restart included, about a minute), the self-service ALTER ROLE ... REPLICATION grant, default-plaintext TLS and the per-instance CA, and the validated migrate + CDC recipe.

Google Cloud SQL for PostgreSQL works with sluice's vanilla postgres engine — live-validated 2026-07-16 (PostgreSQL 16.14) as a bulk-migration and slot-based CDC source: byte-identical md5 ground truth on the bulk copy (including NaN-in-numeric[], &plusmn;Infinity, denormal floats, and 2-D arrays with NULL elements), an exact snapshot → CDC handoff with live-write convergence, and a clean stop with zero orphaned slots. The pleasant surprise, coming from the RDS guide: Cloud SQL has no platform-specific role model to learn. Two self-service steps take a fresh instance to CDC-ready, and both of sluice's preflight refusals name remedies that work verbatim here.

## Enabling logical replication (one flag, about a minute)

A fresh Cloud SQL instance sits at wal_level=replica regardless of backup settings — there is no RDS-style &ldquo;retention 0 means minimal&rdquo; trap, so you are always exactly one flag from CDC-ready. wal_level itself is not directly settable; the knob is the database flag cloudsql.logical_decoding:

    # The patch performs the required restart INLINE — about a minute end-to-end (validated live).
    gcloud sql instances patch my-instance --database-flags=cloudsql.logical_decoding=on

    # Careful: --database-flags REPLACES the entire flag set. On an instance with
    # existing flags, include them all in the same patch:
    #   --database-flags=cloudsql.logical_decoding=on,max_connections=200

Notes from the validation run:

- The restart is automatic and fast. No separate reboot step to schedule — wal_level=logical was queryable about 50 seconds after the patch started (contrast RDS: custom parameter group + explicit reboot, ~3 minutes).

- The slot budget is already provisioned: max_replication_slots=10 / max_wal_senders=10 before the flip, unchanged by it. Plenty for sluice's one slot; only heavy multi-consumer setups need explicit raises.

- The --database-flags replace-everything behaviour is the one real gotcha — a patch that names only the new flag silently clears every other flag on the instance.

## Roles: ALTER ROLE ... REPLICATION actually works here

The default postgres user is not a superuser (rolsuper=f), but it is a member of cloudsqlsuperuser — and Cloud SQL patches the standard &ldquo;must be superuser to alter replication users&rdquo; check for its members. So the fix is one standard-Postgres statement, run as yourself:

    ALTER ROLE postgres WITH REPLICATION;   -- succeeds as the (non-superuser) master user

That statement is exactly the first remedy in sluice's SLUICE-E-CDC-REPLICATION-PERMISSION refusal — Cloud SQL is the first managed provider in this validation series where it applies verbatim. One honest caveat: the refusal's provider-specific examples currently name platforms where the attribute is not grantable (RDS's role membership, Heroku's support ticket), and don't yet name Cloud SQL as the &ldquo;just run it&rdquo; case — don't let those examples talk you out of trying the ALTER ROLE.

- Membership confers nothing. The platform roles cloudsqlreplica / cloudsqllogical carry rolreplication themselves, but the REPLICATION attribute is not inherited via membership in stock Postgres, and Cloud SQL does not patch that — a role granted IN ROLE cloudsqlreplica still cannot create a slot (validated live). Those roles are platform-internal; the attribute on your role is the mechanism, unlike RDS's rds_replication membership model.

- Expect the refusals in role → flag order. On a stock instance, sync start meets the replication-permission refusal first; after the grant, the wal_level refusal (whose provider matrix names the Cloud SQL flag). Doing both steps up front skips the second round-trip.

## TLS: plaintext is accepted by default

Cloud SQL's default sslMode is ALLOW_UNENCRYPTED_AND_ENCRYPTED — a public-IP DSN without sslmode=require sends credentials and data in the clear, and nothing refuses (contrast RDS Postgres, where force_ssl is the default). Set sslmode=require or stronger on every Cloud SQL DSN yourself, or flip the instance to --ssl-mode=ENCRYPTED_ONLY server-side.

Mode · On a default Cloud SQL instance ·

sslmode=disable · Accepted. Nothing server-side refuses plaintext unless the instance was created/patched to ENCRYPTED_ONLY. ·

sslmode=require · Works (TLS 1.3). What the validation ran on throughout — the sensible floor. ·

sslmode=verify-ca · Works with the per-instance CA (recipe below). The ceiling on default instances. ·

sslmode=verify-full · Fails on default instances: the server certificate names .sql.goog DNS names — never the public IP — and the default (per-instance-CA) mode publishes no matching dnsName. Instances created with --server-ca-mode=GOOGLE_MANAGED_CAS_CA get a resolvable name that should allow it (unvalidated). ·

The per-instance CA is an authenticated API fetch (like DigitalOcean's, unlike RDS's public bundle URL); Postgres endpoints take it as sslrootcert= in the DSN (the --source-tls-ca flag is for MySQL-family endpoints and refuses on Postgres rather than being silently ignored):

    gcloud sql instances describe my-instance --format='value(serverCaCert.cert)' > cloudsql-ca.pem

    sluice migrate \
        --source-driver postgres \
        --source 'postgres://postgres:pass@34.148.x.y:5432/app?sslmode=verify-ca&sslrootcert=cloudsql-ca.pem' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --dry-run

## The Auth Proxy is a tunnel, not a pooler

The Cloud SQL Auth Proxy is untested with sluice, but it is categorically different from the pgbouncer/Supavisor/RDS-Proxy class that breaks CDC: it's a per-connection encrypted TCP tunnel with IAM auth, not a transaction pooler, so the replication protocol should traverse it. Treat that as unvalidated — the validated path is the direct instance IP with an authorized-network entry, which needs no proxy at all. Two things to know if you route through it anyway: sluice's pooler-host preflight WARN cannot see the hop (the DSN host becomes localhost, so a quiet preflight there is not a verdict), and Cloud SQL's separate Managed Connection Pooling feature is a pooler and belongs in the CDC-incompatible class (also untested).

## The validated recipe

Public IP + an authorized-network entry for the migration host is enough — no proxy, no VPC peering. One-shot copy first:

    sluice migrate \
        --source-driver postgres --source 'postgres://postgres:pass@34.148.x.y:5432/app?sslmode=require' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --dry-run

Continuous sync, after the flag flip and the role grant:

    sluice sync start \
        --source-driver postgres --source 'postgres://postgres:pass@34.148.x.y:5432/app?sslmode=require' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id cloudsql-app

## Decommissioning: drop the slot

A cleanly stopped sluice stream leaves its replication slot in place — that's what makes the stream resumable. When you're done for good, drop it: an abandoned slot retains WAL and will eventually fill the instance disk (a 10 GB starter disk has little slack).

    sluice slot list --source-driver postgres --source 'postgres://...'
    sluice slot drop sluice_slot --yes --source-driver postgres --source 'postgres://...'

An empty slot catalog is the Cloud SQL baseline — there are no Neon-style platform-internal slots to leave alone; anything listed is a consumer someone created.

## What sluice checks for you

- The wal_level preflight refusal — CDC against a replica-level instance refuses at startup, before touching any slot, pointing at the provider matrix whose Cloud SQL row (cloudsql.logical_decoding = on, restart included) was validated correct by this run.

- SLUICE-E-CDC-REPLICATION-PERMISSION — a role without the REPLICATION attribute refuses with the exact ALTER ROLE remedy, and on Cloud SQL that remedy genuinely works as the master user (see the caveat above about the refusal's provider examples).

- Slot-health monitoring — wal_status transitions and decode-spill counters, the same as any Postgres source; the validation stream ran WARN-free throughout.

- SLUICE-E-CONFIRMATION-REQUIRED — slot drop refuses without --yes, so a decommissioning script can't destroy a resumable position by accident.

## Next steps

- Prepare a Postgres source — the full slot lifecycle, retention, and failover story (provider matrix included).

- Migrating from AWS RDS Postgres — the AWS sibling: everything Cloud SQL does differently (role membership, parameter-group reboot, force_ssl).

- Verify & reconcile — confirm the target matches the source after the copy.

- Field note: replication slots don't die with your process — why the decommissioning step matters.

---
Canonical page: https://sluicesync.com/docs/migrate-from-cloudsql-postgres/ · Full docs index: https://sluicesync.com/llms.txt
