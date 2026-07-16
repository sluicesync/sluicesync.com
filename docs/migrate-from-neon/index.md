# Migrating from Neon with sluice

> Direct vs -pooler endpoints (and why CDC needs the direct one), the irreversible enable_logical_replication project setting, TLS interop, and the live-validated migrate + continuous-sync recipe.

Neon is managed Postgres, so sluice drives it with the vanilla postgres engine — no flavor, no special driver. It has been live-validated as a migration and CDC source (Neon → PlanetScale Postgres, 2026-07-15): fidelity was byte-identical on md5 ground truth including the hard value families — NaN inside numeric[], &plusmn;Infinity, denormal floats, and 2-D arrays with NULL elements — and the snapshot → CDC handoff and post-handoff convergence were clean. What is Neon-specific is the endpoint model and how logical replication gets enabled. This guide covers both.

## Direct vs pooler endpoints — pick by workload

Every Neon branch has two hostnames for the same database:

Endpoint · Hostname shape · What it is ·

Direct · ep-<name>-<id>.<region>.aws.neon.tech · A real Postgres backend connection. ·

Pooled · same, with a -pooler suffix on the first label · pgbouncer in transaction mode. ·

- CDC requires the direct endpoint. A pooler cannot proxy replication-protocol commands — it strips the replication=database startup parameter, so the slot-creation command reaches a normal backend as plain SQL and is rejected as a syntax error. sluice recognizes that exact signature: sync start against the pooled host fails at slot creation with the coded SLUICE-E-CDC-POOLER-ENDPOINT refusal, which names the remedy (point --source at the direct host).

- Bulk migrate through the pooler works — a full snapshot-pinned parallel migrate passed through it at validation scale — but sluice's parallel copy pins server connections inside long-lived snapshot transactions, which risks pool exhaustion mid-copy at higher parallelism or scale, with a confusing failure when it hits. sluice emits a preflight WARN when the source host matches the -pooler pattern. Prefer the direct endpoint for both modes.

## Enabling logical replication (the project setting, not postgresql.conf)

Neon defaults to wal_level=replica. sluice's CDC preflight checks this before touching any slot and refuses loudly — the message points at the provider matrix in Prepare a Postgres source. The fix on Neon is not a GUC edit: it's the project setting enable_logical_replication (console: Settings → Logical replication; also settable via the project-update API). Two things to know before you flip it, both validated live:

- The toggle is irreversible. Once enabled on a project, it cannot be turned back off.

- It takes effect in seconds, with no visible downtime. No restart window to plan.

Bulk migrate does not need it — only continuous sync (a replication slot) does.

## The validated recipe

One-shot copy (dry-run first, then drop the flag):

    sluice migrate \
        --source-driver postgres --source 'postgres://user:pass@ep-my-branch-123456.us-east-2.aws.neon.tech/neondb?sslmode=require' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --dry-run

Continuous sync — direct endpoint, after enabling logical replication:

    sluice sync start \
        --source-driver postgres --source 'postgres://user:pass@ep-my-branch-123456.us-east-2.aws.neon.tech/neondb?sslmode=require' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id neon-app

Connection notes from the validation run:

- TLS: Neon DSNs work with sslmode=require, and sslmode=verify-full also works with the standard system roots — prefer it (see the sslmode note).

- Region co-location matters. The validation runs were cross-provider; co-locating the sluice process (or the target) with the Neon region measurably reduces snapshot wall-clock.

- Autosuspend / cold-start is unprobed. The validation project stayed active throughout, so scale-to-zero resume latency under a sluice snapshot has not been characterized. If you run against an autosuspending endpoint and see slow first-connection behaviour, that's the place to look.

## The wal_proposer_slot you'll see in slot listings

Every Neon endpoint carries an always-present physical replication slot named wal_proposer_slot — it's part of Neon's safekeeper architecture, not a leaked consumer. sluice's slot-health monitoring correctly ignores it. If you enumerate slots with your own tooling (or sluice slot list), expect to see it and leave it alone; only sluice_-prefixed logical slots belong to sluice.

## What sluice checks for you

- SLUICE-E-CDC-POOLER-ENDPOINT — sync start against the -pooler host fails at slot creation with a coded refusal explaining that a pooler cannot proxy replication, naming the direct-endpoint remedy.

- Pooler-host preflight WARN — migrate and sync start warn up front when the source hostname matches the -pooler label pattern, before any pool-exhaustion surprise.

- wal_level preflight refusal — CDC against a project without logical replication enabled refuses at startup (before touching any slot), pointing at Neon's enable_logical_replication setting via the provider matrix.

- SLUICE-E-CDC-REPLICATION-PERMISSION — if the connecting role lacks the REPLICATION attribute, the preflight refuses with the exact ALTER ROLE remedy rather than failing opaquely mid-cold-start.

- Slot-health monitoring that ignores wal_proposer_slot — Neon's internal slot is never flagged as a leaked consumer.

## Next steps

- Prepare a Postgres source — the full slot lifecycle, retention, and failover story (provider matrix included).

- Verify & reconcile — confirm the target matches the source after the copy.

- Field note: replication slots don't die with your process — why an abandoned slot pins WAL on the source.

- Field note: the idle-slot failover trap — slot survival on HA-managed Postgres.

---
Canonical page: https://sluicesync.com/docs/migrate-from-neon/ · Full docs index: https://sluicesync.com/llms.txt
