# Screenshot-capture credentials — TEMPLATE (safe to commit).
#
# Copy this file to  demos/demo/env.sh  and fill in the real DSNs for your
# capture rig. That copy lives under demos/demo/ which is GITIGNORED, so real
# credentials never land in the public repo. The committed tapes reference only
# the NAMED variables below — never a literal DSN — and `source /demo/env.sh`
# inside the VHS recording shell (demos/demo is mounted at /demo).
#
#   cp demos/env.example.sh demos/demo/env.sh
#   $EDITOR demos/demo/env.sh      # put your real host/user/pass in
#
# The placeholder values below are intentionally fake — do not commit real ones.

# MySQL `shop` demo source (migrate / verify / cutover / hero-sync source).
export MYSQL_SHOP="USER:PASS@tcp(HOST:3306)/shop"

# Postgres migrate/verify/matview target DB.
export PG_MIGDB="postgres://USER:PASS@HOST:5432/migdb?sslmode=disable"

# Postgres restore target DB (restore triptych — reset before each capture).
export PG_RESTOREDB="postgres://USER:PASS@HOST:5432/restoredb?sslmode=disable"

# Postgres cutover target DB.
export PG_CUTDB="postgres://USER:PASS@HOST:5432/cutdb?sslmode=disable"

# Schema-drift demo: source vs hand-edited target.
export PG_DRIFT_SRC="postgres://USER:PASS@HOST:5432/drift_src?sslmode=disable"
export PG_DRIFT_DST="postgres://USER:PASS@HOST:5432/drift_dst?sslmode=disable"

# Fleet health-probe DBs.
export PG_FLEET_ANALYTICS="postgres://USER:PASS@HOST:5432/fleet_analytics?sslmode=disable"
export PG_FLEET_USERS="postgres://USER:PASS@HOST:5432/fleet_users?sslmode=disable"
export PG_FLEET_WAREHOUSE="postgres://USER:PASS@HOST:5432/fleet_warehouse?sslmode=disable"

# Encrypted backup -> restore roundtrip demo DBs.
export PG_DEMO_SHOP="postgres://USER:PASS@HOST:5432/demo_shop?sslmode=disable"
export PG_DEMO_RESTORED="postgres://USER:PASS@HOST:5432/demo_restored?sslmode=disable"

# Postgres source used for `slot list` and `trigger setup` (a DB with the demo
# replication slots + a `customers` table). Points at the maintenance DB.
export PG_SLOTS="postgres://USER:PASS@HOST:5432/postgres?sslmode=disable"
export PG_FWDDB="postgres://USER:PASS@HOST:5432/fwddb?sslmode=disable"

# Postgres target DB for the homepage hero continuous-sync demo (featured-sync).
export PG_SHOPDB="postgres://USER:PASS@HOST:5432/shopdb?sslmode=disable"

# Backup encryption passphrase (used by backup/restore/roundtrip tapes via
# --encryption-passphrase-env ENC_PASS, so it never appears on a command line).
export ENC_PASS="CHANGE_ME"
