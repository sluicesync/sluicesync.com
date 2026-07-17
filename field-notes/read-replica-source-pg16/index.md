# The read replica is a better migrate source and a worse CDC source than the docs

> "You can't do logical replication from a read replica" is Postgres ≤15 lore, and PG 16 quietly flipped both halves of it — in opposite directions for a migration tool. On the read side it got better than the docs: pg_export_snapshot() now works on a standby, so a parallel bulk copy from a replica is fully snapshot-consistent. On the CDC side it got more fragile than "impossible": a slot can be created on a PG 16+ standby, but CREATE_REPLICATION_SLOT blocks until the idle primary emits its next running-xacts record, and the publication DDL CDC needs can't run on a hot standby at all.

Observed — a live probe of a Supabase PostgreSQL 17.6.1 read replica (us-west-1, 2026-07-17) on the shipped v0.99.263–265 binaries; the coded refusal shipped in v0.99.267 (filed as Bug 197). &ldquo;CDC from a standby is unsupported by design&rdquo; is a Postgres-platform truth, not a sluice limitation — but which parts of that truth still hold depends on your major version, and PG 16 moved the line under both halves of the old rule.

## The read side got better than the docs promise

Under Postgres ≤15, pg_export_snapshot() errored during recovery, so a parallel bulk copy from a standby could not pin all its reader connections to one consistent snapshot — it fell back to independent per-connection reads with no cross-table consistency. PG 16 lifted that restriction as part of the logical-decoding-on-standby work. So on a Supabase PG 17 replica, sluice's parallel readers all pinned to one shared exported snapshot and took a fully snapshot-consistent copy from a replica — the probe confirmed the shared snapshot engaged (pg_export_snapshot() returned a handle inside a REPEATABLE READ READ ONLY transaction with no error). sluice's own code comment still claimed the old fallback, now correctly re-scoped to PG ≤15. A read replica is a legitimately good, consistency-preserving bulk-migrate source on modern Postgres — better than the ≤15 lore says.

## The CDC side got more fragile than &ldquo;impossible&rdquo;

The same PG 16 work made the CDC story worse in a subtler way than a flat &ldquo;no.&rdquo; A logical slot can be created on a PG 16+ standby now — but CREATE_REPLICATION_SLOT blocks until the primary emits its next xl_running_xacts WAL record. On an idle primary that record simply doesn't come, so the call hangs (≥2 minutes observed before it eventually proceeded once activity resumed). The documented nudge, pg_log_standby_snapshot(), is superuser-only, and managed platforms withhold it — Supabase returns permission denied. So the slot creation that &ldquo;works&rdquo; on a standby can stall indefinitely with no visible cause and no operator lever to unstick it.

sluice never even reaches that stall, because a step before it is a harder wall: CDC has to CREATE or ALTER its publication on the source, and publication DDL cannot run inside a read-only transaction on a hot standby at all. Pre-create a FOR ALL TABLES publication and sluice drops it to re-scope, which is itself a write; a scoped ALTER PUBLICATION … SET TABLE runs unconditionally on the same path. Either way the replica answers with cannot execute CREATE PUBLICATION in a read-only transaction (SQLSTATE 25006) — a raw error that reads like a sluice bug rather than a platform boundary.

## What sluice does about it

Since v0.99.267, sluice detects a standby source before it tries the publication write and refuses with a coded SLUICE-E-CDC-STANDBY-SOURCE that names the source as a read replica, steers to the primary endpoint for CDC, and notes that the replica remains a perfectly good bulk-migrate source. A belt on the raw SQLSTATE 25006 catches the same condition if it surfaces through a path the preflight didn't cover, so the operator never sees the steering-free raw error that looks like an internal failure. The migrate-from-standby capability is left fully intact — it is a bonus, not a thing to warn about.

## The transferable lesson

&ldquo;Replicas can't decode&rdquo; is a rule with a version number on it, and Postgres 16 moved the boundary under it in both directions at once — so a tool that treats the ≤15 lore as timeless is wrong twice: it under-uses the replica as a bulk source (the consistent snapshot is available now) and mis-describes the CDC wall (it isn't the slot that's impossible — it's the publication write, plus an idle-primary running-xacts stall the slot creation hides behind). When a capability is gated on the server's recovery state, pin down which major version you're on and which specific operation the platform actually blocks, and turn the raw platform error into a coded refusal that names the real boundary — because 25006 on its own reads like your bug, not the standby's rule.

## Primary sources

- PostgreSQL documentation — pg_export_snapshot() (usable during recovery from PG 16), logical decoding on standbys, and pg_log_standby_snapshot() (superuser-only).

- PostgreSQL error 25006 (read_only_sql_transaction) — why CREATE PUBLICATION can't run on a hot standby.

- sluice v0.99.267 changelog and the Supabase read-replica probe report (Bug 197) — the engaged shared snapshot on the standby, the idle-primary slot-creation hang, and the coded SLUICE-E-CDC-STANDBY-SOURCE refusal plus its 25006 belt.

- Related field note — every HA knob on, and the slot still vanished at failover (more standby/slot lifecycle surprises).

---
Canonical page: https://sluicesync.com/field-notes/read-replica-source-pg16/ · Full docs index: https://sluicesync.com/llms.txt
