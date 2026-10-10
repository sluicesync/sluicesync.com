<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# Take encrypted backups

> sluice's logical backup model in depth — chains, compression, encryption at rest, object stores, retention, and restore.

sluice's backup verb takes logical, row-level, cross-engine backups: a full snapshot that roots a chain, plus CDC-based incrementals appended onto it, written to storage you own. Unlike a physical tool (pgBackRest, WAL-G, XtraBackup), a sluice chain restores into Postgres or MySQL from either, with redaction and encryption already applied in the pipeline. This guide is the reference for the model — the getting-started section is the quick tour; here we go deeper into encryption, the format-version contract, retention, and restore.

Logical, not physical. sluice is deliberately not in pg_basebackup / WAL-archive territory — those tools are excellent at same-engine PITR at scale, and that lane is theirs. sluice's value is the cross-engine, operator-owned-storage, encrypt-and-redact-at-capture angle. Many setups run both: physical for primary DR, a sluice chain for the off-vendor / cross-engine / compliance copy.

## The chain model

A backup is a chain. The full snapshot (backup full) is the root; each incremental (backup incremental) captures the change events since the previous link and appends a new segment. The full is engine-neutral (any registered source, including a sqlite file); incrementals need a CDC-capable source (Postgres / MySQL natively, or the sqlite-trigger / d1-trigger engines).

On Postgres, the chain is anchored by a replication slot. Pass --chain-slot to backup full and the full provisions the persistent slot (named by --slot-name, default sluice_slot) as the snapshot anchor and ensures the publication exists — so the next backup incremental chains with zero gap by construction, no manual slot management:

    # full snapshot to a local directory, provisioning the chain anchor
    sluice backup full --source-driver postgres --source 'postgres://...' \
        --output-dir /var/backups/app --chain-slot

    # append an incremental (chains off the most recent manifest)
    sluice backup incremental --source-driver postgres --source 'postgres://...' \
        --output-dir /var/backups/app

Why --chain-slot matters. Creating a slot after a full and expecting the next incremental to fill the gap is a silent-loss trap: PostgreSQL fast-forwards START_REPLICATION to the slot's confirmed_flush_lsn without complaint, so every write in between vanishes from the chain. --chain-slot provisions the slot at the snapshot anchor so there is no gap; a chain-resume preflight then refuses loudly if a slot can't serve the parent position (ADR-0083). To abandon a chain, drop the slot with sluice slot drop — it holds source-side WAL until the next incremental consumes it.

Chain off a specific parent with --since <backup-id> (default: the most recent manifest). Each incremental's window closes on --window (wall-clock, default 5m) or --max-changes (event count), whichever fires first, and is always extended to the next transaction commit so a chain never ends mid-transaction.

## Compression

Chunks are compressed per segment. The codec is --compression none|gzip|zstd, and the default is zstd (klauspost/compress at SpeedDefault): 55–85% faster restore — the recovery-time-critical axis — for ~1–5% larger artifacts than gzip. none leaves chunks as human-readable .jsonl on a local-FS target; gzip is the pre-v0.67.0 codec. The codec is recorded in lineage.json and read back from there on restore — it is never inferred from the bytes, so a mixed-codec chain restores correctly.

## Encryption at rest

Add --encrypt to rest the whole chain under client-side envelope encryption: sluice generates a content-encryption key (CEK), encrypts every chunk with it, and wraps the CEK under a key-encryption key (KEK) you supply. --encrypt requires exactly one key source — a passphrase or a cloud KMS key — and the same flag is read on the restore / verify / broker side to unwrap. The two modes are mutually exclusive and cannot be mixed within a single chain.

### Passphrase mode

Supply the passphrase from an environment variable or a file — never on the command line, where it lands in shell history:

    export SLUICE_BACKUP_PASS='correct horse battery staple'
    sluice backup full --source-driver postgres --source 'postgres://...' \
        --output-dir /var/backups/app --chain-slot \
        --encrypt --encryption-passphrase-env SLUICE_BACKUP_PASS

Flag · Purpose ·

--encryption-passphrase-env · Read the passphrase from the named environment variable. Recommended for production. ·

--encryption-passphrase-file · Read the passphrase from a file path (a trailing newline is trimmed). Best for secrets-manager integrations — 1Password CLI, AWS Secrets Manager, etc. ·

--encryption-passphrase · Inline passphrase. Deprecated for production — it shows up in shell history. Use one of the two above. ·

sluice derives the KEK from the passphrase with Argon2id and records the salt + cost parameters in the chain-root manifest. Incrementals and restores re-derive the same KEK from those recorded params — so an operator only ever has to remember the passphrase, and every link in the chain unwraps consistently.

### Cloud KMS mode

Instead of a passphrase, wrap the CEK through a cloud KMS. The KMS root key never leaves the provider — sluice routes only wrap/unwrap calls:

Flag · Provider ·

--kms-key-arn · AWS KMS key ARN, alias ARN, or alias/name. Pair with --kms-region to override region resolution. Auth follows the AWS SDK (env / profile / instance role). ·

--gcp-kms-key-resource · GCP Cloud KMS crypto-key resource (projects/.../cryptoKeys/KEY). Auth via Application Default Credentials. ·

--azure-key-vault-id · Azure Key Vault key identifier URL. Override the wrap algorithm with --azure-wrap-algorithm (default RSA-OAEP-256; HSM-backed AES keys need A256KW). Auth via DefaultAzureCredential. ·

    # full backup to R2, envelope-encrypted under an AWS KMS key
    sluice backup full --source-driver postgres --source 'postgres://...' \
        --target s3://my-bucket/app-chain \
        --backup-endpoint https://<account>.r2.cloudflarestorage.com \
        --backup-region auto --backup-path-style \
        --chain-slot \
        --encrypt --kms-key-arn arn:aws:kms:us-east-1:111122223333:key/abcd-1234

The KMS flags are mutually exclusive with each other and with the passphrase flags. Setting a key source without --encrypt is a loud error, not a silent plaintext backup.

### Per-chain vs per-chunk

--encrypt-mode chooses the CEK granularity: per-chain (default) uses one CEK for the whole chain — a single KEK derive / KMS Decrypt per restore; per-chunk uses a fresh CEK per chunk for defense-in-depth at the cost of a per-chunk wrap. Most operators want the default.

One mode per chain. A chain uses a single encryption mode for every segment. Set --encrypt-mode per-chain or per-chunk on the backup full that roots the chain; on each backup incremental, backup stream, or resumed backup full, omit --encrypt-mode so the segment inherits the chain's mode. Passing an explicit mode that conflicts with the chain's recorded mode is refused at build time (as of v0.99.185) rather than silently producing a mixed-mode chain.

## The FormatVersion refuse-before-touch contract

Every chain-root manifest carries a FormatVersion. It exists to prevent one specific silent-loss class: an older sluice binary restoring a chain and silently dropping security-or-correctness metadata it doesn't understand.

- FormatVersion=1 — the schema uses none of the gated features. Any sluice from v0.16.x onward restores it.

- FormatVersion=2 — the schema contains at least one of: row-level security enabled or forced, one or more RLS policies, or one or more EXCLUDE constraints. Only sluice v0.94.1+ restores it.

- FormatVersion=4 — the schema carries one or more standalone sequences (v0.99.175+). An older binary would silently restore the target without the sequence object — its custom START/INCREMENT options and nextval() topology gone — so it refuses loudly at preflight instead.

- FormatVersion=5 — an encrypted manifest (--encrypt, v0.99.202+). Its row chunks are AES-256-GCM ciphertext; an older binary that predates encryption refuses rather than mis-reading them.

- FormatVersion=6 — a signed encrypted manifest (--sign, v0.99.208+). The manifest carries a signature over its canonical bytes; a binary that can't verify it refuses rather than restoring an unverified signed chain.

- FormatVersion=7 — an encrypted manifest whose row chunks additionally bind their parent table into the GCM associated data (v0.99.214 signed / v0.99.219 unsigned), closing a store-adversary chunk-reassignment attack between two same-column-set tables.

- FormatVersion=8 — a CDC-segment manifest (incremental / streaming) from a VStream source (PlanetScale/Vitess) that folds its position-semantics flag into the deterministic BackupID (v0.99.228+). Only VStream CDC segments are stamped 8; full backups and non-VStream segments keep their feature-minimum version. An older binary refuses a v8 manifest at preflight rather than recompute-mismatching its id.

- FormatVersion=9 — an encrypted manifest whose chunk-binding associated data is injective (length-prefixed rather than concatenated), so two different (table, chunk) pairs can no longer render the same AAD string (ADR-0181; minimum reader v0.104.0).

- FormatVersion=10 — a redacted manifest, written by backup full --redact, recording that its chunks were redacted plus a fingerprint of the policy (v0.144.0). This one exists specifically to be refused: an older binary ignores a member it doesn't know, so without the version bump it would happily extend a redacted chain with plaintext incrementals. Only redacted manifests are stamped 10 — an ordinary backup records no marker and keeps its feature-minimum version, so unredacted chains stay readable by older binaries.

- FormatVersion=11 — a positionless full: a backup full that finalized with an empty end position on a source whose CDC reader resumes from a recorded position — a PlanetScale Neki router, or a MySQL server with its binary log off (v0.154.0+). A pre-v0.153.1 binary would read the empty position as a legacy full and extend the chain from the source's current position, silently skipping every change in between; the bump makes every pre-v0.154.0 reader refuse it instead. Such a full is a complete, restorable backup on its own, but roots a chain on no binary. A full that records a position, every incremental, and every full from a CDC-less source keep their feature-minimum version.

- FormatVersion=12 — an exact-numbers change segment (v0.156.4+): a postgres-trigger backup incremental or backup stream segment (including the ADD COLUMN fill segment it carries) at least one of whose change chunks carried a number the capture holds exactly — an unconstrained numeric, a jsonb number, a double precision/real value, or an array element of those. A segment touching a numeric(p,s) column with a scale is stamped too, because the capture carries the scale digits. Exempt: integers, and plain integers of up to 15 digits inside a jsonb document, which a float carries exactly. The chunk bytes did not change with the v0.156.4 fix, so an older binary would round such a chain again; the bump makes v0.156.3 and older refuse it instead. Fulls, other engines' segments, and trigger segments whose changes carried only integers, text and other non-numeric families keep their previous version and stay readable everywhere.

FormatVersion=3 is a special case: it marks an in-progress full backup in the sidecar-checkpoint layout (v0.99.39+) and is never stamped on a finalized manifest. A finalized manifest carries the minimum version safe for its contents: a plaintext full is 1, 2, or 4 by schema; an encrypted/signed/table-bound chain rises to 5–7, or 9 with injective chunk-binding AAD; a VStream CDC segment is 8; a redacted full is 10; a positionless full is 11; and a postgres-trigger change segment carrying an exact number is 12. It exists so an older binary refuses to resume an in-progress backup it can't account for, rather than mis-resuming off a base manifest that under-reports progress.

The rule is proportional: a manifest gets the minimum version safe for its actual contents, so a typical CRUD database with no RLS, no EXCLUDE constraints, no standalone sequences, and no postgres-trigger change segment carrying a non-integer number stays at FormatVersion=1 and cross-version restore behaves exactly as before. The value is derived from the schema — there's no flag to set. Audit it with jq .format_version manifest.json.

Point a pre-v0.94.1 binary at a FormatVersion=2 chain and its restore preflight trips before any DDL or data lands: it exits with manifest format version 2 is newer than this build supports (1); upgrade sluice and creates zero relations on the target. The refuse-before-touch property is load-bearing — there is no code path on the older binary where the chain is partially applied with RLS or EXCLUDE metadata stripped. The silent-loss class is structurally impossible (Bug 116, closed in v0.94.1). Full contract: backup-format-versioning.md.

## Object stores

Swap --output-dir for --target <url> to write to an object store. Four schemes are supported:

Scheme · Destination ·

s3://bucket/prefix · Amazon S3 or any S3-compatible provider. ·

gs://bucket/prefix · Google Cloud Storage. ·

azblob://container/prefix · Azure Blob Storage. ·

file:///path · Local filesystem (the URL form of --output-dir). ·

For S3-compatible providers — Cloudflare R2, Backblaze B2, MinIO, Wasabi, Tigris — an s3:// URL takes three extra knobs: --backup-endpoint (the provider's endpoint URL), --backup-region, and --backup-path-style (bucket-in-path addressing, which most non-AWS providers require). Credentials follow the cloud SDK's normal resolution (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for any S3-compatible endpoint). These knobs apply verbatim to backup incremental, stream, verify, prune, compact, and restore too.

    # full backup to Cloudflare R2 (an S3-compatible store)
    sluice backup full --source-driver postgres --source 'postgres://...' \
        --target s3://my-bucket/app-chain \
        --backup-endpoint https://<account>.r2.cloudflarestorage.com \
        --backup-region auto \
        --backup-path-style \
        --chain-slot

## Continuous backup

Rather than firing an incremental from cron, run backup stream run as a long-lived process that commits rolling incrementals at a cadence. Each rollover closes on the first of --rollover-window (default 5m), --rollover-max-changes (default 100000), or --rollover-max-bytes (default 64 MiB), and — like a manual incremental — extends to the next transaction commit:

    sluice backup stream run --source-driver postgres --source 'postgres://...' \
        --target s3://my-bucket/app-chain \
        --rollover-window 5m --rollover-max-changes 100000

Stop it with sluice backup stream stop --target <url> (works cross-machine), which writes a stop request the running stream observes — see stopping a stream below for what happens to the in-flight rollover, and why SIGTERM is only the fallback. To bound total disk without an external wrapper, in-process rotation caps the open segment at --retain-rotate-at <dur> and/or --retain-rotate-at-chain-length <n> and opens a fresh segment over the same CDC handle (ADR-0046); pair that with backup prune below.

Rotated chains and keyless tables (v0.157.0+, Bug 297). Each rotated segment starts with its own full, and chain restore applies every full after the first over the rows the earlier segments already restored, through the idempotent writer. A table with no PRIMARY KEY and no NOT NULL UNIQUE index cannot be re-written that way, and a target table keyed only on a surrogate the rows do not carry (AUTO_INCREMENT, serial, identity or a defaulted key) would gain a second copy of every row. Through v0.156.12 sluice built such chains without a warning; restoring one failed at the second segment full after part-writing the target, or, into a surrogate-keyed MySQL table, duplicated rows at exit 0 (measured: 355 rows for the source's 32).

- backup stream run with rotation refuses to start a new chain while a table it backs up is keyless (SLUICE-E-BACKUP-ROTATED-KEYLESS-TABLE, exit 3, nothing written). Continuing an existing chain it is not stopped: it logs a ROTATION-KEYLESS-TABLE WARN carrying the code, names the tables, says whether the chain already holds a later full that restore will refuse, and runs with rotation suspended. A table that appears or loses its key mid-stream makes each rotation refuse before its snapshot opens; the stream stays on its open segment and retries at every rollover, and that per-rollover ERROR is the only signal (backup stream status does not show it).

- restore and backup verify refuse such a chain with the same code before writing anything, naming each table and the segment fulls (backup id and directory) that carry its rows. A later full with no rows for the table is not refused.

The rows are in the chain, but this release cannot restore those tables from it: restore everything else with --exclude-table for each named table, and copy those tables another way, for example sluice migrate --include-table. On a running chain, a NOT NULL UNIQUE index on the source replays and lets rotation resume; an ADD PRIMARY KEY makes the chain unrestorable from that change on (SLUICE-E-BACKUP-SCHEMA-DELTA-UNSUPPORTED), so after one take a new full into a new location. Or run without --retain-rotate-at / --retain-rotate-at-chain-length. If you restored a rotated chain into a MySQL target whose tables were pre-created with a surrogate key, compare row counts with the source: a count above the source's means duplicated rows.

An idle Postgres source still commits windows (v0.156.8+). A backup stream or backup incremental from a Postgres source now captures the walsender's keepalive position as a transaction boundary whenever none of the source's transactions is open (two change records), so its slot follows the server's WAL while your tables are idle (why). The visible effect: for each rollover window in which the server wrote WAL, backup stream now commits one manifest plus one small change chunk, where on Postgres 15+ it used to skip the window as an empty rollover, and the window's end position advances. It is bounded by the throttle — at most one boundary pair per 10 s, so a window holds at most 2 × window / 10 s records — and adds nothing on a fully quiet server. Size retention and backup prune schedules accordingly. (Code-read, not benchmarked.)

### Stopping a stream (v0.156.12+)

A backup chain never ends inside a source transaction, because a chain that did would restore that transaction twice (or, on MySQL file/pos, lose part of it). That shapes how a backup stream run stops:

- sluice backup stream stop (the command, the stop file, or the in-process stop) closes the current rollover at once when no source transaction is open. When one is open, the stream keeps reading until that transaction's commit — already committed at the source, only being delivered — then commits the rollover and exits 0. The wait is bounded at 60 s and 1,000,000 changes (fixed defaults, no flag). If either runs out, the rollover is abandoned and the stream still exits 0: no manifest is written and the replication position is not acknowledged, so the next run reads that window again from the previous rollover's end. The WARN carries BACKUP-WINDOW-ABANDONED-OPEN-TRANSACTION. backup stream stop returns as soon as it has written the request; the stream process is what waits, so wait for the process to exit (up to about 60 s plus the commit) before signalling it.

- SIGTERM / SIGINT does not drain. It commits the in-flight rollover only when it stands at a transaction boundary; inside a transaction it abandons the rollover at once (same WARN, exit 0), because the cancel also tears down the change stream, so the commit cannot be waited for.

- An abandoned rollover loses nothing, but it is not free. The whole window is re-read on the next start — on a busy source, where a signal almost always lands inside a transaction, up to a full --rollover-window (default 5 minutes) or --rollover-max-changes (default 100,000) of work. A supervisor that signals the stream more often than once per window (frequent restarts, a short RuntimeMaxSec, a liveness probe that kills it) never lets the chain advance: every run exits 0 and only the WARN says so.

So stop with sluice backup stream stop, wait for the process to exit, and use SIGTERM only as the fallback after that. Under systemd: ExecStop= running backup stream stop followed by a wait on the process, with TimeoutStopSec above 60 s. Under Kubernetes: a preStop hook doing the same, with terminationGracePeriodSeconds above 60 s.

Who should check: chains written before v0.156.12. On v0.19.0 through v0.156.11, a backup stream stop, stop file, SIGTERM/SIGINT or source close that landed inside a source transaction committed the window anyway, and chain restore and sync from-backup then applied that transaction's first rows twice at exit 0 (a keyless table restored at 6 rows against the source's 3; a key-reusing transaction lost a row; on MySQL file/pos the rest of a ROWS event was lost instead — 40,000 rows restored as 39,996). A cancel whose final flush failed (drain-flush failed in the log, any engine, trigger-CDC included) could also drop whole committed changes. Upgrading refuses such chains (below) but does not repair a target already restored or brokered from one, and does not make the chain replayable. Check if any of these apply:

- You ran backup stream and ever stopped or restarted it, or its source stream ended while transactions were being captured, on v0.19.0–v0.156.11, and then restored or brokered that chain. Run sluice backup verify on it with this release (with the key material if encrypted); a shape A or C refusal means it is affected. Then compare each target with its source (sluice verify --depth count, or --depth sample): a count above the source's on a keyless table means duplicated rows; a count below it on any table means lost changes.

- Postgres chains written before v0.138.0 that span a resume carry shape B, which backup verify does not judge. Compare keyless tables, and tables touched by key-reusing transactions, with the source.

- You ran backup compact --smart-compaction on such a Postgres chain and then restored or replayed it. Compare as above, and also compare keyed tables whose rows are deleted soon after insert (queue tables, for example): the target can still hold rows the source deleted.

The remedy for an affected chain is a new full backup; rebuild or correct the affected target tables.

## Retention: prune and compact

Two explicit operator actions bound a chain's size and restore time. Neither runs automatically, and the chain root (full) is always preserved.

backup prune drops the oldest incrementals. Choose retention by count (--keep-incrementals N) or age (--keep-duration DUR) — exactly one is required. The first surviving incremental is re-stitched to point at the full directly, which advances the chain's earliest restorable position forward: the dropped windows are gone from the chain's restore range, so this is opt-in. Use --dry-run to see what would go without touching storage.

    # keep the 30 most recent incrementals; preview first
    sluice backup prune --from-dir /var/backups/app --keep-incrementals 30 --dry-run
    sluice backup prune --from-dir /var/backups/app --keep-incrementals 30

backup compact merges consecutive segments whose CreatedAt gaps fall within --merge-window (required) into one segment — fewer files, faster restore. By default it's a byte-level concat: bytes are never decompressed, recompressed, or re-encrypted. Mixed codecs, divergent encryption keysets, or position gaps within a group refuse loudly before any mutation. Opt into event-level collapse (INSERT+UPDATE → INSERT, etc.) with --smart-compaction (ADR-0064). --dry-run reports the plan.

Smart compaction (opt-in, off by default) refuses severed inputs before it copies anything (v0.156.12+). Collapsing an incremental that carries a severed transaction — shape A, or on a Postgres chain shape B, on any incremental it would rewrite — would hide the evidence restore refuses on, so it refuses with SLUICE-E-BACKUP-CHAIN-SEVERED-TRANSACTION (exit 3) and the chain is unchanged. The remedy is --smart-compaction-off (plain compaction moves the chunks verbatim, so restore still refuses the chain) or, to get a chain that replays, a new full backup. It logs at INFO when it cannot judge shape B (no recorded source engine, or one with no position order), refuses a source engine it does not know with SMART-COMPACTION-SOURCE-ENGINE-UNKNOWN (uncoded, exit 1), and, before swapping the catalog, compares the severed-transaction findings on each rewritten incremental before and after: any finding gained or lost refuses with SLUICE-E-BACKUP-CHAIN-UNREADABLE at the pre-swap stage, nothing deleted. That last one is a compactor defect — use --smart-compaction-off and report it.

Smart compaction and the broker (v0.157.0+). Smart compaction collapses changes across transactions, so a rewritten incremental loses its per-change apply identities and its manifest's apply_identity flag. A broker then cannot replay a keyless table in that incremental exactly-once and refuses it (SLUICE-E-BROKER-KEYLESS-TABLE), and a broker stopped partway through it refuses to resume with SLUICE-E-BROKER-INCREMENTAL-REWRITTEN (recover with --reset-target-data). Do not smart-compact a segment a broker still has to replay; plain compaction moves the same chunk bytes and is safe.

## Restore and point-in-time

sluice restore reads a chain from --from-dir / --from, applies the schema (retargeting cross-engine if --target-driver differs from the backup's source engine), bulk-copies the rows back, and creates indexes, constraints, and views. When the store contains incrementals, restore walks the chain in order from the root through every incremental present, landing the target at the chain's tip:

    sluice restore --from-dir /var/backups/app \
        --target-driver postgres --target 'postgres://...target...'

Point-in-time recovery granularity is your incremental / rollover cadence: every committed incremental is a restorable position, and restore reconstructs the target as of the newest link in the store it reads. To recover to an earlier point, restore from a store (or a copy) whose newest incremental is that point — sluice restore has no "as of timestamp T" flag; the chain's committed positions are the recoverable points.

Severed-transaction pre-check (v0.156.12+). Before applying anything, chain restore decodes the first and last change chunks of every incremental and judges the whole chain. It refuses, exit 3, with no override: shape A, a non-final incremental that ends inside an open source transaction, and shape B (Postgres→Postgres restores only), an incremental that re-delivers the previous one's last transaction — every resumed window on Postgres chains written before v0.138.0 — both as SLUICE-E-BACKUP-CHAIN-SEVERED-TRANSACTION; and shape C, an incremental whose EndPosition is past the last change its chunks record (the old cancel-drain loss), as SLUICE-E-BACKUP-INCOMPLETE. A chain whose final incremental ends inside an open transaction is not refused, since nothing follows it, but restore WARNs CHAIN-TAIL-OPEN-TRANSACTION: what it restores includes only that transaction's head. For each of these the remedy is a new full backup and a new chain from it — see who should check.

Unreplayable schema changes and rotated keyless tables are refused up front (v0.157.0+). The same pre-check also refuses, before writing anything, a chain carrying a schema change replay cannot apply — an ALTER TABLE … ADD PRIMARY KEY, a dropped column, an added or redefined CHECK, a foreign-key change, or a change to or from a generated column (SLUICE-E-BACKUP-SCHEMA-DELTA-UNSUPPORTED) — and a rotated chain that would re-write a keyless table (SLUICE-E-BACKUP-ROTATED-KEYLESS-TABLE). backup verify refuses the same chains, and the broker's --reset-target-data cold start refuses the unreplayable schema change before its drop. A live broker tick still refuses that schema change only when it reaches it. Through v0.156.12 restore wrote every earlier link and then refused at the schema change (measured: 11 of 51 rows written), and backup verify passed the chain.

Restore parallelism is engine-generic: --table-parallelism (tables applied concurrently, auto 4) composes with --bulk-parallelism (a single table's chunks applied concurrently, auto min(8, NumCPU)); their product is clamped to the target's connection budget. For a chain that carries incrementals, --apply-concurrency fans the incremental change-replay across in-order PK-hash lanes (auto 4) — the knob that matters on a high-latency / cross-region target. Same-engine chains replay schema deltas and change chunks; cross-engine chains that carry incrementals are refused (a full-only cross-engine restore is fine).

Re-running a restore that failed partway (v0.156.11+). restore appends to what the target holds, so a re-run onto the same target writes everything the earlier attempt wrote a second time. A keyed table fails loudly on its key; a keyless one (no PRIMARY KEY and no NOT NULL UNIQUE index, in the backup's recorded schema or on the target table — a target keyed only on a serial, identity or defaulted surrogate the backup's rows do not carry counts as keyless) used to hold two copies of every row silently, on every release through v0.156.10. Now restore refuses before writing anything with SLUICE-E-RESTORE-KEYLESS-TABLE-NOT-EMPTY (exit 3, no override, deliberate appends included) when an in-scope table is keyless and already holds rows — on Postgres, MySQL-family and SQLite targets. Empty tables restore normally. restore has no --reset-target-data: after a failed restore, empty (TRUNCATE) or drop every table it loaded, not only the named ones, and re-run — or leave the named tables out with --exclude-table. If you ever re-ran a restore onto the same target after a failed attempt, compare those tables' row counts with the source (sluice verify --depth count).

To replay a chain into a live, continuously-updated target instead of a one-shot restore, use the broker — one process produces the chain, another tails it and applies incrementals as they land. See Sync from a backup chain.

## A column added mid-chain: the captured fill

When the source runs ALTER TABLE t ADD COLUMN c … DEFAULT d between two links, it fills every row it already holds — and that fill writes no row event, so no link carries a value of c for those rows. Replay adds the column from the schema recorded at the end of the window and lets the target fill the rows from that DEFAULT, which is wrong for a DEFAULT dropped or changed later in the window (Django's AddField drops its default in the very next statement) and for a non-constant one (now(), gen_random_uuid(), a sequence). Through v0.156.0 such rows restored as NULL, the window-end default, or the restore's own clock, silently.

Since v0.156.1 the capture records the fill. When backup incremental or a backup stream rollover sees that its window added a column, it reads the column's actual values back from the source for every row, keyed by primary key, and writes them into the same incremental as ordinary row updates that replay after every event of the window — so a row the window itself changed keeps its own value. The cost is one read of the key and the added columns per table, once per window that adds a column, logged per table as recorded the ADD COLUMN fill with the row count and duration. The backup format does not change (schema hash, backup ids and format version are as before), and a v0.156.0 binary restoring such a chain was measured to restore the same rows. The values are read when the window closes, not at its end position, so a row changed after the window ends carries its newer value one link early; the next link replays that change anyway, so only a restore that stops at that very link sees it.

- ADD-COLUMN-FILL-NOT-CAPTURED (capture-time WARN) — the table has no primary key, so its rows cannot be addressed one by one and the fill is recorded as skipped.

- ADD-COLUMN-FILL-NOT-REPRODUCIBLE (restore-time WARN; the restore carries on) — the chain does not carry the fill: every added column of a skipped table, and, on a chain captured by an older sluice, every column added with a DEFAULT sluice cannot prove constant. A Django-style dropped DEFAULT on such an older chain is invisible to it and restores NULL with no warning. Repair by copying that column's values for the pre-ALTER rows from the source.

Take a fresh full backup after upgrading if your chains span an ADD COLUMN: a chain captured by v0.156.0 or earlier does not contain the fill, and no release can reconstruct it from that chain. Repair any target already restored from such a chain against the source. (An older binary compacting a new chain drops the fill record, which can only cause a spurious ADD-COLUMN-FILL-NOT-REPRODUCIBLE WARN for a column that restores correctly.)

## Text that is not valid UTF-8: BACKUP-VALUE-NOT-UTF8 (v0.156.3)

Every backup chunk — the rows of backup full, and the changes of backup incremental and backup stream, before-images and the ADD COLUMN fill included — is JSON. JSON cannot hold a byte that is not part of valid UTF-8, and Go's encoder writes each such byte as U+FFFD (�) without an error. Through v0.156.2 that is what a backup did: the chunk sealed, backup verify rehashed it and agreed, and a restore landed � where the source held a value, at exit 0. Two ways in are known: a source holding bytes that are not valid text in a text column — a SQLite TEXT value written from raw bytes (CAST(x'636166e9' AS TEXT) sealed as caf�), a Postgres SQL_ASCII database, legacy invalid bytes in a MySQL utf8mb4 column — on any backup, backup full included; and MySQL, MariaDB and PlanetScale/Vitess change streams on legacy-charset columns (latin1, cp1251, sjis, …) before v0.156.3 converted them (non-UTF-8 character sets).

A backup now refuses such a value at capture with BACKUP-VALUE-NOT-UTF8, naming the table, the column, which image of a change held it, and where inside a list, map or structured value it sits. backup stream stops on it rather than retrying — it is not a transient error — and no manifest is committed for the refused window, so the chain still ends at the last good one. Binary values (carried as base64) and a JSON column that reaches the backup as raw bytes are not inspected; a literal � that really is in the source's text is valid UTF-8 and is carried as before. The refusal is deliberately not byte-exact carriage: no target except SQLite can store such a value (Postgres refuses it with 22021, strict utf8mb4 MySQL with 3988).

To fix it, repair the value at the source, or store it as BLOB / bytea if it really is binary. To back up everything else meanwhile, backup full can leave the table out with --exclude-table or null the column with --redact <table>.<column>=null; backup incremental and backup stream have neither, so the chain cannot advance past the value until it is repaired at the source.

If you restored from a backup taken before v0.156.3. Compare the affected text columns of anything restored from a backup of such a source against the source: a � in them is a lost value, and so is any other character a legacy-charset change-stream value turned into. For MySQL-family chains, chain restore, sync from-backup and backup verify now WARN with LEGACY-CHARSET-INCREMENT for each incremental that v0.156.2 or earlier captured with a non-UTF-8 text column, naming the table and columns — take a fresh full backup with v0.156.3; no release can reconstruct those values from the old chain. Rows a full backup copied from a MySQL-family legacy-charset column were exact (the server converts them for the bulk copy), so a full never WARNs.

## postgres-trigger chains restore numbers exactly (v0.156.4)

The postgres-trigger change stream hands every non-integer number to its consumers as the source's exact text, and the backup change-chunk writer always stored that text faithfully. Through v0.156.3 the read side did not: chain restore, sync from-backup and smart compaction decoded every bare number in a change chunk as a 64-bit float, so any value a float cannot carry exactly was altered at exit 0 — numeric 10.50 became 10.5, 123456789012345678.123456789012 became 123456789012345680, a jsonb 1.500 became 1.5, and jsonb 1e-400 became 0. double precision, real, NaN and integers restored with the right value.

Since v0.156.4 the change-chunk reader keeps every bare number as its exact text when the chain's source is postgres-trigger — the same form the live change stream produces. Chains from other engines keep the previous decode; their change streams never produce these values. The fix keys on the chain's source engine, not its format version, so chains written by v0.154.0–v0.156.3 restore exactly with this release without being re-taken.

Because the chunk bytes did not change, an older binary restoring a chain written by v0.156.4 would round it the same way. So a postgres-trigger incremental or backup stream segment whose change chunks carried an exact number is stamped FormatVersion=12, and v0.156.3 and older refuse it ("newer than this build supports") instead of restoring it rounded. Segments that carried only integers, text and other non-numeric families, every full, and every other engine's chain stay readable by older binaries. Upgrade the binary that restores, brokers (sync from-backup) or compacts a postgres-trigger chain to v0.156.4 or later before it reads one written by v0.156.4.

If you restored or brokered a postgres-trigger chain with v0.154.0–v0.156.3 (v0.154.0 is the first release that could extend a trigger full with backup incremental or backup stream). Affected are unconstrained numeric values and jsonb numbers whose source text is not the shortest float rendering of the value — a trailing-zero scale at any digit count, more than about 15 significant digits, a magnitude below about 1e-308, or a subnormal-range magnitude — and every numeric(p,s) value past 15 significant digits. numeric[] elements failed loudly on a Postgres target; toward a MySQL target they were most likely rounded silently like scalars (from reading the code, not measured), so audit numeric[] columns restored to MySQL too. Repair: re-restore into an emptied target (empty or drop every table the earlier restore loaded first — restore appends, so a keyed table fails the re-run on its key and a keyless one is refused, see re-running a restore), or re-seed the sync from-backup target with --reset-target-data, with v0.156.4 or later, then compare those columns against the source — a target restored by an affected release keeps the rounded values until you do. A chain that an affected release smart-compacted cannot be repaired from the chain: compaction decodes and re-encodes the chunk, so the rounded digits are in its bytes. Take a fresh full backup.

## Verifying a backup

backup verify walks a chain, recomputes every chunk's SHA-256, and reports any mismatch — a target-free integrity probe, ideal for a cron check against archived backups:

    sluice backup verify --from-dir /var/backups/app

For an encrypted chain, add --encrypt plus the same key source you backed up with. Verify then also runs a decrypt probe on every per-chunk wrapped CEK, so a mid-chain passphrase rotation surfaces here as a clear verify failure instead of a partial-fail at restore time (Bug 117). Verify warns loudly if you point it at an encrypted chain without a key source — SHA-only verify can't see that class of problem.

At every depth, verify also runs the severed-transaction check (v0.156.12+) and reports every refusal: shape A (SLUICE-E-BACKUP-CHAIN-SEVERED-TRANSACTION) and shape C (SLUICE-E-BACKUP-INCOMPLETE) — chains it used to report healthy. It does not judge the Postgres-only shape B. On an encrypted chain verified without the key it cannot decode the change chunks, so it WARNs that it skipped the check and exits green: that run does not answer "is this chain severed?". Pass the key.

    export SLUICE_BACKUP_PASS='correct horse battery staple'
    sluice backup verify --from-dir /var/backups/app \
        --encrypt --encryption-passphrase-env SLUICE_BACKUP_PASS

## Next steps

- Sync from a backup chain — replay a chain into a live target as a long-running broker (decoupled transport).

- backup / restore command reference — the full flag set for every subcommand.

- Configuration — YAML config, type/expression overrides, and PII redaction (which also applies at backup time, so on-disk chunks are PII-clean).

---
Canonical page: https://sluicesync.com/docs/encrypted-backups/ · Full docs index: https://sluicesync.com/llms.txt
