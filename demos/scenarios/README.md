# Capture scenarios — rig prerequisites per tape

Each tape records a real `sluice` run against the persistent local rig
(`sluice-localrig-{mysql,pg}-{src,dst}`; the rig's user/password for each engine
live in `demo/env.sh`, copied from `env.example.sh`).
**Scenario DB/data provisioning is NOT fully automated here** —
the harness assumes these fixtures already exist on the rig. `capture.sh` only
resets the single ephemeral `restoredb` before the restore tape; everything else
below is a standing fixture you seed once. This file documents what each surface
needs so a fixture can be rebuilt if the rig is ever reset.

DSNs are supplied via the named variables in `demo/env.sh` (gitignored; copy from
`env.example.sh`). The var name for each DB is shown in parentheses.

## Terminal tapes

| Tape | Needs on the rig |
|---|---|
| `shot-migrate` | MySQL `shop.customers` on `mysql-src` (`MYSQL_SHOP`) with rows; empty/absent Postgres `migdb` on `pg-dst` (`PG_MIGDB`) — migrate creates it. |
| `shot-verify` | `shop.customers` (MySQL) already migrated into `migdb` (run `shot-migrate` first) so the row-for-row compare is clean. |
| `shot-backup` | Postgres `migdb` on `pg-dst` (`PG_MIGDB`) with data. Writes an encrypted chain to `/demo/bkup` (the tape recreates that dir). |
| `shot-restore` | The `/demo/bkup` chain from `shot-backup` present under `demo/bkup`. Target `restoredb` on `pg-dst` (`PG_RESTOREDB`) — `capture.sh` DROP/CREATEs it fresh each run. |
| `shot-cutover` | MySQL `shop.orders` (`MYSQL_SHOP`) migrated into Postgres `cutdb` on `pg-dst` (`PG_CUTDB`) with sequences to prime. |
| `shot-matview` | Postgres `migdb` (`PG_MIGDB`) containing at least one materialized view to refresh. |
| `shot-trigger` | Postgres `postgres` DB on `pg-src` (`PG_SLOTS`, reused as `PG_DSN`) with a `customers` table; trigger-CDC objects get installed on it. |
| `shot-slot` / `shot-slot-wide` | Postgres `postgres` DB on `pg-src` (`PG_SLOTS`) with a few logical-replication slots (e.g. `demo_stream_main`, `demo_stream_orders`) so the table has rows. |
| `shot-health` | Fleet DBs: `fleet_users` on `pg-src` (`PG_FLEET_USERS`) → `fleet_analytics` on `pg-dst` (`PG_FLEET_ANALYTICS`), and a MySQL→PG `orders-to-warehouse` stream to `fleet_warehouse` (`PG_FLEET_WAREHOUSE`), each with recorded stream state so `sync health` has freshness/lag to report. |
| `shot-tui` | The three streams in `demo/fleet.yaml` (`orders-to-warehouse`, `users-to-analytics`, `inventory-sync`) with their source/target DBs present. The tape starts `sluice sync run` on `127.0.0.1:9300`, waits 30s, then attaches the TUI. |
| `shot-drift` | Postgres `drift_src` on `pg-src` (`PG_DRIFT_SRC`) and a **hand-edited** `drift_dst` on `pg-dst` (`PG_DRIFT_DST`) whose `accounts` table diverges, so `schema diff` refuses with a non-zero exit. |
| `shot-roundtrip` | Postgres `demo_shop` on `pg-src` (`PG_DEMO_SHOP`) with data; empty `demo_restored` on `pg-dst` (`PG_DEMO_RESTORED`). Writes/reads an encrypted chain under `/demo/rtbkup`. |
| `shot-metrics` | A live PlanetScale org/DB reachable with the metrics token (`org sluicesync`, db `soak-mysql231`). Token passed via `docker run -e` from the machine-local metrics-env file — never in the tape. |
| `featured-sync` | MySQL `shop.live_signups` (`MYSQL_SHOP`) → Postgres `shopdb` on `pg-dst` (`PG_SHOPDB`). For the CDC body to climb on camera, run a **background writer** appending rows to `shop.live_signups` during the recording (the "hero continuous-sync" writer — a small `INSERT ... VALUES` loop against `mysql-src`; keep its credentials out of any committed file). |

## HTML surfaces (no tape / no rig)

`dashboard.png` and `notify-email.png` are rendered headless by
`render/dashboard.mjs` and `render/email.mjs` — they inject a mock fleet payload /
run sluice's own email-template test, so they need neither the rig nor `capture.sh`.

## Discipline

- Never reset or recreate the shared `sluice-localrig-*` containers — other tapes
  reuse them. Only create/drop the specific demo DBs a scenario needs.
- Only `restoredb` is treated as ephemeral (auto-reset by `capture.sh`). If you
  add another throwaway target, reset it the same way (three `-c` calls: terminate
  → `DROP DATABASE IF EXISTS` → `CREATE DATABASE`).

## shot-forward (Schema change, forwarded)

Run `./scenarios/forward.sh` first — it seeds a small `shop.fwd_orders`, runs a
live MySQL→Postgres sync, applies an `ALTER … ADD COLUMN` mid-stream so sluice
forwards it, and captures the sync log to `demo/fwd-forward.log` (gitignored).
`tapes/shot-forward.tape` then greps that log for the `forward-add-column` line.
Needs `MYSQL_SHOP` + `PG_FWDDB` in `demo/env.sh`.

## featured-sync (hero) — verify-ca source TLS

The hero uses `--source-tls-ca /demo/ca.pem` (verify-ca, ADR-0158) so the binlog
stream is authenticated and no TLS warning shows. Stage the rig's MySQL CA first:
`docker exec sluice-localrig-mysql-src cat /var/lib/mysql/ca.pem > demos/demo/ca.pem`
(gitignored). Needs `MYSQL_SHOP` (no `tls=` param) + `PG_SHOPDB` in `demo/env.sh`.
