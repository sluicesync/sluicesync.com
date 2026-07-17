# The retention variable that tells five different truths

> binlog_expire_logs_seconds is the variable every MySQL CDC preflight checks to learn how long it has before the resume position is purged. On five managed platforms it means five different things: on two it lies (the number is days, the real window is minutes); on one it is honest and enforced; on one it is honest the other way (never-expire); and on one there is no knob behind it at all. Whether anything SQL-visible is the answer decides whether a tool can detect the trap or only guess at it from the hostname.

Observed — a wave of live throwaway probes across DigitalOcean, AWS RDS, Google Cloud SQL, Vultr, and Azure managed MySQL (2026-07-16/17, on the shipped v0.99.263 binary), each created, watched for its true purge cadence, and torn down. Every cadence below is one probe at one instance size — measured, not a platform constant. The sluice-side advisories named here shipped across v0.99.253–264.

## Why a snapshot-then-CDC tool cares

The binlog retention window bounds how long the initial copy may take. A snapshot-then-CDC migration captures its CDC start position up front, copies the tables, then resumes streaming from that position. If the binlogs behind the position are purged before the copy finishes — or during any later pause — the resume point is gone. In sluice's case that surfaces loudly (a coded position-invalid error naming the purged file), which sounds safe until you notice the failure mode that follows: an auto-resnapshot retry re-copies from scratch, exceeds the same window again, and loses its restart point again. Every individual error is loud; the loop as a whole silently never converges. So the true window is not a nicety — it is the difference between a migration that finishes and one that livelocks.

## Five platforms, five meanings of the same number

DigitalOcean — the variable lies (API-only truth). On a fresh Managed MySQL cluster, @@binlog_expire_logs_seconds reads 259200 (three days). An out-of-band platform reaper purges every binlog file roughly 13–16 minutes after it's created. There is no SQL query that reveals the real policy — the DO config API doesn't even expose a retention field until you set one. The only signal you're in this regime is the host suffix *.db.ondigitalocean.com. The remedy is a hidden knob: a config-API binlog_retention_period (seconds, 600–86400), immediate, no restart.

AWS RDS — the variable lies, but tighter, and the truth is SQL-visible. @@binlog_expire_logs_seconds reads 2592000 (thirty days); the real window in our probe was about 5–11 minutes, as RDS purges each file once its automated backup has uploaded, on a sweep that runs roughly every five minutes. Plan for the floor. Crucially, RDS exposes the real policy to SQL: CALL mysql.rds_show_configuration; returns the actual binlog retention hours (NULL means &ldquo;purge as soon as possible&rdquo;), and the remedy is plain SQL too — CALL mysql.rds_set_configuration('binlog retention hours', 24) — capped at 168 hours (seven days). An attached, caught-up stream does not hold the purger back: files behind a live stream purged on schedule, and a persisted position was dead about ten minutes after a clean detach.

Google Cloud SQL — the variable is honest and the floor is enforced. @@binlog_expire_logs_seconds reads 86400 (one day), it is the real on-disk window, and no out-of-band reaper exists on any observable timescale — files sat 3+ hours past creation, and a 35-minute detached stream warm-resumed on pure defaults. The platform even refuses to set the window below a day (a database-flag value under 86400 returns HTTP 400). The one genuinely dangerous knob is the point-in-time-recovery toggle: disabling binary logging restarts the instance and deletes every binlog, and re-enabling restarts it again and resets numbering to 000001, permanently invalidating positions on either side of the round-trip. And a decoy: --retained-transaction-log-days looks like the retention knob but governs the PITR copies in Cloud Storage, which the replication protocol can't read — the database flag binlog_expire_logs_seconds is the real one.

Vultr — the variable lies, and there is no knob at all. Vultr's DBaaS is the same Aiven-derived platform as DigitalOcean's, and it shares DO's headline hazard without DO's escape hatch: @@binlog_expire_logs_seconds reads 259200 (the identical DO value), the real window is ~10–16 minutes, and Vultr exposes no retention control anywhere. The advanced-options API rejects binlog_retention_period by name (&ldquo;is not a valid configuration option&rdquo;), the database-update API silently ignores it, and SET GLOBAL / SET PERSIST / PURGE BINARY LOGS are all denied to the admin user. The ~10-minute floor is permanent and unconfigurable — treat Vultr MySQL as a migrate-and-cut-over source, not a pausable one.

Azure — the variable is honest in the other direction. Azure Database for MySQL Flexible Server ships binlog_expire_logs_seconds=0, which in stock MySQL means &ldquo;never expire&rdquo; — and across 85 minutes of observation, including straight through a full backup, nothing was purged; a 35-minute detached stream warm-resumed on defaults. The risk inverts: with no effective expiry, binlogs accumulate against the instance's storage, so on Azure the operator's job is to bound retention, not extend it. (Azure has its own separate, sharper trap — a binlog_row_image=MINIMAL default that silently drops UPDATEs — but that is a different note.)

## The comparative picture

                    DigitalOcean   AWS RDS       Cloud SQL      Vultr          Azure
    var reads       3 days         30 days       1 day          3 days         0 (never)
    real window     ~13-16 min     ~5-11 min     1 day (floor)  ~10-16 min     unbounded
    truth lives     API-only       SQL-visible   the variable   nowhere        the variable
    remedy          config API     plain SQL     gcloud flag    NONE           set knob (storage)
    detect by       host suffix    host + SQL    @@version      host suffix    host + @@version
                                                 (-google)      *.vultrdb.com  (-azure)

## Detection beats pattern-guessing

The pivotal axis isn't the window length — it's where the truth lives, because that decides what kind of preflight is even possible. Where a platform exposes its real policy to SQL (RDS's mysql.rds_configuration, Cloud SQL's honest variable, Azure's honest variable), a tool can read the actual value and stay silent when the operator has already fixed it — a precise, no-false-positive check. Where the truth is invisible to SQL (DO's API-only policy, Vultr's absent knob), the only honest signal is the connection-string hostname, so the tool is stuck with a blunter instrument: an unconditional warning triggered by the host suffix, which fires even on a correctly-configured cluster because it has no way to know. A variable-based preflight there would be worse than nothing — it would confidently report a three-day window the platform doesn't honor.

There is one more wrinkle: Cloud SQL has no hostname to match at all — it connects by bare IP, or through an auth proxy at 127.0.0.1. Its in-band fingerprint carries the detection instead: @@version ends in -google. Vultr, at the other extreme, has a clean host suffix (*.vultrdb.com) but a bare @@version_comment of &ldquo;Source distribution&rdquo; — no in-band signal — so the host pattern is the only thing to match on. Fingerprint the platform however you can, then check for a SQL-visible truth source before you decide whether to detect or to guess.

## What sluice does about it

- DigitalOcean (v0.99.253): an unconditional host-pattern WARN on *.db.ondigitalocean.com at sync and backup start, naming the binlog_retention_period config-API knob — because the host is the only signal that exists.

- AWS RDS (v0.99.263): a detect-first advisory — sluice reads binlog retention hours from mysql.rds_configuration and WARNs only when it is NULL or under a day, staying silent when the operator has set it, and degrading to the DO-style unconditional pattern WARN if the probe can't run. It also fires on warm resumes, because an attached stream is no shield.

- Google Cloud SQL (v0.99.264): detection keys on @@version -google (no host to match); there's nothing to warn about at defaults, so the advisory is the inverse — recovery text on a position-invalid error explaining that the PITR toggle resets binlog numbering and invalidates prior positions.

- Vultr: the same platform lineage as DO with no SQL-visible truth and no remedy, so it warrants the DO-style unconditional host-pattern WARN — with stronger wording than DO's, because DO's message can point at a knob and Vultr's cannot.

- Azure: retention is safe by default, so no retention WARN; the Azure teeth are elsewhere (the row-image preflight). A mild INFO to bound retention for storage hygiene on long-lived syncs is the only retention-flavored note it needs.

## The transferable lesson

On managed databases, binlog_expire_logs_seconds reports what the engine would do, not what the platform does — and the gap runs in both directions, from &ldquo;3 days on the label, 15 minutes in practice&rdquo; to &ldquo;0 means never, and the risk is your disk.&rdquo; Never let the variable stand in for the window. Instead: fingerprint which platform you're on (host suffix or @@version), look for a platform-native truth source you can query, and only fall back to hostname pattern-guessing where none exists. Set the window explicitly through the platform's own knob — and if there is no knob (Vultr), design around a fixed, unconfigurable floor. Then audit your retry logic for the livelock shape, because &ldquo;every error was loud&rdquo; is no defense when the loop as a whole silently never terminates.

## Primary sources

- DigitalOcean Managed MySQL configuration API (binlog_retention_period, 600–86400 s); AWS RDS mysql.rds_set_configuration / mysql.rds_show_configuration (binlog retention hours, default NULL, max 168) and the automated-backups prerequisite; Google Cloud SQL database flags (binlog_expire_logs_seconds, floor 86400) and the PITR binlog coupling; Azure Database for MySQL Flexible Server server parameters.

- MySQL Reference Manual — binlog_expire_logs_seconds (what the variable governs when the engine, not a platform reaper, owns expiry).

- sluice managed-services notes and the five probe reports — DO, RDS, Cloud SQL, Vultr, and Azure MySQL retention observations and detect-first advisories.

---
Canonical page: https://sluicesync.com/field-notes/managed-mysql-binlog-retention/ · Full docs index: https://sluicesync.com/llms.txt
