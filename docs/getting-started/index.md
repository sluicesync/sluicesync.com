# Getting started

> Install sluice, point it at a source and target, and run your first migration and continuous sync.

## Install

sluice is a single static binary with no daemon and no SaaS dependency. Install it with your platform's package manager:

- macOS / Linux (Homebrew): brew install sluicesync/tap/sluice

- Windows (Scoop): scoop bucket add sluicesync https://github.com/sluicesync/scoop-bucket then scoop install sluice

- Windows (WinGet): winget install sluicesync.sluice (once accepted into winget-pkgs)

- Debian / Ubuntu: download the .deb from the latest release, then sudo dpkg -i sluice_*_linux_amd64.deb

- RHEL / Fedora: download the .rpm, then sudo rpm -i sluice_*_linux_amd64.rpm

- Go: go install sluicesync.dev/sluice/cmd/sluice@latest

- Container (multi-arch, distroless): docker pull ghcr.io/sluicesync/sluice:latest

Self-contained binaries (Linux / macOS / Windows &times; amd64 / arm64) and .deb / .rpm / .apk packages are attached to every release. Verify the install:

    sluice --version
    sluice engines      # list the database engines built into this binary

## Prerequisites

- A source and a target database you can reach over the network.

- Engines available out of the box (14 — run sluice engines to confirm): mysql, mariadb, the planetscale and self-hosted vitess MySQL flavors, postgres, sqlite and d1 (migrate sources; sqlite is also a target), the trigger-CDC engines postgres-trigger, sqlite-trigger, d1-trigger, and the flat-file migrate sources csv, tsv, ndjson, and mydumper.

- For continuous sync from Postgres, the source normally needs logical replication (a replication slot). Managed Postgres that blocks slots (e.g. Heroku) can use the slot-less trigger engine instead.

- SQLite and Cloudflare D1 are migrate sources (a local file, a .sql dump, or a live D1 over the HTTP query API) into Postgres or MySQL; SQLite is also a target. Their base engines are migrate-only — for continuous sync use the trigger-CDC variants sqlite-trigger / d1-trigger.

## Connecting to your databases

Source and target are passed as DSNs (connection strings). The driver is named separately with --source-driver / --target-driver.

Engine · DSN format ·

mysql · user:pass@tcp(host:3306)/dbname ·

mariadb · Same shape as mysql (user:pass@tcp(host:3306)/dbname) — use the mariadb driver for a MariaDB server; sluice fingerprints the server and steers you if the driver and server family are mismatched. ·

postgres · postgres://user:pass@host:5432/dbname?sslmode=require ·

sqlite · A file path (./app.db) or a wrangler d1 export .sql dump (auto-detected). Also a target driver. ·

d1 · d1://<account_id>/<database_id> (or d1://<database_id> + CLOUDFLARE_ACCOUNT_ID); API token via CLOUDFLARE_API_TOKEN. ·

A note on sslmode. The sslmode=require in these placeholder DSNs encrypts the connection but does not verify the server's certificate — a safe default that works against any TLS target regardless of its CA. Prefer sslmode=verify-full (encrypt and verify the CA chain + hostname, which defeats man-in-the-middle) whenever the target's certificate is trusted by your system store or you can pin its CA with sslrootcert. Managed providers with a public CA make this free — e.g. PlanetScale Postgres ships a Let's Encrypt certificate, so sluice connects with verify-full out of the box. sluice (pgx) passes sslmode and sslrootcert straight through to the driver and never downgrades TLS on its own.

DSNs often contain credentials, so you can supply them via environment variables instead of flags:

    export SLUICE_SOURCE='root:rootpw@tcp(localhost:3306)/app'
    export SLUICE_TARGET='postgres://postgres:pgpw@localhost:5432/app?sslmode=disable'

See Configuration for the full set of environment variables and the optional YAML config file.

## Your first migration

A one-shot migration translates the source schema, creates the target tables, bulk-copies rows, then builds indexes and constraints. Always do a dry run first — it reads the source schema and prints the plan without touching the target:

    sluice migrate \
        --source-driver mysql    --source 'root:rootpw@tcp(localhost:3306)/app' \
        --target-driver postgres --target 'postgres://postgres:pgpw@localhost:5432/app?sslmode=disable' \
        --dry-run

When the plan looks right, drop --dry-run to apply it. If a migration is interrupted, re-run with --resume — state is checkpointed per table on the target, so it picks up where it left off:

    sluice migrate --source-driver mysql --source ... --target-driver postgres --target ... --resume

Cold-start safety. sluice refuses to bulk-copy into a non-empty target by default (an INSERT into a populated table would collide on the primary key). Use --resume to continue a prior run, or read the migrate reference for the recovery flags.

## Import a SQLite file or Cloudflare D1

SQLite and Cloudflare D1 are migrate sources into Postgres or MySQL. Point --source-driver sqlite at a local .db file — or at a wrangler d1 export .sql dump, which is auto-detected — and migrate as usual:

    # SQLite file (or a wrangler d1 export .sql dump) → Postgres
    sluice migrate \
        --source-driver sqlite   --source ./app.db \
        --target-driver postgres --target 'postgres://postgres:pgpw@localhost:5432/app?sslmode=disable'

To read a live Cloudflare D1, use --source-driver d1 with a d1:// DSN; the API token is read from CLOUDFLARE_API_TOKEN (env-only, never a flag). The reader projects each column through typeof() + CAST(… AS TEXT) / hex() so integers above 253 and BLOBs round-trip exactly (no JavaScript 52-bit rounding), and the reads don't take D1 offline:

    # Live Cloudflare D1 → Postgres
    export CLOUDFLARE_API_TOKEN=...
    sluice migrate \
        --source-driver d1       --source 'd1://<account_id>/<database_id>' \
        --target-driver postgres --target 'postgres://...?sslmode=disable'

SQLite is also a migrate target (--target-driver sqlite) — emit a .db from any source (decimals are stored byte-exact as TEXT), e.g. to then run wrangler d1 import. D1 itself is not a target; emit a SQLite .db and import it with wrangler.

Declared dates are an explicit choice. SQLite has no native temporal storage, so columns declared DATE / DATETIME are decoded per --sqlite-date-encoding (iso default, or unixepoch / unixmillis / julian) — a value whose storage class doesn't match is refused loudly, never a silently-wrong date. For continuous (not one-shot) sync from SQLite / D1, use the trigger-CDC engines sqlite-trigger / d1-trigger.

## Your first continuous sync

Continuous sync captures a consistent snapshot, bulk-copies it, then streams ongoing changes. Streams are identified by a --stream-id so they can resume after a restart:

    sluice sync start \
        --source-driver mysql    --source 'root:rootpw@tcp(localhost:3306)/app' \
        --target-driver postgres --target 'postgres://postgres:pgpw@localhost:5432/app?sslmode=disable' \
        --stream-id app-prod

From another shell, check freshness or status, and stop the stream cleanly when you're done:

    sluice sync status --stream-id app-prod --target-driver postgres --target ...
    sluice sync health --stream-id app-prod --target-driver postgres --target ...   # cron-friendly exit code
    sluice sync stop   --stream-id app-prod --target-driver postgres --target ...   # drains in-flight changes, then exits

## Verify the copy

After a migration or once a stream has caught up, compare source and target:

    sluice verify \
        --source-driver mysql    --source ... \
        --target-driver postgres --target ...

verify compares row counts by default and can escalate to per-row hashing — see the verify reference.

## Set up backups

sluice takes logical backups — a full snapshot that roots a chain, plus incrementals appended onto it — to a local directory or any S3/GCS/Azure object store. It's the same binary; no separate backup daemon. Take a full backup first; on Postgres, add --chain-slot so the full provisions the replication slot that anchors the chain (incrementals then chain with zero gap, no manual slot setup):

    # full snapshot to a local directory (chain root)
    sluice backup full --source-driver postgres --source ... \
        --output-dir /var/backups/app --chain-slot

    # append an incremental onto the chain
    sluice backup incremental --source-driver postgres --source ... \
        --output-dir /var/backups/app

Backups are compressed with zstd by default (--compression none|gzip|zstd). To rest the chain encrypted, add the encryption flags — a passphrase (read from an env var or file, not the command line) or a cloud KMS key (--kms-key-arn / --gcp-kms-key-resource / --azure-key-vault-id); see the backup reference.

For object storage, swap --output-dir for --target <url> (s3://, gs://, azblob://, file:///). S3-compatible providers — Cloudflare R2, Backblaze B2, MinIO, Wasabi, Tigris — take three extra knobs: --backup-endpoint (the provider's endpoint), --backup-region, and --backup-path-style (bucket-in-path addressing, which most non-AWS providers require):

    # full backup to Cloudflare R2 (an S3-compatible store)
    sluice backup full --source-driver postgres --source ... \
        --target s3://my-bucket/app-chain \
        --backup-endpoint https://<account>.r2.cloudflarestorage.com \
        --backup-region auto \
        --backup-path-style \
        --chain-slot

Credentials follow the cloud SDK's normal resolution (e.g. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for any S3-compatible endpoint). To run continuously instead of one incremental at a time, use sluice backup stream run (rolling incrementals) — and replay a chain into a live target with the broker tutorial.

## Trigger-based CDC (no replication slot / Bucardo-style)

When the source is a managed Postgres that blocks logical replication slots — Heroku Postgres, RDS without the right grants, Supabase / Crunchy starter tiers — sluice can capture changes with plpgsql triggers instead. Per-table triggers write into a sluice_change_log capture table; the postgres-trigger engine tails the log. The lifecycle is explicit — setup → run → teardown — so the source-side DDL is visible at the CLI, not silently applied on first sync.

1. Install the capture triggers (--tables is required; on a tier that denies event-trigger creation, add --allow-polled-fingerprint to opt into the polled schema-fingerprint fallback):

    sluice trigger setup \
        --dsn 'postgres://user:pass@host:5432/app?sslmode=require' \
        --tables=orders,customers \
        --allow-polled-fingerprint

2. Stream with the trigger engine — the source driver is postgres-trigger; everything else is an ordinary sync start:

    sluice sync start \
        --source-driver postgres-trigger \
        --source 'postgres://user:pass@host:5432/app?sslmode=require' \
        --target-driver postgres --target 'postgres://...target...' \
        --stream-id app

3. Tear down cleanly when the stream is finished — this drops every per-table trigger and (by default) the sluice_change_log table, leaving the source with zero residue (the full set of objects setup installs is listed under Objects sluice creates). Pass --keep-data to retain the change-log for forensics, or --yes to skip the confirmation prompt:

    sluice trigger teardown \
        --dsn 'postgres://user:pass@host:5432/app?sslmode=require' --yes

The slot-based PG CDC reader refuses loudly when the source role lacks the REPLICATION attribute rather than silently degrading to polling — the trigger engine is the deliberate slot-less path. See the trigger reference.

## Next steps

- Command reference — the full flag set for every command.

- Continuous sync from a backup chain — replay a chain into a target as a long-running broker (decoupled transport).

- cutover — prime target sequences before switching traffic, so the first post-cutover INSERT can't collide.

- Configuration — YAML config, env vars, type/expression overrides, and PII redaction.

---
Canonical page: https://sluicesync.com/docs/getting-started/ · Full docs index: https://sluicesync.com/llms.txt
