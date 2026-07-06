# PlanetScale & Vitess

> Migrate and continuously sync from PlanetScale-MySQL or any Vitess deployment through the VStream gRPC feed.

PlanetScale (and self-hosted Vitess) don't expose MySQL's binary log directly — row changes come through Vitess's VStream gRPC API instead. sluice speaks that protocol through a MySQL-engine flavor: the same reader, decoder, and pipeline you use for vanilla MySQL, with a Vitess-shaped CDC transport and a capability set that reflects the platform's constraints. This guide covers selecting the flavor, tuning the cold-start copy, warm-resume across a purged position, and reading the throttler/lag signals that are unique to a Vitess-fronted source.

## Selecting the flavor

Two driver names register the VStream-backed flavor; pick by deployment shape:

Driver · Use for ·

planetscale · PlanetScale's hosted MySQL. TLS by default; auth is HTTP Basic where the username/password are your service-token name and value; the default shard convention is -. ·

vitess · A Vitess cluster you run yourself (etcd + vtctld + vtgate + vttablets). Shares PlanetScale's VStream engine code; point it at your vtgate. ·

    sluice sync start \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver postgres    --target "$SLUICE_TARGET"

What auto-detection does — and doesn't. A *.connect.psdb.cloud / *.private-connect.psdb.cloud host is recognised automatically so sluice excludes Vitess's _vt_* shadow tables — even when you connect with the plain mysql driver. Choosing the transport is still explicit, though: the mysql driver against a PlanetScale host gives you binlog CDC, not VStream. Pass --source-driver planetscale to get the VStream feed. Non-PlanetScale Vitess (custom domains) needs a manual --exclude-table='_vt_*'.

## Source preconditions

Key constraints inherited from the Vitess platform (sluice already accounts for these — they're context, not steps):

- No direct binlog access — CDC goes through VStream gRPC (the flavor declares CDCVStream, which the streamer's capability check accepts).

- No LOAD DATA INFILE; the cold-copy uses batched inserts.

- Sharded keyspaces are supported on both the standalone-CDC and snapshot→CDC paths. vtgate fans the COPY phase out per shard, then the same stream tails CDC across all shards.

A VStream source password needs only read access. If a PlanetScale branch is the target, the password's role must allow DDL — sluice creates the destination tables plus its control tables (sluice_cdc_state, sluice_cdc_schema_history, …) on cold-start, and a reader/writer/readwriter role is denied DDL on a production branch. Mint the target password with pscale password create <db> <branch> --role admin. If the target branch has Safe Migrations enabled, pre-create the tables and pass --schema-already-applied.

## Sharded keyspaces

All optional; ride on the standard MySQL DSN as extra ?key=value parameters:

DSN param · Purpose ·

vstream_shards · Comma-separated shard list (default -; e.g. vstream_shards=-80,80-). vttestserver dev clusters typically use 0. ·

vstream_auto_discover_shards=true · Discover the layout at Open time via SHOW VITESS_SHARDS LIKE '<keyspace>/%'. Mutually exclusive with vstream_shards; recommended when the layout isn't known statically. ·

vstream_endpoint · Override the vtgate gRPC endpoint. Default <sql-host>:443, matching PlanetScale's convention. ·

vstream_transport · tls (default) or plaintext (localhost vttestserver / dev only). ·

vstream_auth · basic (default) or none (vanilla Vitess with no VStream auth). ·

A mid-stream reshard surfaces as a typed ShardLayoutChangedError; the continuous-sync streamer's outer loop reopens the reader on the new layout automatically.

## VStream cold-start throughput

The snapshot copy is bounded differently from a native-MySQL copy because vtgate forces a single cross-region-RTT-bound INSERT connection (it blocks LOAD DATA). Two axes widen it:

Flag · Axis ·

--copy-fanout-degree · Write fan-out (ADR-0097, PlanetScale-MySQL target): PK-hash-partition the incoming snapshot row stream out to N concurrent batched-INSERT writers, each on its own connection. 0 = auto (4); 1 = serial. Bounded by the target connection budget. ·

--vstream-copy-table-parallelism · Read axis (ADR-0099, Vitess/PlanetScale source): the number of concurrent single-table COPY streams the auto-shard cold-copy runs. 0 = fall back to the DSN vstream_copy_table_parallelism param, then the engine default (1 = serial). An explicit flag wins over the DSN param. ·

The generic --table-parallelism / --bulk-parallelism cold-start knobs are inert on a VStream source (setting one emits a one-time WARN). Use the two flags above instead. --copy-table-parallelism is for self-managed non-Vitess MySQL, not PlanetScale.

## Warm-resume & auto-resnapshot

On restart, sluice resumes from the persisted VGTID position. PlanetScale's binlog-retention window is finite, so a resume from a position older than the source's retained binlogs is routine — and by default (ADR-0093, parity with the self-hosted binlog path) sluice auto-recovers with a fresh cold-start re-snapshot rather than failing. On an idempotent VStream source the upsert copy absorbs the overlap and the target is not dropped.

When a full re-snapshot is expensive (very large tables) and you'd rather decide deliberately, pass --no-auto-resnapshot. sluice then fails loudly with an actionable error naming the recovery commands (--restart-from-scratch / --reset-target-data) instead of re-copying. It gates both the pre-flight fall-through and the reactive VStream recovery.

## The throttler & lag reality

Some VStream delays you act on; some you wait out. The measured findings reset a few intuitions:

- The #1 real-world stall is a co-tenant VReplication migration on the same keyspace (an OnlineDDL on a large table), not your own write rate — its copy moves the shared shard-lag metric that gates every app. A write-heavy primary alone rarely trips the default 5s lag throttler on a healthy cluster.

- Upsizing the cluster or vtgate does not clear a replica-lag throttle. The lever is source-side: reduce load, and avoid huge single transactions during bulk-copy and cutover.

### The mid-stream throttle signature

When a throttle engages mid-stream, vtgate strips the in-band throttled flag from the events sluice sees, so the symptom is: heartbeats still flowing, zero change events, and sluice_lag_seconds climbing while sluice_seconds_since_last_event stays low (< 6s). No gRPC error arrives, so the stream stays connected and catches up when the throttle clears. sluice surfaces the symptom as a rate-limited WARN — "alive (heartbeats flowing) but NO change events for Ns" — once per quiet spell. Out-of-band, check SHOW VITESS_THROTTLED_APPS on the primary. The soft window is tunable per-DSN with vstream_idle_warn_timeout (a Go duration; 0 disables the WARN only, not the hard liveness guards).

Corrected finding — a genuinely idle source does NOT fire this WARN on real PlanetScale. vtgate emits periodic idle VGTIDs that re-arm sluice's soft-idle timer, so the WARN is specific to a throttle or a large-transaction stall — not routine quiet. (Older guidance said an idle source produces the same WARN; on a real PlanetScale endpoint it does not.) If you see the WARN, treat it as a throttle/large-tx signal and check the throttled-apps list.

A tablet failover / planned reparent terminates the stream; the streamer's outer loop reconnects from the persisted position — a single brief seconds_since_last_event spike is almost always transient. See the in-repo VStream troubleshooting runbook for the full cause catalogue.

## Storage auto-grow & primary reparent

A non-Metal PlanetScale instance crossing a storage boundary briefly disrupts in-flight writes while the volume grows and a new primary is promoted. sluice rides these windows automatically — no flags required — across cold-copy write, source read, and the post-copy index/constraint phase. You'll see WARN lines naming the transient (Vitess 1105 "not serving" / read-only) and the retry; they're expected and self-clearing. A genuine, non-transient failure still surfaces loudly and promptly.

## Target-health telemetry (optional)

sluice can consume PlanetScale's control-plane metrics (target CPU, memory, storage, replication lag) to back off apply pressure proactively and to fire operator alerts. This reads the PlanetScale metrics API, not the database — it uses a service token that is distinct from the data-plane --target DSN. The opt-in is all-or-nothing: an org without a complete token pair is a loud refusal.

    export PLANETSCALE_METRICS_TOKEN_ID=...   # granted read_metrics_endpoints
    export PLANETSCALE_METRICS_TOKEN=...
    sluice sync start \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver postgres    --target "$SLUICE_TARGET" \
        --planetscale-org acme \
        --planetscale-metrics-db app \
        --notify-storage-util 0.85 --notify-cpu-util 0.90 \
        --notify-slack "$SLACK_WEBHOOK"

When telemetry is on, sluice's /metrics export gains the sluice_target_* gauge family (CPU/mem/storage/lag), and the live signals clamp the startup apply-lane count and damp the AIMD high-water under pressure. The token id and secret should always come from the environment, never the command line.

### Watching a database without a sync

To watch a PlanetScale database's health for dashboards or alert-only operation — with no sync attached and no database connection opened — use metrics-watch. It polls only the control-plane endpoint, fires the same --notify-* alerts, and with --metrics-listen ADDR becomes a standalone PlanetScale-metrics Prometheus exporter:

    sluice metrics-watch \
        --engine planetscale --planetscale-org acme --planetscale-metrics-db app \
        --notify-storage-util 0.85 --notify-slack "$SLACK_WEBHOOK" --quiet

It supports --once (single sample, for scripts) and --interval (default 60s, the PlanetScale metrics granularity).

## PlanetScale-Postgres as a target

PlanetScale-Postgres (PS-PG) is not Vitess-fronted for sluice's purposes — the vanilla postgres engine handles it cleanly, and its endpoints (*.pg.psdb.cloud) don't carry _vt_* shadow tables. One operational note: the tables sluice creates are owned by whichever role connects, and PlanetScale's non-superuser API role (pscale_api_*) will own them if you connect as it. If you want the tables owned by the Default postgres role, connect as that role. For CDC into PS-PG, ensure wal_level=logical and the connecting role has the REPLICATION attribute.

## Next steps

- Operate a sync fleet — dashboards, alerting, and lag observability across many streams.

- sync start reference — every flag named here, with defaults.

- Zero-downtime migration — the snapshot→CDC cutover flow this guide's flags feed.

---
Canonical page: https://sluicesync.com/docs/planetscale-vitess/ · Full docs index: https://sluicesync.com/llms.txt
