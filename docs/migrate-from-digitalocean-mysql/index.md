# Migrating from DigitalOcean MySQL with sluice

> The ~13–16-minute binlog purge window on defaults (and the config-API knob that fixes it), the private CA via --source-tls-ca, sql_mode differences, and the resnapshot-livelock hazard sluice warns about.

DigitalOcean Managed MySQL works with sluice's vanilla mysql engine — cold copy and the CDC handoff were validated live (2026-07-15, MySQL 8.4). One platform behaviour is important enough to headline, because it determines whether a continuous sync can survive at all on default settings.

## The ~13–16-minute binlog window on defaults

On DO Managed MySQL defaults, an out-of-band platform reaper purges every binlog file roughly 13–16 minutes after creation — while @@binlog_expire_logs_seconds reads 259200 (3 days) and the DO config API shows no retention field until you first set one. The server variable does not reflect the platform's actual purge behaviour, and no SQL-level check can see the real window — which is why sluice's preflight signal is the DSN host pattern (*.db.ondigitalocean.com): sync and backup runs against that pattern emit a loud WARN naming the window and the remedy.

Why it matters, concretely:

- A CDC position older than the window is unrecoverable — the resume fails with &ldquo;binlog purged&rdquo; (ErrPositionInvalid), and the only path forward is a fresh snapshot.

- A cold copy that takes longer than the window can livelock auto-resnapshot: each retry re-copies, exceeds the window again, and loses its position again. If your data size puts the copy anywhere near 13 minutes, set the retention knob before sync start.

The fix (confirmed working) is DO's database config API — there is no SQL knob and no UI field until it's set once:

    # Seconds; accepted range 600-86400. 86400 (24 h) is the right value for migrations.
    curl -X PATCH "https://api.digitalocean.com/v2/databases/<cluster-id>/config" \
        -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"config": {"binlog_retention_period": 86400}}'

It takes effect immediately, no restart, and pre-existing binlogs stop being purged. One open question the validation could not settle: whether an attached binlog-dump connection holds the purger back on DO (on AWS RDS it provably does not). Until answered, treat the config-API knob as required for any DO CDC use rather than relying on a live stream to protect itself.

Deciding deliberately about re-snapshots. By default a purged position auto-recovers with a fresh cold-start re-snapshot. If a full re-copy is expensive and you'd rather decide by hand, sync start --no-auto-resnapshot fails loudly with the recovery commands instead of re-copying — useful while you're still sizing the retention window.

## Connecting: the cluster's private CA

DO clusters use a private CA, so neither system roots nor a bare ?tls=true can verify the server certificate. Fetch the cluster CA from the API and hand it to sluice with --source-tls-ca — CA-pinned verify-ca TLS (trust this CA, verify the chain, skip the hostname check that MySQL's SAN-less certificates can't satisfy):

    # The API returns the cluster CA base64-encoded
    curl -s "https://api.digitalocean.com/v2/databases/<cluster-id>/ca" \
        -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" | jq -r '.ca.certificate' | base64 -d > do-ca.pem

    sluice migrate \
        --source-driver mysql --source 'doadmin:pass@tcp(db-mysql-nyc3-12345.b.db.ondigitalocean.com:25060)/defaultdb' \
        --source-tls-ca do-ca.pem \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --dry-run

--source-tls-ca covers both the data connection and the binlog/CDC stream, and refuses if the DSN already sets tls= (one TLS decision, not two). The same flag exists on sync start, verify, and backup. The doadmin user has the replication grants sluice's binlog CDC needs — no extra GRANTs on defaults.

## sql_mode differences worth knowing

- Default sql_mode includes ANSI — double-quoted strings are identifiers on this server. sluice's own SQL is unaffected, but anything you run manually against the source with "double quotes" behaves differently than on a stock MySQL.

- sql_require_primary_key=true by default — keyless tables cannot be created on a DO target, and restoring keyless-table dumps there fails until the setting is relaxed. (Keyless tables are also the ones that can't take sluice's exact-UPDATE repairs — give them primary keys and everyone wins.)

## What sluice checks for you

- The retention advisory WARN — sync and backup runs against a *.db.ondigitalocean.com host warn about the ~13–16-minute default purge window and name the config-API remedy. (The host pattern is the only reliable signal — the server variable can't be trusted on this platform, so the WARN is unconditional.)

- Loud position-invalid recovery — a resume from a purged position surfaces as an explicit &ldquo;persisted position is no longer valid&rdquo; WARN and a fresh cold start, never a silent gap; --no-auto-resnapshot converts that into a hard stop with named recovery commands.

- --source-tls-ca refusals — the flag refuses to combine with a DSN-level tls= setting, and refuses on non-MySQL engines (Postgres uses sslrootcert= in the DSN) instead of silently ignoring a security flag.

- SLUICE-E-DRIVER-HOST-MISMATCH class checks — driver/DSN sanity is verified up front, before any connection.

## Next steps

- Zero-downtime migration — the full sync → verify → cutover flow once CDC is stable.

- Migrating from AWS RDS MySQL — the same purge-window class with a tighter window and a SQL-visible remedy.

- Field note: MySQL's own certificate can't pass verify-full — why --source-tls-ca is verify-ca, not verify-full.

- Field note: the transaction that lands in neither the snapshot nor the binlog — what the snapshot-position capture is protecting against.

---
Canonical page: https://sluicesync.com/docs/migrate-from-digitalocean-mysql/ · Full docs index: https://sluicesync.com/llms.txt
