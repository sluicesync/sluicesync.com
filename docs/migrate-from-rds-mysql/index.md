# Migrating from AWS RDS MySQL with sluice

> The detect-first binlog-retention advisory (what the WARN means and the one-line SQL remedy), 8.0-family parameter groups, the platform-blocked FTWRL, and the regional truststore bundle.

AWS RDS for MySQL works with sluice's vanilla mysql engine — cold copy and the CDC handoff were validated live (2026-07-16, MySQL 8.4.9 on a db.t4g.micro). Aurora MySQL shares the endpoint suffix and the retention procedure below. Like DigitalOcean, the headline is binlog retention — but on RDS the truth is SQL-visible, so sluice can check it for you instead of warning blind.

## Binlogs purge in ~5–11 minutes on defaults

With no retention configured, RDS purges each binlog file on a ~5-minute sweep once automated backups have uploaded it — observed lifetime ~5–11 minutes per file — while @@binlog_expire_logs_seconds reads 30 days. The server variable does not govern the RDS purger (same class as DigitalOcean), but unlike DO the real setting is visible in SQL: CALL mysql.rds_show_configuration → binlog retention hours, default NULL (&ldquo;as soon as possible&rdquo;). A CDC position older than the window is unrecoverable, and a cold copy longer than it can livelock auto-resnapshot — and RDS's window is tighter than DO's ~13–16 minutes: plan for the ~5-minute floor, not the ceiling.

Before sync start or backup, run this on the source (master user, plain SQL, effective immediately, no restart):

    CALL mysql.rds_set_configuration('binlog retention hours', 24);  -- range 1..168 (7 days max)
    CALL mysql.rds_show_configuration;                               -- verify: binlog retention hours = 24

The details that matter, all live-proven:

- An attached, caught-up stream does NOT hold the purger back. Files sluice had already read were purged on schedule while the stream ran; a caught-up stream survives only because it sits on the active file. Any lag or disconnection beyond the window is fatal at defaults — set the knob first, don't rely on staying attached.

- With the knob set, long gaps warm-resume cleanly. A stream that stayed detached for 35 minutes resumed and replayed its full backlog exactly; the same gap on defaults forced a cold start.

- The 168-hour cap is real — a paused stream beyond 7 days is impossible on RDS MySQL, period.

- Retained binlogs count against allocated storage; on tiny instances set the value back to NULL (or lower) after cutover.

- Automated backups must be ON (retention &ge; 1 day) or RDS disables binary logging entirely — no binlogs, no CDC.

What the WARN means. sluice's advisory here is detect-first: on sync/backup runs against an *.rds.amazonaws.com host it queries the retention setting and WARNs only when it is NULL or under 24 hours — a correctly configured source stays silent. If you see the WARN, the stream is running on borrowed time (~5–11 minutes of it); run the mysql.rds_set_configuration call above and the next run is quiet.

## Version + parameter-group gotchas

- MySQL 8.4's default parameter group is CDC-ready (binlog_format=ROW is the engine default and the group leaves it unset).

- MySQL 8.0's family default is binlog_format=MIXED — an RDS MySQL 8.0 source needs a custom parameter group with binlog_format=ROW. The parameter is dynamic: no reboot, but only new connections see it, so reconnect after the change.

- gtid_mode=OFF_PERMISSIVE by default; sluice's file/position CDC works as-is.

## The FTWRL platform block (why serial cold copy is expected)

RDS blocks FLUSH TABLES WITH READ LOCK at the platform level even though the master user holds RELOAD — the statement returns 1045 Access denied regardless of grants. Two sluice behaviours follow, both by design and both WARNed:

- The N-way concurrent cold copy falls back to serial (the concurrent path needs the read lock for a consistent multi-connection snapshot).

- The snapshot position is captured without a write freeze — a concurrent commit during the capture instant could land in neither the copy nor the CDC tail.

No grant fixes this — it's the platform, not your permissions (sluice's WARN text names the RDS reality on RDS hosts). If exactness of the handoff position matters, quiesce writers during the snapshot; on an idle or low-write source, accept the WARN.

## TLS: the public regional bundle

RDS defaults allow plaintext (require_secure_transport=OFF), and a bare ?tls=true fails — the RDS CA is not in system roots. The working recipe is --source-tls-ca with the public regional bundle (one well-known URL per region, no API call — contrast DO's authenticated CA endpoint):

    curl -sO https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem

    sluice sync start \
        --source-driver mysql --source 'admin:pass@tcp(mydb.abc123.us-east-1.rds.amazonaws.com:3306)/app' \
        --source-tls-ca us-east-1-bundle.pem \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id rds-app

The master user has the replication grants CDC needs out of the box (REPLICATION SLAVE, REPLICATION CLIENT) — nothing to GRANT on defaults.

## What sluice checks for you

- The detect-first retention advisory — on *.rds.amazonaws.com hosts, sluice queries mysql.rds_configuration and WARNs when binlog retention hours is NULL (naming the ~5–11-minute purge reality and the exact remedy call) or configured under 24 h (a milder WARN naming the window); a value &ge; 24 h stays silent. If the query itself fails, sluice falls back to an unconditional DO-style WARN rather than staying quiet.

- FTWRL fallback WARNs — the serial-copy fallback and the no-freeze snapshot capture are both announced, never silent.

- Loud position-invalid recovery — a resume from a purged position is an explicit WARN plus a fresh cold start (or a hard stop under --no-auto-resnapshot), never a silent gap.

- Unencrypted-binlog-stream WARN — a plaintext DSN gets a warning that the CDC stream is unencrypted; --source-tls-ca resolves it.

## Next steps

- Migrating from AWS RDS Postgres — the Postgres sibling: parameter groups, role membership, force_ssl.

- Migrating from Google Cloud SQL MySQL — the managed MySQL where the retention variable tells the truth and defaults are already CDC-safe.

- Zero-downtime migration — sync → verify → cutover once retention is configured.

- Field note: the transaction that lands in neither the snapshot nor the binlog — the exact hazard the no-freeze WARN describes.

- Field note: MySQL's own certificate can't pass verify-full — why the CA-pinned mode skips hostname verification.

---
Canonical page: https://sluicesync.com/docs/migrate-from-rds-mysql/ · Full docs index: https://sluicesync.com/llms.txt
