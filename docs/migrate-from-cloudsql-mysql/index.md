# Migrating from Google Cloud SQL MySQL with sluice

> The first managed MySQL whose binlog retention is honest and safe by default (a 1-day floor), the --retained-transaction-log-days decoy, the PITR toggle that invalidates every position, and the per-instance-CA TLS recipe.

Google Cloud SQL for MySQL works with sluice's vanilla mysql engine — cold copy, the CDC handoff, and a 35-minute-detached warm resume were all validated live (2026-07-16, MySQL 8.0.45). It's the third managed MySQL in this guide set, and the first with genuinely good news: the binlog-retention hazard that headlines the DigitalOcean and RDS guides is, here, both truthful and safe by default. What earns the headline instead is a Cloud-SQL-specific hazard of its own: the PITR toggle.

## Retention: honest and safe by default (a 1-day floor)

On Cloud SQL, @@binlog_expire_logs_seconds reads 86400 (1 day) — and unlike DO and RDS, the variable is the real governing knob. No out-of-band reaper purges ahead of it: in ~80 minutes of rotation-forced observation, zero purges occurred, with files surviving 48+ minutes past rotation (on DO defaults every one of those files dies at ~13–16 minutes of age; on RDS at ~5–11). The platform also refuses to set the flag below 86400 (allowed values: 0 = never expire, or 86400–4294967295 seconds), so the CDC window can't be misconfigured short.

The live-proven consequence: a sluice stream detached for 35 minutes on pure defaults — the exact gap length demonstrated fatal on RDS defaults — warm-resumed cleanly with exact backlog replay. Defaults are CDC-safe for any cold-copy-plus-reattach gap under ~24 hours; most migrations need no retention knob at all.

 · DigitalOcean · AWS RDS · Cloud SQL ·

Default effective window · ~13–16 min (out-of-band reaper) · ~5–11 min (post-backup-upload purge) · 1 day (variable-governed) ·

Does @@binlog_expire_logs_seconds tell the truth? · No (reads 3 days) · No (reads 30 days) · Yes ·

The real knob · config API, 600–86400 s · mysql.rds_set_configuration, cap 168 h · database flag, floor 86400 s, no practical cap ·

Defaults CDC-safe? · No · No · Yes (gaps < 24 h) ·

When a planned pause will exceed a day, stretch the window with the database flag — applied live, no restart, ~20 seconds (validated with a sync stream attached and uninterrupted):

    gcloud sql instances patch my-instance --database-flags=binlog_expire_logs_seconds=604800

    # Careful: --database-flags REPLACES the entire flag set — include any existing flags.

Unlike RDS there is no 7-day cap — multi-week windows are possible. Two soft edges: on-disk binlogs count against storage (watch it if auto-grow is off), and Google documents early purging under disk pressure — don't treat the window as contractual on a nearly-full disk.

## The decoy knob: --retained-transaction-log-days

Cloud SQL has a second, better-advertised retention setting, and it is not the one that matters. --retained-transaction-log-days (transactionLogRetentionDays) governs the PITR log copies uploaded to Cloud Storage — invisible to the replication protocol, useless to a CDC client, and capped at 7 days on the Enterprise edition anyway. The two are provably decoupled: patching it 7→1→7 completed in ~3 seconds with no restart and left @@binlog_expire_logs_seconds untouched. It looks like RDS's binlog retention hours; the database flag above is the actual CDC knob.

Also worth knowing: SET GLOBAL binlog_expire_logs_seconds and PURGE BINARY LOGS are both denied from SQL (root lacks SUPER) — every retention change goes through gcloud — but the reading is SQL-visible and honest, which is more than DO or RDS offer.

## The PITR toggle destroys positions (both directions)

For Cloud SQL MySQL, --enable-bin-log is the PITR switch, and binary logging is coupled to automated backups (disabling backups with binlog on is refused with an HTTP 400; creating with --enable-bin-log silently implies backups on). The hazard is the toggle itself, live-probed in both directions:

- --no-enable-bin-log restarts the instance (an ~10-minute operation), sets log_bin=0, and destroys every existing binlog. A live sluice stream rode the restart's connection refusals through its retry loop, reconnected, and then failed loudly and correctly: ERROR 1236 (HY000): Binary log is not open.

- Re-enabling restarts the instance again and resets binlog numbering to mysql-bin.000001 — so every position persisted on either side of the round-trip is permanently invalid, even though binlogs exist again.

sluice recovers from this the loud way, validated live across the full toggle round-trip: the restart's warm resume detects the invalid position — &ldquo;persisted position is no longer valid; falling through to cold start &hellip; binlog file &lsquo;mysql-bin.000012&rsquo; is no longer available on the source (purged)&rdquo; — WARNs, and auto-resnapshots (fresh copy, re-attach at the new numbering, counts exact after). If a full re-copy is expensive and you'd rather decide by hand, sync start --no-auto-resnapshot converts that into a hard stop with named recovery commands. Database flags survive the toggle; positions do not.

One honest caveat. Today the recovery WARN describes the position as purged — accurate, but it doesn't yet name the PITR toggle as the likely Cloud SQL cause (there's no hostname to detect the platform by; a fingerprint via @@version ending in -google is the planned refinement, not shipped at the time of writing). If you see position-invalid recovery on Cloud SQL and retention was at defaults, check the instance's operation log for a binlog toggle before suspecting the window.

## FTWRL works — frozen snapshots, no WARNs

Cloud SQL's root user holds effective RELOAD/FLUSH_TABLES and the platform honors them — FLUSH TABLES WITH READ LOCK succeeds. sluice's consistent multi-table cold copy therefore runs concurrent, with a frozen snapshot position, and none of the fallback WARNs from the RDS guide apply: no serial-copy fallback, no no-freeze capture. The snapshot-position gap is closed here the way it's meant to be.

## Connecting: the per-instance CA

Defaults accept plaintext (sslMode: ALLOW_UNENCRYPTED_AND_ENCRYPTED) — a plain DSN works and gets sluice's unencrypted-binlog-stream WARN. A bare ?tls=true fails (x509: certificate signed by unknown authority): each instance has its own private CA (CN=Google Cloud SQL Server CA), the same class as DigitalOcean's — and unlike RDS there is no public bundle URL; the fetch is an authenticated API call:

    gcloud sql instances describe my-instance --format='value(serverCaCert.cert)' > cloudsql-ca.pem

    sluice sync start \
        --source-driver mysql --source 'root:pass@tcp(34.148.x.y:3306)/app' \
        --source-tls-ca cloudsql-ca.pem \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id cloudsql-app

--source-tls-ca covers both the SQL connections and the binlog/CDC stream — validated end-to-end on Cloud SQL. The server certificate's CN is project:instance, not the IP; sluice's CA-pinned verify-ca mode handles that without a hostname-verification failure (see why MySQL certificates can't pass verify-full).

## Defaults that are already right

- binlog_format=ROW, binlog_row_image=FULL, gtid_mode=ON out of the box — even on 8.0 (contrast RDS 8.0's MIXED and its custom-parameter-group dance). sluice's file/position CDC works as-is; positions carry the server_uuid.

- Replication grants present on root (REPLICATION SLAVE, REPLICATION CLIENT) — nothing to GRANT.

- sql_require_primary_key=OFF — keyless tables land fine as targets, unlike DO.

- Stock-strict sql_mode — no DO-style ANSI surprise; double-quoted strings are strings.

## What sluice checks for you

- Mostly: nothing fires — correctly. Cloud SQL connects by bare IP (or the Auth Proxy at localhost), so the DO/RDS host-pattern retention advisories have nothing to match — and nothing to say: at defaults the window is a day, not minutes, so a quiet preflight is the right result on this platform, not a blind spot.

- Loud position-invalid recovery — a mid-stream binlog loss is a loud 1236 failure, and a resume from an invalidated position (the PITR toggle's signature) is an explicit &ldquo;persisted position is no longer valid&rdquo; WARN plus a fresh cold start — validated live on Cloud SQL across the toggle round-trip; --no-auto-resnapshot makes it a hard stop with named recovery commands instead.

- Unencrypted-binlog-stream WARN — a plaintext DSN gets a warning that the CDC stream is unencrypted; --source-tls-ca resolves it (and refuses to combine with a DSN-level tls=, or to apply to non-MySQL engines).

- The FTWRL WARNs are absent by design — on this platform their absence means the frozen-snapshot concurrent copy actually ran.

## Next steps

- Migrating from AWS RDS MySQL — the sibling where defaults purge in minutes and the remedy is one SQL call.

- Migrating from DigitalOcean MySQL — the other purge-window platform, where no SQL-visible truth exists at all.

- Zero-downtime migration — the full sync → verify → cutover flow.

- Field note: the transaction that lands in neither the snapshot nor the binlog — the seam FTWRL closes, and on Cloud SQL actually can.

---
Canonical page: https://sluicesync.com/docs/migrate-from-cloudsql-mysql/ · Full docs index: https://sluicesync.com/llms.txt
