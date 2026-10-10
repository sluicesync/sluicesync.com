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

Rotation needs every table keyed (v0.157.0+). Restoring a rotated chain re-writes each later segment's full over rows already restored, which a table with no PRIMARY KEY and no NOT NULL UNIQUE index cannot take. With --retain-rotate-at*, a new chain therefore refuses to start while any table it backs up is keyless (SLUICE-E-BACKUP-ROTATED-KEYLESS-TABLE, exit 3), and an existing chain WARNs ROTATION-KEYLESS-TABLE and runs with rotation suspended. Key those tables on the source with a NOT NULL UNIQUE index, or drop the rotation flag. Details: rotated chains and keyless tables.

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

--apply-concurrency matters for cross-region targets. Each incremental's merged change stream is fanned across W in-order PK-hash lanes (same key → same lane → applied in source order), each committing concurrently on its own connection. Without it, a large incremental replayed into a high-latency target applies through a single RTT-bound stream and the broker falls behind. 0 (default) = auto:4; 1 = explicit serial; W>1 honored. Both modes persist a position inside the incremental at source-transaction boundaries (v0.157.0+); the lanes record only a boundary every lane has committed. An interrupted incremental resumes at the first source transaction not durably applied, exactly-once where the chain records apply identities (next section).

## Replay safety: exactly-once resume, and when keyless tables are refused

v0.157.0 — who should check. Upgrading does not repair rows already affected.

- Anyone who re-ran an interrupted sync from-backup on v0.99.222 through v0.156.12 over a source that moves key values between rows (a transaction that frees a key and gives it to another row). The re-run re-applied the whole incremental, and could empty a table at exit 0. Compare the affected tables with the source (sluice verify --depth count or --depth sample); a count below the source's means a misapplied re-run. Rebuild with sync from-backup run --reset-target-data on this release.

- Anyone who passed --at-chain-id to a broker whose target already held a position (v0.20.0 through v0.156.12), especially after re-restoring the target to an earlier link. The flag was ignored and the broker resumed from the recorded position, so incrementals between the asserted and the recorded link may be missing. Anyone who passed --reset-target-data over an existing position got a warm resume instead; treat that as the re-run above.

v0.156.11 — who should check. Upgrading stops new duplication and renumbering; it does not repair rows already affected.

- sync from-backup brokers on v0.99.222 through v0.156.10 that were ever interrupted (an error, a crash, a supervisor restart, a SIGINT or SIGTERM, q/ctrl+c), over a chain carrying a table with no PRIMARY KEY and no NOT NULL UNIQUE index, or into a target table keyed only on a surrogate: the interrupted incremental was re-applied whole and its committed rows duplicated at exit 0. Run sluice verify --depth count against the backup's source database and the target; a target count above the source's on such a table is duplicated rows. After the upgrade the broker refuses those tables, so key them on the source and take a new full backup, or move them to sluice sync start — then rebuild or de-duplicate the target table.

- Brokers on v0.20.0 through v0.99.221 that were ever interrupted mid-incremental: the interruption was recorded as applied and the rest of the incremental skipped, in any table. Run sluice verify --depth count and re-copy any table whose target count is below the source's.

- Anyone who re-ran a restore onto the same target after a failed attempt, on any release through v0.156.10, where the backup carried a keyless table or the target table was keyed only on a surrogate. Compare those tables' row counts with the source.

- Cold copies into a pre-created, surrogate-keyed target (MySQL family on v0.99.92+, Postgres on v0.99.111+) whose log contains hit a transient target error: the re-sent batch could land twice. Compare that table's row count with the source. Such a copy now refuses with SLUICE-E-COPY-RETRY-AMBIGUOUS-KEYLESS instead of retrying.

- MySQL, MariaDB, Vitess and PlanetScale MySQL targets that received an AUTO_INCREMENT value of 0, on every release through v0.156.10 — a source row whose MySQL AUTO_INCREMENT column, or Postgres bigserial / identity column, held 0 landed under the next generated value at exit 0, on every write path into a MySQL-family target. On the source, list the rows with 0 in that column; if the target has no row with 0 there, find the row by its other columns and correct its key. A sharded keyspace whose column is filled by a vtgate sequence still replaces 0 after the upgrade, so avoid carrying 0 into one.

Resuming inside an incremental (v0.157.0+, ADR-0191). backup stream and backup incremental now record each change's apply identity (the source's transaction id and the change's ordinal in it) in the change chunk, and the incremental's manifest says so with apply_identity. The broker hands those identities to the same exactly-once apply marks sync start uses (sluice_cdc_apply_marks). Its position can also stand inside an incremental: in the same target transaction as the work, at each source-transaction boundary, it records the incremental's id, a digest of its chunk list and the event it has applied through. So when a run is interrupted partway through an incremental (an apply error, a chunk that failed to fetch, a crash, a SIGINT or SIGTERM, a supervisor restart), the next run re-reads that incremental, skips what is already applied and re-delivers from the first source transaction not durably applied. On serial apply that is the one in flight; on the lane apply mode it is the transactions whose lanes had not all committed. The marks then skip any re-delivered change that already landed, so the re-run is exactly-once, key changes and tables without a key included. Through v0.156.12 the broker re-applied the whole incremental instead.

- Changes without an identity. A change the source reader cannot name is recorded without one: a VStream COPY row or interleaved shard group, a MySQL transaction without a GTID or server identity, or a row the capture synthesized (such as an ADD COLUMN fill). On a keyed table it re-applies without marks and converges by key, except for a key moved onto another row inside the one interrupted transaction; the broker logs the WARN BROKER-UNIDENTIFIED-CHANGES once per such incremental, with the count. It is routine on VStream chains. On a keyless table it is refused (below).

- Incrementals without identities. A chain written by an older sluice records none, and neither does any incremental backup compact --smart-compaction rewrote, since collapsing changes across transactions drops them. There the in-flight transaction is re-applied without marks. A table with a PRIMARY KEY or NOT NULL UNIQUE index made of columns the replayed rows carry absorbs that, because the re-applied INSERT upserts on the key. A table with neither would gain a duplicate of every row of that transaction the interrupted run had committed, and so would a target table keyed only on a surrogate the rows do not carry (bigserial, identity, DEFAULT gen_random_uuid(), MySQL AUTO_INCREMENT or a DEFAULT-expression key), because every re-applied row draws a fresh key value and collides with nothing.

- A rewritten incremental. If the incremental the broker is inside was rewritten between the two runs (smart compaction), a different incremental now follows the last one fully applied, or it decodes to fewer events than the position counted, the skip would be counted over a different stream. The broker refuses with SLUICE-E-BROKER-INCREMENTAL-REWRITTEN (exit 3) before applying anything of it. Recover with --reset-target-data. Plain backup compact moves the same chunk bytes and resumes normally, so do not smart-compact a segment a broker still has to replay.

Keyless tables. The broker judges each incremental before applying any of it, for the tables that incremental touches, and refuses with SLUICE-E-BROKER-KEYLESS-TABLE (exit 3) when a table has no key the replayed rows carry and the replay cannot be made exactly-once. The message says which of these applies: the incremental records no identities; a change to the table inside it carries none (BROKER-KEYLESS-NO-IDENTITY); or the target's apply marks cannot cover the table — unusable by the role (APPLY-MARKS-UNAVAILABLE), a PlanetScale Postgres (Neki) target, a target engine without apply marks such as SQLite, or a target keyed only on a column the rows do not carry. The check also runs at start for the incremental a broker is inside or about to start, so a restart learns of a refusal before anything is written, and on a --reset-target-data cold start before the drop. A mark table that becomes unusable after the check refuses the apply rather than letting it run without marks. After an upgrade from v0.156.12 or older mid-incremental, the next incremental may have been partly applied with no marks to skip it, so a keyless table in it refuses with BROKER-CLASSIC-RESUME in the reason; the incrementals after it are judged normally. The broker has no table filter, so every table in the chain is in scope. v0.156.11 and v0.156.12 refused every keyless table in the chain at start, whatever the incremental. Each table's key is judged twice, and the message says which judgment failed:

- The chain's recorded schema — what the source declared: a PRIMARY KEY or a NOT NULL UNIQUE index. A partial UNIQUE index does not count, since a replayed row outside its predicate collides with nothing.

- The live target table — whether a re-written row actually collides. On Postgres, the ON CONFLICT arbiter the applier itself picks (the PRIMARY KEY before any UNIQUE index) must be made entirely of columns the rows supply, so a supplied UNIQUE index beside an unsupplied surrogate primary key does not count. On the MySQL family, some PRIMARY KEY or UNIQUE index of NOT NULL, non-generated columns must be fully supplied. On a multi-shard Vitess or PlanetScale keyspace, every primary-vindex column must also be supplied, because a key there is enforced per shard and a re-sent row without its routing column lands on another shard; the probe reads the keyspace's shards and the table's primary vindex (SHOW VSCHEMA VINDEXES ON) and fails closed if the target credentials cannot run them (measured on vttestserver; whether PlanetScale's restricted roles allow these reads is unverified). A generated key column never counts as supplied. A view, foreign table or materialized view under a chain table's name on a Postgres target is refused too.

The remedy depends on the reason the message gives. For an incremental without identities, --reset-target-data restores the chain through its tail, and the broker then judges only the incrementals that follow — which an upgraded writer records with identities, so upgrade the producer (backup stream / backup incremental) as well as the broker. For the target's apply marks, make them usable (a role that may create and write sluice_cdc_apply_marks). Otherwise put a key on the source and take a new full backup, so the chain's recorded schema carries it (then start on the new chain with --reset-target-data, or --at-chain-id after restoring it yourself); for a table keyless only on the target, give the target table the source's key rather than a surrogate; or replicate those tables with sync start instead.

Without identities, a key-changing transaction does not converge on a re-run. This applies only to an incremental that records no identities; on one that does, both shapes below converge. Re-applying the in-flight transaction converges for inserts, and for updates and deletes that keep each row's key. A transaction that changed a row's key value re-inserts a row the interrupted run had already moved, and the move then collides with the moved copy, so the re-run fails on a duplicate key (MySQL 1062 / Postgres 23505) on every attempt — in the lane apply mode, possibly after committing part of it. And when a key value was moved off one row and onto another inside that transaction, the re-run can apply a change to the wrong row with no error at all. If your source changes key values inside a transaction and the incremental records no identities, recover it with --reset-target-data, not by re-running.

### Severed transactions in the chain (v0.156.12+)

Separately from re-applying an interrupted incremental, a chain an older backup stream wrote can carry one source transaction across two incrementals — a window that ended inside a source transaction (shape A), or, on Postgres chains written before v0.138.0, a resume that re-delivered the previous window's last transaction (shape B) — or an incremental whose EndPosition is past its last stored change, the old cancel-drain loss (shape C). On every tick that brings new incrementals, before applying them, the broker runs the same severed-transaction check chain restore runs, over the whole chain:

- A finding on a link the broker has not applied yet refuses (exit 3) — SLUICE-E-BACKUP-CHAIN-SEVERED-TRANSACTION for shapes A and B, SLUICE-E-BACKUP-INCOMPLETE for shape C — before anything of that tick is applied. There is no override; the remedy is a new full backup and a new chain.

- A finding on a link it already applied — by an older binary, or a pre-v0.138.0 Postgres resume — cannot be undone by refusing, so it is logged once per run as the WARN CHAIN-APPLIED-SEVERED-TRANSACTION, naming the links, and the broker continues. Grep the broker log for that marker and compare the tables those links touched with the source (sluice verify --depth count), or rebuild the target from a new full backup.

Shape B is judged only when replaying into Postgres (it needs the source engine's position order). A current backup stream never writes a window that ends inside a source transaction — see who should check for chains written before v0.156.12.

## 3. Cold-start vs warm-resume

On its first launch against a chain, the broker has no sluice_cdc_state row for the chosen --stream-id, so it doesn't know where in the chain to begin and refuses loudly. There are two ways past that, mutually exclusive:

- --reset-target-data — drop the target's tables, run a chain restore (full + every incremental up to the tail), then transition to live polling. The full from-the-chain rebuild; suitable when the target is empty or you want a clean rebuild. Prompts (type reset) unless --yes.

- --at-chain-id <ID> — operator-asserted resume: tell the broker the target is already at chain ID <ID> (e.g. you just ran a manual sluice restore to bring the target up to a known checkpoint). It writes a fresh state row and tails forward from there — no re-bulking.

Over an existing position (v0.157.0+). Both flags are now read even when the target already holds this stream's broker position; through v0.156.12 the warm resume ran first and both were ignored. --reset-target-data is honoured over any broker-owned position, readable or not: after its pre-drop checks it clears the stream's sluice_cdc_state row and its sluice_cdc_apply_marks rows, then drops and restores as on a fresh target, so a crash mid-reset leaves no position to resume onto a half-restored target. --at-chain-id asserts what a target with no position holds. Over an existing one it is accepted only when it names the link the position records as last fully applied, with nothing in progress; any other value refuses with BROKER-AT-CHAIN-ID-CONFLICT (exit 1) before anything is applied, and repeats on every restart until you drop the flag, use --reset-target-data, or clear the position. If you restored the target to an earlier link yourself, delete the stream's row from sluice_cdc_state and its rows from sluice_cdc_apply_marks first, then pass --at-chain-id. A position owned by a non-broker writer is refused with or without either flag. Cold starts and chain restore clear the stream's apply marks before applying anything, so a mark left by an earlier run under the same stream id cannot skip a change the fresh target never received.

Downgrading a broker is not in place (v0.157.0). The broker's position token is now backup-broker-v2. v0.156.12 and older read it as owned by a non-broker writer and refuse before they look at --at-chain-id. To downgrade, delete the stream's row from sluice_cdc_state and its rows from sluice_cdc_apply_marks (or choose a new --stream-id), then start the older binary with --at-chain-id=<the deleted row's last_applied_backup_id>. It re-applies any incremental the newer broker was inside whole, without marks, as it always did. Chains the new producer writes still restore on v0.156.12: the added aid chunk field and apply_identity manifest flag are ignored by older binaries.

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

- While an incremental is being applied — part of it may be committed and the position was not advanced, so the run returns an error carrying BROKER-INCREMENTAL-PARTIAL (exit 1) naming the incremental. Re-running the same command resumes at the source transaction that was in flight (v0.157.0+). When the incremental records identities that re-run is exactly-once, and it is the whole recovery whatever the transaction did. When it records none, the re-run converges only if that transaction changed no key value (see above); a source that changes key values recovers with --reset-target-data.

- During a --reset-target-data cold start, once its drop has begun — the target holds a partial restore and no position, so it returns BROKER-COLD-START-PARTIAL (exit 1). Re-run with --reset-target-data; never start that target with --at-chain-id.

Through v0.156.10 both of the latter exited 0 and the panel printed "stopped." — supervisors that treat a cancel's exit status as success should expect the change.

Separately, a broker that reaches a severed-transaction finding on a link it has not applied yet exits 3 (v0.156.12+) with SLUICE-E-BACKUP-CHAIN-SEVERED-TRANSACTION or SLUICE-E-BACKUP-INCOMPLETE; restarting repeats it, so alert on it rather than counting on the retry. A finding on a link it already applied only WARNs CHAIN-APPLIED-SEVERED-TRANSACTION and the broker keeps running.

The broker follows segment-rotation seams automatically and resumes from its persisted position after a restart on either side, inside an interrupted incremental at the source transaction that was in flight (see replay safety). Two consumers must use distinct --stream-ids for distinct targets, or they'll race on position writes. To rest the chain encrypted, the broker accepts the same encryption flags as the rest of the backup family — see the backup reference.

---
Canonical page: https://sluicesync.com/docs/from-backup-sync/ · Full docs index: https://sluicesync.com/llms.txt
