<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# Continuous sync from a backup chain (the broker)

> Replay a backup chain into a target as a long-running broker — no direct source↔target connectivity required.

The broker (sluice sync from-backup run) replicates by reading a backup chain instead of connecting to the source's CDC stream directly. One sluice process produces the chain from the source; another tails it and applies the changes to a target. The backup store — S3 / GCS / Azure Blob / local FS — is the message log between them. Reach for this when the source and target can't (or shouldn't) talk directly: an air-gapped target, cross-region DR where the chain already crosses the boundary, or fanning one chain out to several targets.

The broker trades latency and throughput for the decoupled-transport property. If your source and target can reach each other directly, sync start is lower-latency and higher-throughput — use it instead. The broker is for moderate volumes with decoupled transport.

## 1. Produce the chain

On the source side, take a full backup to root the chain, then keep it fed with incrementals. On Postgres add --chain-slot to the full so it provisions the replication slot that anchors the chain (incrementals then chain with zero gap):

    sluice backup full --source-driver postgres --source 'postgres://...source...' \
        --target s3://my-bucket/app-chain \
        --backup-endpoint https://<account>.r2.cloudflarestorage.com \
        --backup-region auto --backup-path-style \
        --chain-slot

Then feed it. Either run periodic incrementals from a scheduler:

    sluice backup incremental --source-driver postgres --source 'postgres://...source...' \
        --target s3://my-bucket/app-chain \
        --backup-endpoint https://<account>.r2.cloudflarestorage.com \
        --backup-region auto --backup-path-style

…or run a continuous producer that commits rolling incrementals on a cadence (a long-lived process — run it under systemd / k8s). --rollover-window sets how often it commits an incremental; --retain-rotate-at-chain-length rotates into a fresh segment to keep segments compact for pruning:

    sluice backup stream run --source-driver postgres --source 'postgres://...source...' \
        --target s3://my-bucket/app-chain \
        --backup-endpoint https://<account>.r2.cloudflarestorage.com \
        --backup-region auto --backup-path-style \
        --rollover-window 10s \
        --retain-rotate-at-chain-length 20

Stopping the producer under a supervisor (v0.156.12+). A window never ends inside a source transaction, so stop the producer with sluice backup stream stop and wait for the process to exit — inside a transaction it reads on to the commit, for up to 60 s / 1,000,000 changes, before closing the rollover (or abandoning it if the budget runs out). Send SIGTERM only as the fallback: a signal inside a transaction abandons the in-flight window at once (exit 0, WARN BACKUP-WINDOW-ABANDONED-OPEN-TRANSACTION), and the next run re-reads it. Under systemd, use ExecStop= running backup stream stop plus a wait on the process, with TimeoutStopSec above 60 s; under Kubernetes, a preStop hook doing the same, with terminationGracePeriodSeconds above 60 s. A supervisor that restarts the producer more often than the rollover window (default 5 minutes / 100,000 changes) means the chain never advances. Details: stopping a stream.

## 2. Replay it into the target

On the consumer side, point the broker at the same chain. It reads the chain's catalog every --poll-interval, applies any incrementals newer than its persisted position in chain order, and persists progress in the target's sluice_cdc_state. The --stream-id is required so it can resume cleanly after a restart:

    sluice sync from-backup run \
        --backup-target s3://my-bucket/app-chain \
        --backup-endpoint https://<account>.r2.cloudflarestorage.com \
        --backup-region auto --backup-path-style \
        --target-driver postgres --target 'postgres://...target...' \
        --stream-id app-broker \
        --apply-concurrency 4 \
        --poll-interval 10s

--apply-concurrency matters for cross-region targets. Each incremental's merged change stream is fanned across W in-order PK-hash lanes (same key → same lane → applied in source order), each committing concurrently on its own connection. Without it, a large incremental replayed into a high-latency target applies through a single RTT-bound stream and the broker falls behind. 0 (default) = auto:4; 1 = explicit serial; W>1 honored. The lanes persist the same position as serial apply — every change in an incremental carries the same chain position. Replay itself is at-least-once in both modes: an interrupted incremental is re-applied whole and converges by key (next section).

## Replay safety: keyless tables are refused (v0.156.11+)

v0.156.11 — who should check. Upgrading stops new duplication and renumbering; it does not repair rows already affected.

- sync from-backup brokers on v0.99.222 through v0.156.10 that were ever interrupted (an error, a crash, a supervisor restart, a SIGINT or SIGTERM, q/ctrl+c), over a chain carrying a table with no PRIMARY KEY and no NOT NULL UNIQUE index, or into a target table keyed only on a surrogate: the interrupted incremental was re-applied whole and its committed rows duplicated at exit 0. Run sluice verify --depth count against the backup's source database and the target; a target count above the source's on such a table is duplicated rows. After the upgrade the broker refuses those tables, so key them on the source and take a new full backup, or move them to sluice sync start — then rebuild or de-duplicate the target table.

- Brokers on v0.20.0 through v0.99.221 that were ever interrupted mid-incremental: the interruption was recorded as applied and the rest of the incremental skipped, in any table. Run sluice verify --depth count and re-copy any table whose target count is below the source's.

- Anyone who re-ran a restore onto the same target after a failed attempt, on any release through v0.156.10, where the backup carried a keyless table or the target table was keyed only on a surrogate. Compare those tables' row counts with the source.

- Cold copies into a pre-created, surrogate-keyed target (MySQL family on v0.99.92+, Postgres on v0.99.111+) whose log contains hit a transient target error: the re-sent batch could land twice. Compare that table's row count with the source. Such a copy now refuses with SLUICE-E-COPY-RETRY-AMBIGUOUS-KEYLESS instead of retrying.

- MySQL, MariaDB, Vitess and PlanetScale MySQL targets that received an AUTO_INCREMENT value of 0, on every release through v0.156.10 — a source row whose MySQL AUTO_INCREMENT column, or Postgres bigserial / identity column, held 0 landed under the next generated value at exit 0, on every write path into a MySQL-family target. On the source, list the rows with 0 in that column; if the target has no row with 0 there, find the row by its other columns and correct its key. A sharded keyspace whose column is filled by a vtgate sequence still replaces 0 after the upgrade, so avoid carrying 0 into one.

The broker stamps every change of an incremental with the position of the incremental before it, and advances its position only once the whole incremental has applied. Those changes carry no apply identity, so the exactly-once apply marks sync start uses cannot skip any of them: an interruption partway through an incremental — an apply error, a chunk that failed to fetch, a crash, a SIGINT or SIGTERM, a supervisor restart — makes the next run re-apply all of it. A table keyed by a PRIMARY KEY or NOT NULL UNIQUE index made of columns the replayed rows carry absorbs that, because the re-applied INSERT upserts on the key. A table with neither would gain a duplicate of every row the interrupted run had committed, and so would a target table keyed only on a surrogate the rows do not carry (bigserial, identity, DEFAULT gen_random_uuid(), MySQL AUTO_INCREMENT or a DEFAULT-expression key), because every re-applied row draws a fresh key value and collides with nothing.

So the broker refuses with SLUICE-E-BROKER-KEYLESS-TABLE (exit 3, no override) before it applies anything when any table the chain records has no such key: on warm resume, before an --at-chain-id position write, before a --reset-target-data drop, and before each tick that brings a table not yet judged (a table already judged is judged again before any incremental whose schema change alters its definition). The broker has no table filter, so every table in the chain is in scope. Each table is judged twice, and the message says which judgment failed:

- The chain's recorded schema — what the source declared: a PRIMARY KEY or a NOT NULL UNIQUE index. A partial UNIQUE index does not count, since a replayed row outside its predicate collides with nothing.

- The live target table — whether a re-written row actually collides. On Postgres, the ON CONFLICT arbiter the applier itself picks (the PRIMARY KEY before any UNIQUE index) must be made entirely of columns the rows supply, so a supplied UNIQUE index beside an unsupplied surrogate primary key does not count. On the MySQL family, some PRIMARY KEY or UNIQUE index of NOT NULL, non-generated columns must be fully supplied. On a multi-shard Vitess or PlanetScale keyspace, every primary-vindex column must also be supplied, because a key there is enforced per shard and a re-sent row without its routing column lands on another shard; the probe reads the keyspace's shards and the table's primary vindex (SHOW VSCHEMA VINDEXES ON) and fails closed if the target credentials cannot run them (measured on vttestserver; whether PlanetScale's restricted roles allow these reads is unverified). A generated key column never counts as supplied. A view, foreign table or materialized view under a chain table's name on a Postgres target is refused too.

The remedy is a key on the source and a new full backup, so the chain's recorded schema carries it (then start on the new chain with --reset-target-data, or --at-chain-id after restoring it yourself); for a table keyless only on the target, give the target table the source's key rather than a surrogate; or replicate those tables with sync start instead. Exactly-once broker replay — an apply identity per change, so the marks can skip what already landed — is the open follow-up that will lift this refusal.

A key-changing incremental does not converge on a re-run. Even on a keyed table, re-applying a whole incremental converges only for inserts, and for updates and deletes that keep each row's key. An incremental that changed a row's key value re-inserts a row the interrupted run had already moved, and the move then collides with the moved copy, so the re-run fails on a duplicate key (MySQL 1062 / Postgres 23505) on every attempt — in the lane apply mode, possibly after committing part of the incremental. And when a key value was moved off one row and onto another inside the incremental, the re-run can apply a change to the wrong row with no error at all. If your source changes key values, recover an interrupted incremental with --reset-target-data, not by re-running.

### Severed transactions in the chain (v0.156.12+)

Separately from re-applying an interrupted incremental, a chain an older backup stream wrote can carry one source transaction across two incrementals — a window that ended inside a source transaction (shape A), or, on Postgres chains written before v0.138.0, a resume that re-delivered the previous window's last transaction (shape B) — or an incremental whose EndPosition is past its last stored change, the old cancel-drain loss (shape C). On every tick that brings new incrementals, before applying them, the broker runs the same severed-transaction check chain restore runs, over the whole chain:

- A finding on a link the broker has not applied yet refuses (exit 3) — SLUICE-E-BACKUP-CHAIN-SEVERED-TRANSACTION for shapes A and B, SLUICE-E-BACKUP-INCOMPLETE for shape C — before anything of that tick is applied. There is no override; the remedy is a new full backup and a new chain.

- A finding on a link it already applied — by an older binary, or a pre-v0.138.0 Postgres resume — cannot be undone by refusing, so it is logged once per run as the WARN CHAIN-APPLIED-SEVERED-TRANSACTION, naming the links, and the broker continues. Grep the broker log for that marker and compare the tables those links touched with the source (sluice verify --depth count), or rebuild the target from a new full backup.

Shape B is judged only when replaying into Postgres (it needs the source engine's position order). A current backup stream never writes a window that ends inside a source transaction — see who should check for chains written before v0.156.12.

## 3. Cold-start vs warm-resume

On its first launch against a chain, the broker has no sluice_cdc_state row for the chosen --stream-id, so it doesn't know where in the chain to begin and refuses loudly. There are two ways past that, mutually exclusive:

- --reset-target-data — drop the target's tables, run a chain restore (full + every incremental up to the tail), then transition to live polling. The full from-the-chain rebuild; suitable when the target is empty or you want a clean rebuild. Prompts (type reset) unless --yes.

- --at-chain-id <ID> — operator-asserted resume: tell the broker the target is already at chain ID <ID> (e.g. you just ran a manual sluice restore to bring the target up to a known checkpoint). It writes a fresh state row and tails forward from there — no re-bulking.

The common case is the post-restore cold-start: bulk-copy the chain once with sluice restore, then launch the broker with --at-chain-id set to that restore's tail manifest. Pass the flag only on the first launch; every subsequent restart warm-resumes from sluice_cdc_state automatically and needs neither flag:

    # first launch after a fresh restore
    sluice sync from-backup run --backup-target s3://my-bucket/app-chain \
        --target-driver postgres --target 'postgres://...target...' \
        --stream-id app-broker --apply-concurrency 4 --poll-interval 10s \
        --at-chain-id 9b12b8ccdc3e7fa9725825ab032e6d6d41d3db09

    # every restart after that — warm-resume, no recovery flag
    sluice sync from-backup run --backup-target s3://my-bucket/app-chain \
        --target-driver postgres --target 'postgres://...target...' \
        --stream-id app-broker --apply-concurrency 4 --poll-interval 10s

## 4. Stopping cleanly

Stop the broker by writing a stop signal to the chain destination — the running process observes it on its next tick and exits cleanly. Because the signal lives in the store, you can stop a broker from a different host without process access (both sides agree on the chain, not on the host):

    sluice sync from-backup stop --backup-target s3://my-bucket/app-chain

Exit codes on stop and cancel (v0.156.11+). sluice sync from-backup stop is observed only between ticks, so it never interrupts an incremental and the broker exits 0; use it to stop a broker deliberately. A SIGINT or SIGTERM — or q/ctrl+c on the live panel — cancels immediately:

- Between incrementals or between ticks — nothing of an unadvanced incremental was applied; exit 0.

- While an incremental is being applied — part of it may be committed and the position was not advanced, so the run returns an error carrying BROKER-INCREMENTAL-PARTIAL (exit 1) naming the incremental. Re-running the same command re-applies all of it, which converges only if the incremental changed no key value (see above); a source that changes key values recovers with --reset-target-data.

- During a --reset-target-data cold start, once its drop has begun — the target holds a partial restore and no position, so it returns BROKER-COLD-START-PARTIAL (exit 1). Re-run with --reset-target-data; never start that target with --at-chain-id.

Through v0.156.10 both of the latter exited 0 and the panel printed "stopped." — supervisors that treat a cancel's exit status as success should expect the change.

Separately, a broker that reaches a severed-transaction finding on a link it has not applied yet exits 3 (v0.156.12+) with SLUICE-E-BACKUP-CHAIN-SEVERED-TRANSACTION or SLUICE-E-BACKUP-INCOMPLETE; restarting repeats it, so alert on it rather than counting on the retry. A finding on a link it already applied only WARNs CHAIN-APPLIED-SEVERED-TRANSACTION and the broker keeps running.

The broker follows segment-rotation seams automatically and resumes from its persisted position after a restart on either side, re-applying an interrupted incremental whole (see replay safety). Two consumers must use distinct --stream-ids for distinct targets, or they'll race on position writes. To rest the chain encrypted, the broker accepts the same encryption flags as the rest of the backup family — see the backup reference.

---
Canonical page: https://sluicesync.com/docs/from-backup-sync/ · Full docs index: https://sluicesync.com/llms.txt
