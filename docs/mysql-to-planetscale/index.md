# Migrate a self-hosted MySQL to PlanetScale

> Move an on-prem / self-hosted MySQL onto PlanetScale MySQL — a one-shot bulk migrate plus continuous binlog-CDC sync, so you cold-copy, keep the old primary writable, and cut over in a controlled window.

Moving a self-hosted / on-prem MySQL onto PlanetScale MySQL: sluice does a one-shot bulk migrate and a continuous binlog-CDC sync, so you cold-copy the data, keep the old primary writable while PlanetScale catches up, and cut over in a brief, controlled window. This guide is the self-hosted path — AWS RDS / Aurora and other managed MySQL are the same flow with a few connection and permission deltas (a follow-up covers those). Both ends are MySQL, so cross-engine value translation doesn't apply; the one thing that changes is that the target is Vitess-flavored MySQL, which affects two things — foreign keys and (before v0.99.199) index handling — both covered below. Live-verified on v0.99.199: local MySQL with binlog + GTID into a real PlanetScale database.

## Prepare the MySQL source

For a continuous sync the source has to emit a GTID-tagged row binlog. Set these on the source server (they need a restart if they aren't already on):

Setting · Value · Why ·

log_bin · on · Binary logging must be enabled for any CDC. ·

binlog_format · ROW · Row-based events carry the actual before/after values sluice replays. ·

gtid_mode · ON · GTID-based positioning for resumable, exactly-tracked replication. ·

enforce_gtid_consistency · ON · Required alongside gtid_mode=ON. ·

server_id · a unique value · Each server in a replication topology needs a distinct id. ·

The connecting user needs SELECT for the bulk copy plus REPLICATION SLAVE and REPLICATION CLIENT to stream the binlog:

    CREATE USER 'sluice'@'%' IDENTIFIED BY '<pw>';
    GRANT SELECT, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'sluice'@'%';

A one-shot migrate needs only SELECT. The binlog settings and the two REPLICATION grants are only required for a continuing sync. If you're taking a point-in-time copy with no live CDC, plain SELECT on the source is enough.

No server-id collision. sluice's binlog reader registers itself with its own random server_id, distinct from the source's, so joining the replication stream won't clash with the source or any existing replica.

## Create the PlanetScale target

Create the destination database in your chosen region:

    pscale database create <db> --region <region>

On PlanetScale a database is a Vitess keyspace. The database named in the DSN is that keyspace (its name defaults to the database name), and it must be pre-provisioned — sluice will not auto-create a Vitess keyspace. Mint an admin credential (pscale password create <db> <branch> --role admin, or the pscale connect flow) and assemble a standard go-sql-driver DSN against the global connect host:

    USER:PASS@tcp(aws.connect.psdb.cloud:3306)/<keyspace>?tls=true

?tls=true is required. Prefer environment variables (SLUICE_SOURCE / SLUICE_TARGET) over putting the DSN in argv, so credentials don't land in your shell history or process list.

Foreign keys are off by default on PlanetScale. Vitess rejects FOREIGN KEY DDL with VT10001 unless you turn support on per database. So either pass --skip-foreign-keys (skips the constraints but keeps each referencing column indexed) or enable "Allow foreign key constraints" on an unsharded database first. See Foreign keys on a Vitess / PlanetScale target for the full skip-vs-enable decision.

## Migrate

Preview the plan with --dry-run, run the copy, then verify:

    sluice migrate \
        --source-driver mysql       --source 'user:pw@tcp(HOST:3306)/db' \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --skip-foreign-keys --dry-run

    sluice migrate \
        --source-driver mysql       --source 'user:pw@tcp(HOST:3306)/db' \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --skip-foreign-keys

    sluice verify \
        --source-driver mysql       --source 'user:pw@tcp(HOST:3306)/db' \
        --target-driver planetscale --target "$SLUICE_TARGET"

Value fidelity is exact on the MySQL→MySQL path: in testing DECIMAL, ENUM, and DATETIME all round-tripped unchanged onto Vitess MySQL, row counts matched, and verify came back clean. --skip-foreign-keys reports each skipped FK and keeps the referencing columns indexed, so joins through them stay fast.

Use v0.99.199 or newer — earlier versions silently created only PRIMARY keys on a Vitess target. Secondary indexes — plain, unique, composite, and FK-backing — land correctly on v0.99.199+. On v0.99.30–v0.99.198 a migrate or sync into a PlanetScale / Vitess target silently created only the PRIMARY keys (a regression, now fixed). If you ran an earlier version, check your target's secondary indexes and rebuild any that are missing. As of v0.99.199 sluice also loud-fails with SLUICE-E-INDEX-MISSING if any expected index is absent after apply, so a silent recurrence can't happen.

## Keep it in sync & cut over

A continuous sync cold-copies the source, then tails the binlog — so the source stays writable the whole time and you flip traffic in a brief window. Launch the long-lived stream:

    sluice sync start --stream-id <id> \
        --source-driver mysql       --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --skip-foreign-keys

Live-verified: after the cold copy, inserts, updates, and deletes on the source replicate to PlanetScale within seconds. Watch it catch up from another shell, and gate cutover on freshness:

    sluice sync status --stream-id <id> \
        --target-driver planetscale --target "$SLUICE_TARGET"

    sluice sync health --stream-id <id> \
        --target-driver planetscale --target "$SLUICE_TARGET" --max-stale-seconds 30

When the stream is fresh, quiesce writes to the source, let it drain the last changes, stop the stream, and repoint the application at PlanetScale:

    sluice sync stop --stream-id <id> \
        --target-driver planetscale --target "$SLUICE_TARGET" --wait

sync stop needs the target too. Pass --target-driver and --target on sync stop (not just --stream-id) — the stop path connects to the target's control tables to drain and record the final position.

Scope to a subset of tables. Both migrate and sync start take --include-table / --exclude-table to move only some tables and keep just those in sync — see Copy a subset of tables.

## Next steps

- Foreign keys on a Vitess / PlanetScale target — the full skip-vs-enable decision for FK-bearing sources.

- Copy a subset of tables — scope a migrate or sync to just the tables you choose.

- Move PlanetScale regions — the PlanetScale→PlanetScale sibling flow (VStream, sharded keyspaces).

- PlanetScale & Vitess — the flavor, cold-start throughput knobs, and VStream lag reality in depth.

- Command reference and error codes — every flag named here, with defaults.

---
Canonical page: https://sluicesync.com/docs/mysql-to-planetscale/ · Full docs index: https://sluicesync.com/llms.txt
