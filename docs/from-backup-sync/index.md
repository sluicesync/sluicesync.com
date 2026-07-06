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

--apply-concurrency matters for cross-region targets. Each incremental's merged change stream is fanned across W in-order PK-hash lanes (same key → same lane → applied in source order), each committing concurrently on its own connection. Without it, a large incremental replayed into a high-latency target applies through a single RTT-bound stream and the broker falls behind. 0 (default) = auto:4; 1 = explicit serial; W>1 honored. Exactly-once is preserved — every change in an incremental carries the same chain position, so the lanes persist the identical resume position the serial path would.

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

The broker follows segment-rotation seams automatically and is restart-resilient on both sides — its idempotent applier absorbs any overlap on resume. Two consumers must use distinct --stream-ids for distinct targets, or they'll race on position writes. To rest the chain encrypted, the broker accepts the same encryption flags as the rest of the backup family — see the backup reference.

---
Canonical page: https://sluicesync.com/docs/from-backup-sync/ · Full docs index: https://sluicesync.com/llms.txt
