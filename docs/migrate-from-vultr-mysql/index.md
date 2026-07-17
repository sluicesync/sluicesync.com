# Migrating from Vultr Managed MySQL with sluice

> The binlog-retention hazard is the headline: an out-of-band reaper purges every binlog file ~10–16 minutes after creation while the variable reads 3 days — and uniquely among managed MySQL, Vultr exposes no retention knob at all. That makes CDC migrate-and-cutover-shaped: keep any pause well under 10 minutes. Same Aiven-derived platform as DigitalOcean, without DigitalOcean's fix.

Vultr Managed Databases for MySQL works with sluice's vanilla mysql engine — cold copy and the CDC handoff were validated live (2026-07-17, throwaway hobbyist single-node, MySQL 8.4.8). Vultr's DBaaS is the same Aiven-derived platform as DigitalOcean's, and it shares DO's headline hazard — without DO's escape hatch.

## The binlog window, with no retention knob

An out-of-band platform reaper purges every binlog file ~10–16 minutes after creation — while @@binlog_expire_logs_seconds reads 259200 (3 days), the identical value DigitalOcean shows. The variable reports a window the platform does not enforce (same platform lineage as DO), but where DO's config API accepts a binlog_retention_period, Vultr exposes no retention control at all: the advanced-options API rejects the option by name, the database-update API ignores it, and SET GLOBAL / SET PERSIST / PURGE BINARY LOGS are denied to vultradmin. There is nothing to configure — the ~10-minute floor is permanent. sluice emits a loud WARN at sync/backup start on the *.vultrdb.com host pattern, the only reliable signal (@@version_comment is a bare &ldquo;Source distribution&rdquo;).

What that means in practice:

- A CDC position older than ~10 minutes is unrecoverable (ErrPositionInvalid, auto-resnapshot).

- An attached, caught-up stream is safe only while it stays caught up — files behind a live stream purge on schedule; the active file alone is immune (live-demonstrated).

- A cold copy or restart gap longer than ~10 minutes can livelock auto-resnapshot with no remedy: each retry re-copies, exceeds the window again, and loses its position again.

Treat Vultr MySQL as a migrate-and-cut-over source. Keep the sync stream attached and caught up from snapshot to cutover, and keep any planned pause well under 10 minutes. For long-running or pausable replication, this platform's defaults cannot support it — and there is no knob to change that.

## Connection + schema gotchas (the DigitalOcean list, almost verbatim)

- Host pattern *.vultrdb.com, on a nonstandard high port. Plaintext is accepted (require_secure_transport=OFF) but the unencrypted-binlog WARN applies. A bare ?tls=true fails — each cluster has a private CA (Aiven &ldquo;Project CA&rdquo;) embedded in the create/GET API response's ca_certificate field. Save it and pass --source-tls-ca (no separate CA-endpoint call, unlike DO):

    # ca_certificate comes back inline in the database create/get API response — save it, then:
    sluice sync start \
        --source-driver mysql --source 'vultradmin:pass@tcp(vultr-prod-xxx.vultrdb.com:16751)/defaultdb' \
        --source-tls-ca vultr-ca.pem \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id vultr-app

- vultradmin has the replication grants CDC needs, plus RELOAD — so FTWRL works and sluice runs the concurrent frozen-snapshot cold copy with no fallback WARNs.

- Default sql_mode includes ANSI — double-quoted strings are identifiers. Manual SQL against the source behaves differently than on stock MySQL.

- sql_require_primary_key=ON — keyless tables cannot be created on a Vultr target.

- local_infile=OFF (Vultr-as-target takes the batched-INSERT fallback); max_binlog_size is lowered to 64 MB; MySQL 8.4 is the only offered version.

## What sluice checks for you

- The unconditional retention WARN — sync and backup runs against a *.vultrdb.com host warn about the ~10-minute unconfigurable purge window. The wording is stronger than DigitalOcean's, because DO's message can point at a knob and Vultr's cannot.

- Loud position-invalid recovery — a resume from a purged position surfaces as an explicit WARN and a fresh cold start; --no-auto-resnapshot converts that into a hard stop with named recovery commands.

- --source-tls-ca refusals — the flag refuses to combine with a DSN-level tls= setting and refuses on non-MySQL engines, rather than silently ignoring a security flag.

## Next steps

- Migrating from Vultr Managed PostgreSQL — the Postgres sibling, which ships CDC-ready with zero preparation.

- Migrating from DigitalOcean MySQL — the same Aiven reaper class, but with a config-API retention knob.

- Field note: the retention variable that tells five different truths — where Vultr's no-knob case sits among the five.

- Zero-downtime migration — the sync → verify → cutover flow, kept inside the 10-minute window.

---
Canonical page: https://sluicesync.com/docs/migrate-from-vultr-mysql/ · Full docs index: https://sluicesync.com/llms.txt
