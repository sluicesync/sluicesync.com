#!/usr/bin/env bash
# Scenario for tapes/shot-redact.tape — seeds a PII table, runs a real redaction
# migrate to capture the before/after tables (demo/redact-before.txt, redact-after.txt),
# then leaves the PG target EMPTY so the tape can re-run the same migrate live.
# Needs MYSQL_PIIDEMO + PG_PIIDEMO in demo/env.sh. Credentials never hardcoded.
set -euo pipefail
cd "$(dirname "$0")/.."                    # demos/
DKR="${DOCKER:-/c/Program Files/Rancher Desktop/resources/resources/win32/bin/docker.exe}"
WD=$(pwd -W); . demo/env.sh
_c="${MYSQL_PIIDEMO%%@*}"; MYUSER="${_c%%:*}"; MYPASS="${_c#*:}"
my() { "$DKR" exec sluice-localrig-mysql-src mysql -u"$MYUSER" -p"$MYPASS" "$@" 2>/dev/null; }
pg() { "$DKR" exec sluice-localrig-pg-dst psql -U postgres "$@" 2>/dev/null; }
reset_pg() { pg -d postgres -c "DROP DATABASE IF EXISTS piidemo;" >/dev/null; pg -d postgres -c "CREATE DATABASE piidemo;" >/dev/null; }

echo "seed piidemo.people (Luhn-valid test PANs)"
my -e "DROP DATABASE IF EXISTS piidemo; CREATE DATABASE piidemo;
  USE piidemo;
  CREATE TABLE people (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL, email VARCHAR(80) NOT NULL, ssn CHAR(11) NOT NULL, card CHAR(19) NOT NULL, phone CHAR(12) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  INSERT INTO people VALUES
   (1,'Alice Nguyen','alice.nguyen@example.com','501-23-4567','4111 1111 1111 1111','415-555-0142'),
   (2,'Bob Okafor','bob.okafor@example.com','502-34-5678','5555 5555 5555 4444','415-555-0198'),
   (3,'Carla Diaz','carla.diaz@example.com','503-45-6789','4012 8888 8888 1881','628-555-0117'),
   (4,'Deepa Rao','deepa.rao@example.com','504-56-7890','6011 1111 1111 1117','628-555-0165');"
reset_pg

REDACT="--redact people.name=mask:inner:1,1 --redact people.email=mask:email --redact people.ssn=mask:ssn --redact people.card=mask:pan --redact people.phone=mask:inner:4,4"
echo "run the redaction migrate (deterministic) to capture the after"
MSYS_NO_PATHCONV=1 "$DKR" run --rm --network local-rig_default -v "$WD/demo:/demo" \
  -e SLUICE_SOURCE="$MYSQL_PIIDEMO" -e SLUICE_TARGET="$PG_PIIDEMO" --entrypoint bash \
  ghcr.io/charmbracelet/vhs:latest \
  -c "/demo/sluice migrate --source-driver mysql --target-driver postgres --include-table people $REDACT >/dev/null 2>&1"

fmt() { awk -F'\t' 'BEGIN{printf "%-3s  %-13s  %-25s  %-12s  %-20s  %-13s\n","id","name","email","ssn","card","phone"; print "---------------------------------------------------------------------------------------------------"}{printf "%-3s  %-13s  %-25s  %-12s  %-20s  %-13s\n",$1,$2,$3,$4,$5,$6}'; }
my piidemo -N -e "SELECT id,name,email,ssn,card,phone FROM people ORDER BY id;" | tr -d '\r' | fmt > demo/redact-before.txt
pg -d piidemo -t -A -F $'\t' -c "SELECT id,name,email,ssn,card,phone FROM people ORDER BY id;" | tr -d '\r' | fmt > demo/redact-after.txt
reset_pg   # leave target empty for the tape's live migrate
echo "done — before/after captured; piidemo target empty; now: ./capture.sh shot-redact"
