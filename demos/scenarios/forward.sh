#!/usr/bin/env bash
# Scenario for tapes/shot-forward.tape — produces demo/fwd-forward.log, the real
# log of a live MySQL->Postgres sync auto-forwarding an ADD COLUMN. Run this once
# (from demos/) before capturing shot-forward; the tape then greps the log.
#
# Prereqs: the local rig up; demo/sluice staged; demo/env.sh filled in (needs
# MYSQL_SHOP + PG_FWDDB). Uses a small shop.fwd_orders table (created here).
set -euo pipefail
cd "$(dirname "$0")/.."                    # demos/
DKR="${DOCKER:-/c/Program Files/Rancher Desktop/resources/resources/win32/bin/docker.exe}"
WD=$(pwd -W); . demo/env.sh
# MySQL user/pass come from the env.sh DSN (gitignored) — never hardcoded here.
_creds="${MYSQL_SHOP%%@*}"; MYUSER="${_creds%%:*}"; MYPASS="${_creds#*:}"

my() { "$DKR" exec sluice-localrig-mysql-src mysql -u"$MYUSER" -p"$MYPASS" shop -e "$1" 2>/dev/null; }
pg() { "$DKR" exec sluice-localrig-pg-dst psql -U postgres "$@" 2>/dev/null; }

echo "seed shop.fwd_orders (40 rows) + fresh fwddb"
my "DROP TABLE IF EXISTS fwd_orders;
    CREATE TABLE fwd_orders (id INT PRIMARY KEY, item VARCHAR(40) NOT NULL, qty INT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    INSERT INTO fwd_orders (id,item,qty) SELECT n, CONCAT('item-',n), (n%9)+1 FROM (SELECT @r:=@r+1 n FROM information_schema.columns a,(SELECT @r:=0) r LIMIT 40) t;"
pg -d postgres -c "DROP DATABASE IF EXISTS fwddb;" >/dev/null
pg -d postgres -c "CREATE DATABASE fwddb;" >/dev/null

echo "start sync (logs to demo/fwd-forward.log)"
"$DKR" rm -f fwdlog >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 "$DKR" run -d --name fwdlog --network local-rig_default -v "$WD/demo:/demo" \
  -e SLUICE_SOURCE="$MYSQL_SHOP" -e SLUICE_TARGET="$PG_FWDDB" --entrypoint bash \
  ghcr.io/charmbracelet/vhs:latest \
  -c "/demo/sluice sync start --source-driver mysql --target-driver postgres --include-table fwd_orders --stream-id fwd-demo --schema-changes=forward --log-format text --no-progress >/demo/fwd-forward.log 2>&1" >/dev/null

echo "poll for CDC-readiness, then apply the mid-sync schema change"
for _ in $(seq 1 40); do
  c=$(pg -d fwddb -tAc "SELECT count(*) FROM fwd_orders" | tr -d '\r'); [ "${c:-0}" -ge 40 ] && break; sleep 1
done
sleep 2
my "INSERT INTO fwd_orders (id,item,qty) VALUES (101,'pre-change',5);"; sleep 1
my "ALTER TABLE fwd_orders ADD COLUMN loyalty_tier VARCHAR(16) NULL;"; sleep 1     # <- forwarded
my "INSERT INTO fwd_orders (id,item,qty,loyalty_tier) VALUES (102,'post-change',2,'gold');"; sleep 4
"$DKR" rm -f fwdlog >/dev/null 2>&1 || true
echo "done — demo/fwd-forward.log ready; now: ./capture.sh shot-forward"
