#!/usr/bin/env bash
# Scenario for tapes/shot-backfill.tape — seeds shop.catalog_items on
# mysql-src with several thousand rows and a NULL price_tier column, the
# expand-contract "expand" step already applied by hand. The tape itself
# runs the real `sluice backfill` (the "migrate" step, ADR-0159) live, so
# there is nothing to pre-capture here — this script only provisions data.
#
# price_tier is a numeric tier code (1/2/3), not a string, so the tape's
# --set expression needs no nested quoting inside the VHS Type string.
#
# Re-runnable: DROP/CREATEs catalog_items fresh every invocation (price_tier
# always starts NULL), and the tape's own command passes --restart so a
# leftover sluice_migrate_state row from a prior capture never turns the
# live run into a no-op. Safe to re-run before every capture.
#
# Prereqs: the local rig up; demo/env.sh filled in (needs MYSQL_SHOP).
set -euo pipefail
cd "$(dirname "$0")/.."                    # demos/
DKR="${DOCKER:-/c/Program Files/Rancher Desktop/resources/resources/win32/bin/docker.exe}"
. demo/env.sh
# MySQL user/pass come from the env.sh DSN (gitignored) — never hardcoded here.
_creds="${MYSQL_SHOP%%@*}"; MYUSER="${_creds%%:*}"; MYPASS="${_creds#*:}"

my() { "$DKR" exec sluice-localrig-mysql-src mysql -u"$MYUSER" -p"$MYPASS" shop -e "$1" 2>/dev/null; }

echo "seed shop.catalog_items (120,000 rows, price_tier NULL — the un-backfilled column)"
my "SET SESSION cte_max_recursion_depth = 125000;
    DROP TABLE IF EXISTS catalog_items;
    CREATE TABLE catalog_items (
      id INT PRIMARY KEY AUTO_INCREMENT,
      sku VARCHAR(24) NOT NULL,
      price_cents INT NOT NULL,
      price_tier TINYINT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    INSERT INTO catalog_items (sku, price_cents)
    WITH RECURSIVE seq(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM seq WHERE n < 120000
    )
    SELECT CONCAT('SKU-', LPAD(n, 6, '0')), ((n * 37) % 15000) + 500
    FROM seq;"

echo "done — shop.catalog_items ready (price_tier NULL on all 120,000 rows); now: ./capture.sh shot-backfill"
