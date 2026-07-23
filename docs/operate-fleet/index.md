# Operate a sync fleet

> Supervise many continuous syncs from one process — failure-isolated, observable, and reconfigurable without a restart.

Once you keep several cross-database syncs alive at once, running each sync start as its own pod or systemd unit gets unwieldy. sync run collapses that to one supervised process driven by a single fleet config: it runs N independent syncs, each with its own stream-id, and — the load-bearing property — fully failure-isolated, so one sync crashing, erroring, or even panicking can never take down its healthy peers (ADR-0122). This guide covers running a fleet, observing it, and reconfiguring it live.

## The fleet config

A fleet is a YAML file listing each sync as a curated subset of the sync start flags you already know, in kebab-case. A top-level restart block tunes the supervisor's bounded-backoff policy:

    # syncs.yaml
    syncs:
      - stream-id: orders
        source-driver: postgres
        source: postgres://user:pass@src-a:5432/app
        target-driver: mysql
        target: mysql://user:pass@dst:3306/app
        slot-name: orders           # distinct per Postgres source (see below)
        apply-concurrency: 4
        metrics-listen: :9101
      - stream-id: inventory
        source-driver: mysql
        source: mysql://user:pass@src-b:3306/inv
        target-driver: postgres
        target: postgres://user:pass@dst:5432/inv
        apply-delay: 60s
        metrics-listen: :9102
    restart:
      backoff-base: 1s
      backoff-cap: 30s
      max-consecutive-failures: 0   # 0 = restart forever with capped backoff

Two data-corruption classes are refused at load, loudly. Two Postgres-source syncs that resolve to the same replication slot-name would fight over one single-consumer slot — silent corruption — so the loader refuses the config, naming both stream-ids and the slot. Duplicate stream-ids on the same target (which would clobber each other's position row) are refused the same way. When several syncs point at one target server, the loader WARNs that they share a connection budget so you can size apply-concurrency accordingly.

Each sync's own retry (ADR-0093 re-snapshot, apply-retry backoff) is the inner loop; the supervisor's restart is the outer loop. A sync that drains cleanly (a sync stop or Ctrl-C) is left stopped; a sync that dies with the process still live is logged loudly, backed off, and restarted. The consecutive-failure counter resets once a sync has run longer than the healthy threshold, so a sync that ran for hours before dying carries no restart debt.

## Run the fleet

Validate the config first with --dry-run (it checks required fields, stream-id and slot-name uniqueness, and retry bounds, then prints the resolved plan without starting anything), then run it:

    # validate + print the plan, start nothing
    sluice sync run --config syncs.yaml --dry-run

    # run the fleet, with a read-only dashboard on :9300
    sluice sync run --config syncs.yaml --dashboard-listen :9300

The process blocks until every sync exits. Ctrl-C / SIGTERM stops all of them cleanly. A single-sync fleet that can never start exits non-zero, but a fleet with any healthy peer keeps running regardless of what its neighbors do.

## Reload without a restart (SIGHUP)

Edit syncs.yaml and send the running process a SIGHUP: sluice re-reads and re-validates the file, then reconciles the live fleet — starting newly-added syncs, draining and stopping removed ones, and restarting any whose spec changed (detected by a per-stream fingerprint, so unchanged syncs are left untouched):

    kill -HUP "$(pgrep -f 'sluice sync run')"

A bad reload never takes the fleet down. The reload runs the exact same validators as the initial load before building anything; if the new file fails to parse or validate (a slot collision, a duplicate stream-id, a missing field), the reload is refused loudly and the running fleet keeps going on the old config, unchanged. Each reload logs its outcome — the started / stopped / restarted stream-ids, or "no changes." SIGHUP is POSIX-only; on Windows, restart the process to change the fleet.

## See the whole fleet at once

sync status --all rolls up every stream across every target named in the fleet config into one table — reading the target control tables directly, so no running supervisor is required. A target that can't be reached is reported inline and skipped rather than blanking the whole view:

    sluice sync status --all --config syncs.yaml --summary

    # live-refresh every 2s, machine-readable
    sluice sync status --all --config syncs.yaml --format json --watch 2s

## Observe it: Prometheus metrics and readiness

Give each sync a metrics-listen address in the config (as above) and it binds a Prometheus-format /metrics endpoint plus /healthz (liveness) and /readyz (flips to 200 once the sync has finished its snapshot/warm-resume preamble and entered the apply loop). The exported sluice_* gauge families include:

Gauge · What it tells you ·

sluice_sync_lag_seconds · Seconds the target trails the source's latest applied commit (engine-neutral apply lag; 0 when caught up). ·

sluice_seconds_since_last_apply · Wall-clock seconds since this stream's most recent applier commit — the staleness signal. ·

sluice_stream_known · Constant 1 per tracked stream; count(sluice_stream_known) gives a stream-count alert. ·

sluice_apply_batch_size_current / _p95_seconds · The AIMD apply-batch controller's current target size and rolling p95 latency. ·

sluice_target_* · Target CPU / memory / storage utilisation and replica lag — present only when PlanetScale telemetry is configured. ·

Because /readyz is a real readiness signal, it wires straight into a Kubernetes probe on the sync's metrics port:

    readinessProbe:
      httpGet:
        path: /readyz
        port: 9101
      periodSeconds: 10

### Pre-emptive Postgres slot-health warnings

For a Postgres source, a replication slot that outruns its retention budget gets evicted and the stream breaks. sluice watches for that ahead of time and emits severity-graded slog warnings: a WARN when retention pressure crosses 70% of max_slot_wal_keep_size, a CRITICAL at 85% (eviction imminent), and a WARN when the slot has been observed inactive for 30 minutes or more (ADR-0059). These are rate-limited and emit a "cleared" INFO when the condition resolves, so the alarm turns off visibly.

## Live dashboards: web and terminal

sync run --dashboard-listen ADDR serves a self-contained, auto-refreshing HTML page of the live fleet — per-sync state, restart count, consecutive failures, last error, uptime — backed by a stable GET /api/fleet JSON API (ADR-0124). It is strictly read-only: no stop/restart controls, no data path, and it exposes only what sync status --all already does (stream-ids, states, error strings — no DSNs, no row data). It has no authentication, so bind it to localhost or a trusted network.

For a terminal equivalent, sync tui --connect is a full-screen client that polls that same /api/fleet endpoint — so it works locally or over an SSH tunnel to the dashboard port, without disturbing the fleet process:

    # terminal 1: run the fleet with the dashboard API exposed
    sluice sync run --config syncs.yaml --dashboard-listen :9300

    # terminal 2 (local or over an SSH tunnel): live terminal view
    sluice sync tui --connect :9300 --refresh 2s

The dashboard binds when the fleet starts; if the address can't be bound the command fails loudly rather than running a fleet without the dashboard you asked for. The TUI keeps the last-known fleet on screen with an "unreachable" banner if a poll fails, instead of blanking.

## Threshold alerts (advisory)

The fleet can push threshold alerts to a webhook or Slack. Set the sink URL via its env var (SLUICE_NOTIFY_WEBHOOK / SLUICE_NOTIFY_SLACK), then arm one or more thresholds. Alerts are edge-triggered, cooldown'd (--notify-cooldown, default 15m), and advisory + failure-isolated — a dead sink is logged and swallowed, never affecting the sync:

Threshold · Fires when… ·

--notify-sync-lag-seconds · sluice's own apply lag (sluice_sync_lag_seconds) is at or above N. Ungated — works on MySQL and Postgres alike, needing only a sink. ·

--notify-lag-seconds · The target's control-plane replica lag is at or above N. Requires PlanetScale telemetry. ·

--notify-storage-util / --notify-cpu-util / --notify-mem-util · Target utilisation (0–1 fraction) is at or above the given level. Requires PlanetScale telemetry. ·

--notify-storage-growth-per-min · Storage is climbing at or above N fraction-of-capacity per minute — a pre-grow early warning. Requires telemetry. ·

notify-dead-tuple-ratio / notify-xid-age · Postgres-target autovacuum advisories (v0.99.288): the worst user table's dead-tuple ratio, and the database's age(datfrozenxid) wraparound headroom. Ungated — probed from the target's own catalog; Postgres targets only. ·

All the util / control-plane-lag / growth rules need a PlanetScale telemetry provider (--planetscale-org plus the metrics-token flags); --notify-sync-lag-seconds and the two vacuum advisories work without it, needing only a sink. The telemetry-gated alerter set is also available on the standalone metrics-watch probe.

## Next steps

- sync start reference — the full per-sync flag surface each fleet entry is built from.

- Sync to PlanetScale / Vitess — the telemetry credentials the util-threshold alerts and sluice_target_* gauges require.

- Zero-downtime migration — the single-stream cutover flow each fleet sync runs internally.

---
Canonical page: https://sluicesync.com/docs/operate-fleet/ · Full docs index: https://sluicesync.com/llms.txt
