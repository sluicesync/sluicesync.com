#!/usr/bin/env bash
# capture.sh — run the VHS screenshot tapes against the local sluice-localrig-*
# rig and copy the chosen frames into ../assets/screenshots/.
#
#   ./capture.sh <tape>     # e.g. ./capture.sh shot-migrate   (no .tape suffix)
#   ./capture.sh all        # run every tape in tapes/
#
# Credentials are NEVER committed: the tapes reference named vars that come from
# demos/demo/env.sh (gitignored). Stage the rig once:
#   cp env.example.sh   demo/env.sh    && edit real DSNs
#   cp fleet.example.yaml demo/fleet.yaml && edit real DSNs   (fleet/tui tapes)
#   put the released Linux binary at    demo/sluice
#
# Frames land in ../assets/screenshots/ per the manifest.json frames[].file map
# (see the case block below). VHS timing is finicky — QA every frame by eye and
# re-pick the s-frame in the case block if the default grabbed a mid-transition.
set -euo pipefail

cd "$(dirname "$0")"                      # demos/
DEMO_DIR="demo"
ASSETS="../assets/screenshots"
NETWORK="local-rig_default"
VHS_IMAGE="ghcr.io/charmbracelet/vhs:latest"
METRICS_ENV_FILE="/c/code/PLANETSCALE_SLUICESYNC_METRICS.env"

# --- locate docker (Rancher Desktop hides it from PATH on Windows) ------------
DOCKER="${DOCKER:-docker}"
if ! command -v "$DOCKER" >/dev/null 2>&1; then
  DOCKER="/c/Program Files/Rancher Desktop/resources/resources/win32/bin/docker.exe"
fi
command -v "$DOCKER" >/dev/null 2>&1 || { echo "ERROR: docker not found (set \$DOCKER)"; exit 1; }

die() { echo "ERROR: $*" >&2; exit 1; }

# --- preflight: staged binary + credentials -----------------------------------
require_binary() {
  [ -f "$DEMO_DIR/sluice" ] || die "missing $DEMO_DIR/sluice — stage the released Linux binary (sluice_*_Linux_x86_64.tar.gz) there."
}
require_env() {
  [ -f "$DEMO_DIR/env.sh" ] || die "missing $DEMO_DIR/env.sh — copy env.example.sh to $DEMO_DIR/env.sh and fill in real DSNs (it is gitignored)."
}
require_fleet() {
  [ -f "$DEMO_DIR/fleet.yaml" ] || die "missing $DEMO_DIR/fleet.yaml — copy fleet.example.yaml to $DEMO_DIR/fleet.yaml and fill in real DSNs (it is gitignored)."
}

# --- reset the ephemeral restore target (restoredb) ---------------------------
# Only the restore tape needs a fresh DB; every other tape assumes its localrig
# scenario DBs/tables/slots/backup-chain already exist (see scenarios/README.md).
# Postgres can't DROP+CREATE a database in one statement, so three -c calls.
reset_restoredb() {
  echo "  resetting restoredb on sluice-localrig-pg-dst ..."
  "$DOCKER" exec sluice-localrig-pg-dst psql -U postgres -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='restoredb' AND pid<>pg_backend_pid();" >/dev/null
  "$DOCKER" exec sluice-localrig-pg-dst psql -U postgres -d postgres \
    -c "DROP DATABASE IF EXISTS restoredb;" >/dev/null
  "$DOCKER" exec sluice-localrig-pg-dst psql -U postgres -d postgres \
    -c "CREATE DATABASE restoredb;" >/dev/null
}

# --- run one tape through VHS -------------------------------------------------
run_tape() {
  local name="$1"
  local tape="tapes/$name.tape"
  [ -f "$tape" ] || die "no such tape: $tape"

  require_binary
  require_env
  case "$name" in
    shot-tui) require_fleet ;;
  esac
  case "$name" in
    shot-restore) reset_restoredb ;;
  esac

  # shot-metrics needs the PlanetScale metrics token passed through to the
  # container env (never baked into the tape). Map the file's *_SERVICE_TOKEN_*
  # keys onto the CLI's PLANETSCALE_METRICS_TOKEN_ID/_TOKEN names.
  local metrics_args=()
  if [ "$name" = "shot-metrics" ]; then
    [ -f "$METRICS_ENV_FILE" ] || die "missing $METRICS_ENV_FILE (PlanetScale metrics token) for shot-metrics."
    # shellcheck disable=SC1090
    set -a; . "$METRICS_ENV_FILE"; set +a
    export PLANETSCALE_METRICS_TOKEN_ID="${PLANETSCALE_METRICS_SERVICE_TOKEN_ID:-}"
    export PLANETSCALE_METRICS_TOKEN="${PLANETSCALE_METRICS_SERVICE_TOKEN:-}"
    [ -n "$PLANETSCALE_METRICS_TOKEN_ID" ] || die "PLANETSCALE_METRICS_SERVICE_TOKEN_ID not set in $METRICS_ENV_FILE"
    metrics_args=(-e PLANETSCALE_METRICS_TOKEN_ID -e PLANETSCALE_METRICS_TOKEN)   # pass-through, value never on the command line
  fi

  local WD
  WD=$(pwd -W)
  echo "==> capturing $name"
  MSYS_NO_PATHCONV=1 "$DOCKER" run --rm --network "$NETWORK" \
    "${metrics_args[@]}" \
    -v "$WD:/vhs" -v "$WD/$DEMO_DIR:/demo" \
    "$VHS_IMAGE" "$tape"

  copy_frames "$name"
}

# --- copy [ produced-file -> assets file ] pairs, if the produced file exists --
cp_if() { [ -f "$1" ] && { mkdir -p "$ASSETS"; cp "$1" "$ASSETS/$2"; echo "    -> $ASSETS/$2"; } || true; }

# Tape -> committed asset mapping (matches manifest.json frames[].file / demos[]).
# Defaults pick a sensible s-frame; re-pick here if VHS grabbed a transition.
copy_frames() {
  case "$1" in
    featured-sync)
      cp_if featured-sync.gif       sync-demo.gif
      cp_if featured-sync.mp4       sync-demo.mp4
      cp_if featured-sync.webm      sync-demo.webm
      cp_if featured-sync-cdc1.png  sync-begin.png
      cp_if featured-sync-cdc2.png  sync-mid.png
      cp_if featured-sync-end.png   sync-end.png
      ;;
    shot-migrate)
      cp_if shot-migrate-s1.png     migrate-begin.png
      cp_if shot-migrate-s4.png     migrate-mid.png
      cp_if shot-migrate-s6.png     migrate-end.png
      cp_if shot-migrate.gif        demo-migrate.gif       # more-demos strip
      cp_if shot-migrate.mp4        demo-migrate.mp4
      cp_if shot-migrate.webm       demo-migrate.webm
      ;;
    shot-verify)
      cp_if shot-verify-s1.png      verify-begin.png
      cp_if shot-verify-s6.png      verify-end.png
      ;;
    shot-backup)
      cp_if shot-backup-s1.png      backup-begin.png
      cp_if shot-backup-s6.png      backup-end.png
      ;;
    shot-restore)
      cp_if shot-restore-s1.png     restore-begin.png
      cp_if shot-restore-s6.png     restore-end.png
      ;;
    shot-cutover)
      cp_if shot-cutover-s5.png     cutover.png
      ;;
    shot-matview)
      cp_if shot-matview-s4.png     matview.png
      ;;
    shot-trigger)
      cp_if shot-trigger-s4.png     trigger.png
      ;;
    shot-slot-wide)
      cp_if shot-slot-wide.png      slot.png
      ;;
    shot-slot)
      : ;;  # narrow variant; the committed slot.png comes from shot-slot-wide
    shot-health)
      cp_if shot-health-s2.png      sync-health.png
      ;;
    shot-tui)
      cp_if shot-tui-s4.png         sync-tui.png
      ;;
    shot-metrics)
      cp_if shot-metrics.png        metrics-watch.png
      ;;
    shot-roundtrip)
      cp_if shot-roundtrip.gif      demo-roundtrip.gif
      cp_if shot-roundtrip.mp4      demo-roundtrip.mp4
      cp_if shot-roundtrip.webm     demo-roundtrip.webm
      ;;
    shot-forward)
      cp_if shot-forward.gif        demo-forward.gif
      cp_if shot-forward.mp4        demo-forward.mp4
      cp_if shot-forward.webm       demo-forward.webm
      ;;
    shot-redact)
      cp_if shot-redact.gif        demo-redact.gif
      cp_if shot-redact.mp4        demo-redact.mp4
      cp_if shot-redact.webm       demo-redact.webm
      ;;
    shot-drift)
      cp_if shot-drift.gif          demo-drift.gif
      cp_if shot-drift.mp4          demo-drift.mp4
      cp_if shot-drift.webm         demo-drift.webm
      ;;
    *) echo "    (no asset mapping for $1; frames left in demos/)" ;;
  esac
}

# --- main ---------------------------------------------------------------------
[ $# -ge 1 ] || die "usage: $0 <tape-name|all>"

if [ "$1" = "all" ]; then
  for t in tapes/*.tape; do
    run_tape "$(basename "$t" .tape)"
  done
else
  run_tape "${1%.tape}"
fi
echo "done."
