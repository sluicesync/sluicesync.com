# Migrating from Azure Database for MySQL (Flexible Server) with sluice

> The one required knob: binlog_row_image defaults to MINIMAL, under which binlog CDC silently loses UPDATEs (Bug 193) — set it FULL first. In exchange, Azure has the safest binlog retention of any managed MySQL probed (an honest 0 = never-expire default, no reaper), zero-setup public-CA TLS, and an -azure version fingerprint.

Azure Database for MySQL (Flexible Server) works with sluice's vanilla mysql engine — cold copy, the CDC handoff, and a 35-minute-detached warm resume were all validated live (2026-07-17, Standard_B1ms, MySQL 8.0.45). Retention is the safest of any managed MySQL in this guide set, but Azure carries a different, sharper trap that must be fixed before any sync: the default row-image setting.

## REQUIRED: set binlog_row_image=FULL before any sync

Azure's platform default is binlog_row_image=MINIMAL — the only major managed-MySQL platform that defaults to it — and under MINIMAL, binlog CDC loses UPDATEs silently (Bug 193). INSERT and DELETE are unaffected and row counts stay equal, so only column content diverges — a 0.2% content drift that sails under a default-depth sample. Set it FULL before sync start:

    az mysql flexible-server parameter set --resource-group <rg> --server-name <server> \
      --name binlog_row_image --value FULL

It's dynamic — applies in ~20 seconds with no restart. Verify with SELECT @@binlog_row_image;. sluice's CDC preflight also refuses a non-FULL row image at stream start with the coded SLUICE-E-CDC-ROW-IMAGE-PARTIAL — but set the knob regardless, and if a stream already ran under MINIMAL, re-verify with full-table sampling (--sample-rows-per-table sized to the table), not the default sample depth: a 0.2% divergence is exactly what the default sampling design point can miss.

## Retention: the safest defaults of any managed MySQL probed

binlog_expire_logs_seconds defaults to 0 (no time-based expiry) — an honest never-expire — and, unlike DigitalOcean, Vultr, and RDS, no out-of-band reaper was observed: files survived 85+ minutes, multiple rotations, and an on-demand full backup without a single purge. A detached stream warm-resumes after long gaps on pure defaults (a 35-minute detach — fatal on RDS/DO defaults — replayed its backlog exactly). The concern inverts: binlogs accrue against your storage until you bound them.

    az mysql flexible-server parameter set --resource-group <rg> --server-name <server> \
      --name binlog_expire_logs_seconds --value 604800   # live, no restart

Purge appears platform-scheduled and lazy — files can outlive the configured window by tens of minutes. Manual PURGE BINARY LOGS is denied (no SUPER/BINLOG_ADMIN).

## Connection + privilege notes

- TLS is mandatory AND zero-setup — plaintext is refused (require_secure_transport=ON, the only probed managed-MySQL platform that refuses it), and a bare ?tls=true just works: the server chain validates against the public roots already in your system store. No CA download, no --source-tls-ca.

- FTWRL works (RELOAD honored) — sluice's concurrent frozen-snapshot cold copy runs with no fallback WARNs.

- Replication grants (REPLICATION SLAVE/REPLICATION CLIENT) are present on the admin user out of the box; binlog_format=ROW is read-only at the platform (no MIXED trap); gtid_mode=OFF by default (file/position CDC is fine); sql_require_primary_key=OFF; stock-strict sql_mode (no DigitalOcean-style ANSI surprise).

- Host pattern *.mysql.database.azure.com; the in-band fingerprint is @@version ending in -azure. One-time subscription step: az provider register --namespace Microsoft.DBforMySQL must have completed before instance creation works.

    sluice sync start \
        --source-driver mysql --source 'myadmin:pass@tcp(myserver.mysql.database.azure.com:3306)/app?tls=true' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id azure-app

## What sluice checks for you

- SLUICE-E-CDC-ROW-IMAGE-PARTIAL — a source streaming partial binlog row images (binlog_row_image != FULL) is refused at CDC start, because that is exactly the silent-UPDATE-loss shape; the remedy is the az &hellip; parameter set above.

- No retention advisory — correctly. Azure's defaults hold binlogs, so the host-pattern retention WARNs that fire on DigitalOcean and Vultr have nothing to warn about here; a quiet preflight is the right result, not a blind spot.

- Loud position-invalid recovery — a resume from a purged position (only reachable if you bounded retention aggressively) is an explicit WARN plus a fresh cold start, or a hard stop under --no-auto-resnapshot.

## Next steps

- Migrating from Azure Database for PostgreSQL — the Postgres sibling: self-grantable REPLICATION, and the best TLS story in the series.

- Migrating from Google Cloud SQL MySQL — the other managed MySQL whose retention variable is honest.

- Field note: the row image that drops your UPDATEs — why MINIMAL loses column content while counts stay equal.

- Field note: the retention variable that tells five different truths — where Azure's never-expire default sits among the five.

---
Canonical page: https://sluicesync.com/docs/migrate-from-azure-mysql/ · Full docs index: https://sluicesync.com/llms.txt
