# A live analytics replica on PlanetScale Postgres

> Analytics queries on a streaming replica get canceled after ~30 seconds of recovery conflict. Stand up a second PlanetScale Postgres database and let sluice keep it continuously synced — its primary never cancels a query for recovery, so analytics can run for minutes or hours.

If you run long analytical queries against a PlanetScale Postgres replica while the primary is busy, you will eventually meet this:

    ERROR:  canceling statement due to conflict with recovery
    DETAIL:  User query might have needed to see row versions that must be removed.

That is not a bug and not load — it is how a streaming replica works, bounded by a setting PlanetScale currently pins at 30 seconds and operators cannot raise. This guide covers the pattern that sidesteps it entirely: a second PlanetScale Postgres database that sluice maintains as a continuously-synced live copy, where analytics run against a primary — and a primary never cancels a query for recovery conflicts, because there is no recovery. It's a standing sync with no cutover, built on the same connection recipe as the PlanetScale Postgres guide.

## Why the replica cancels your query

A streaming replica has one non-negotiable job: keep applying the primary's WAL. A long-running query on the replica holds a snapshot; when incoming WAL needs to invalidate something that snapshot still depends on — most commonly vacuum cleanup of row versions your query can still see, sometimes a conflicting lock — the replica has two choices: pause replay (and fall behind) or kill your query. max_standby_streaming_delay is the bounded grace period between those choices: replay waits at most that long behind a conflicting query, then cancels it.

On self-managed Postgres you'd raise that setting (accepting replica lag) or turn on hot_standby_feedback (accepting primary-side bloat). On PlanetScale Postgres these are managed — max_standby_streaming_delay is pinned at 30 seconds:

    -- on a connection to one of the SOURCE database's replicas
    SHOW max_standby_streaming_delay;
     max_standby_streaming_delay
    -----------------------------
     30s
    (1 row)

    SHOW hot_standby_feedback;
     hot_standby_feedback
    ----------------------
     off
    (1 row)

    SET max_standby_streaming_delay = '10min';
    ERROR:  parameter "max_standby_streaming_delay" cannot be changed now

Pinned at exactly 30s, not session-settable (it's a server-level parameter PlanetScale doesn't expose), and with hot_standby_feedback off, vacuum-cleanup conflicts are live. The practical consequence: the cancellation is not a flat 30-second query timeout — it fires once a conflict has been pending for 30 seconds — but under steady write churn on the primary, conflicts arise continuously, so any analytics query that needs longer than roughly the grace window is effectively un-runnable on the replica. The reproduction in Act 1 below shows exactly this.

## The pattern: a second database, synced by sluice

Provision a second PlanetScale Postgres database and run a standing sluice sync from the production database into it. Point every dashboard, BI tool, and ad-hoc analyst at the second database's primary:

- No recovery, no cancellation. sluice applies changes as ordinary transactions — the analytics database is a normal primary doing normal MVCC. A query can run for minutes or hours; concurrent applies just create row versions the query's snapshot ignores, exactly as on any busy primary. The only interplay is ordinary lock/IO contention (see the caveats for the one real case, forwarded DDL).

- Hard resource isolation. Heavy analytics burn the second database's CPU, memory, and IO — the production primary and its replicas never feel them.

- Your own index set. The target is real writable Postgres, so analytics-only indexes (or materialized views) can live there without existing on — or ever being pushed to — production. This dovetails with an honest limitation of schema forwarding noted in the caveats: source CREATE INDEX doesn't propagate from a Postgres source anyway, so the target's index set is yours to design either way.

The honest tradeoffs — seconds-level logical lag instead of a physical replica's sub-second, and a second database on the bill — are covered in caveats, with the lag measured, not hand-waved.

## Provision & connect

Create the analytics database with the Postgres engine, same as the main guide. It serves reads only, so --replicas 0 (a single node) is a reasonable start — you're building this pattern precisely because this database's queries don't need a replica:

    pscale database create app-analytics --engine postgresql --region <region> --replicas 0 --wait

Connections use Postgres roles — take each side's DSN from the Default postgres role's database_url and keep its sslmode=verify-full (PlanetScale Postgres presents a public Let's Encrypt certificate that sluice's driver validates against your system trust store; full detail in the connection recipe):

    pscale role reset-default app main --force --format json            # -> database_url  (source)
    pscale role reset-default app-analytics main --force --format json  # -> database_url  (target)

    export SLUICE_SOURCE='postgresql://<user>:<pass>@<region>.pg.psdb.cloud:5432/postgres?sslmode=verify-full'
    export SLUICE_TARGET='postgresql://<user>:<pass>@<region>.pg.psdb.cloud:5432/postgres?sslmode=verify-full'

--force is required with --format json — reset-default rotates the role's password, and without the flag it refuses (cannot delete password with the output format "json").

psql needs one DSN addition; sluice needs none. sluice's driver (pgx) validates the verify-full certificate against your system trust store out of the box — use the database_url exactly as PlanetScale emits it. libpq-based tools like psql don't read the system store by default and fail with root certificate file "/root/.postgresql/root.crt" does not exist; for psql, append &sslrootcert=system to the DSN (and make sure CA certificates are installed — the stock postgres Docker image lacks them).

Both ends connect as the Default postgres role. The source needs the REPLICATION attribute to create the logical-replication slot — the custom pscale_api_* roles lack it, and sluice refuses loudly up front if you try — and publication management needs the connecting role to own the source tables. The target wants a durable table owner. Same requirements, same SLUICE-E refusal shapes, as the PlanetScale Postgres sync guide.

## Start the standing sync

One sync start, both ends the plain postgres driver. This is a standing sync — there is no cutover section in this guide, because nothing ever cuts over; the stream simply runs:

    export SLUICE_NOTIFY_WEBHOOK='https://<your-alert-sink>'   # or SLUICE_NOTIFY_SLACK

    sluice sync start --stream-id analytics \
        --source-driver postgres --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --schema-changes forward \
        --notify-sync-lag-seconds 60 \
        --metrics-listen :9101

- --schema-changes forward (the default since v0.99.45, shown explicitly here because it's load-bearing): unambiguous source DDL — column adds, drops, type changes — is applied on the analytics copy automatically, so the replica tracks schema evolution without operator intervention. The conservative alternative is --schema-changes refuse: any source DDL then surfaces loudly and you apply it to the target through your own change process. See Schema changes during a sync — including its honest per-shape matrix, which matters here (caveats).

- --notify-sync-lag-seconds 60 alerts your webhook/Slack sink when sluice's own apply lag (sluice_sync_lag_seconds) reaches a minute. This threshold is ungated — it needs only a sink, no PlanetScale telemetry credentials.

- --metrics-listen :9101 exposes Prometheus gauges (sluice_sync_lag_seconds, sluice_seconds_since_last_apply) plus /readyz, so the replica's freshness lives on your existing dashboards.

Health, from any shell — sync status for the position and phase, sync health as a cron-friendly freshness gate:

    sluice sync status --stream-id analytics \
        --target-driver postgres --target "$SLUICE_TARGET"

    sluice sync health --stream-id analytics \
        --target-driver postgres --target "$SLUICE_TARGET" --max-stale-seconds 60

### Give analysts a read-only role

The analytics database is writable — it's a primary — so make read-only-ness a matter of roles, not hope. On the target, as the Default postgres role:

    CREATE ROLE analyst LOGIN PASSWORD '<generated>';
    GRANT CONNECT ON DATABASE postgres TO analyst;
    GRANT USAGE ON SCHEMA public TO analyst;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO analyst;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO analyst;

The ALTER DEFAULT PRIVILEGES line covers tables sluice creates later (a forwarded CREATE-path or schema add-table): sluice connects as postgres, which is the role the default-privilege rule is attached to, so new tables arrive analyst-readable. Point BI tools at a DSN built from analyst, never at the postgres-role DSN sluice uses.

The pscale-native alternative also works — a custom PlanetScale role can inherit pg_read_all_data directly:

    pscale role create app-analytics main analyst --inherited-roles pg_read_all_data --format json
    # -> returns id, name, username (a pscale_api_* name), password, database_url

Verified live with the returned credential — reads work, writes are refused:

    == SELECT as the read-only role ==
      count
    ---------
     3000000
    (1 row)

    == INSERT as the read-only role (expect refusal) ==
    ERROR:  permission denied for table events

Two differences from the SQL recipe: pg_read_all_data grants read on all schemas and covers future tables automatically (broader than the per-schema grants, and no ALTER DEFAULT PRIVILEGES line needed), and the pscale-created role's username is a pscale_api_* name whose password lives in PlanetScale's console. Keep the SQL recipe when you want a role whose credentials PlanetScale never stores.

## Validation: three acts from a live run

Everything below is from a real run (sluice 0.99.203) against two PlanetScale Postgres databases: the conflict reproduced on the source's replica, sluice syncing through the same churn, and the same query finishing on the analytics primary. The demo table is events(id bigserial PRIMARY KEY, user_id bigint, kind text, amount numeric, at timestamptz), seeded with 3,000,000 rows across ~30,000 user_ids; the analytics query is a self-join aggregate (~300M join pairs) that takes ~52 seconds on an idle primary — comfortably past the 30-second grace window.

### Act 1 — the conflict, reproduced on the source replica

The source database needs replicas for this act — on PlanetScale Postgres that means an HA cluster: --replicas 2 (the allowed shapes are 0 for a single node or 2–8 for HA; asking for 1 is refused with Error: PostgreSQL databases must have 0 replicas for non-HA or between 2 to 8 replicas for HA.). That's the deployment this guide's problem statement assumes — if you had no replica, your analytics were hitting the production primary itself. Terminal one: steady write churn on the source primary — an ordinary UPDATE loop is enough, because it's the resulting vacuum cleanup that conflicts with a standby snapshot:

    -- terminal 1, connected to the source PRIMARY: ~30,000 rows updated every ~2s,
    -- with a VACUUM events; every 10th iteration (n cycling 0-99)
    UPDATE events SET amount = amount + 0.01 WHERE id % 100 = <n>;

Terminal two connects to a source replica. Reaching the replica is a credential detail, not a separate endpoint: append |replica to the credential username — same host, same port 5432; in URI-form DSNs the pipe must be URL-encoded as %7C (postgresql://<user>%7Creplica:<pass>@...). The dashboard also offers a "Connect → Replica" credential type; the username suffix on the existing default-role credential is the scriptable path. Proof the suffix lands on a standby:

    == PRIMARY (plain username) ==
     pg_is_in_recovery
    -------------------
     f
    (1 row)

    == REPLICA (|replica suffix) ==
     pg_is_in_recovery
    -------------------
     t
    (1 row)

Now the >30-second analytics query on that replica, with \timing on:

    -- terminal 2, connected to a source REPLICA (|replica credential)
    \timing on
    SELECT a.kind, count(*) AS pairs, sum(a.amount) AS amount_sum
    FROM events a JOIN events b ON a.user_id = b.user_id
    GROUP BY 1 ORDER BY 1;

First attempt, no retries, no tuning:

    Timing is on.
    ERROR:  canceling statement due to conflict with recovery
    DETAIL:  User query might have needed to see row versions that must be removed.
    Time: 30269.430 ms (00:30.269)

Killed at 30.269 seconds — the 30-second max_standby_streaming_delay almost to the millisecond, because under this churn a conflicting vacuum-cleanup record arrives essentially immediately, so the grace clock starts at query start. The DETAIL line names the mechanism: vacuum cleanup of row versions the query's snapshot still needed.

### Act 2 — sluice syncing continuously through the churn

The same churn is running; the standing sync just applies it. The sync was started while the UPDATE loop hammered the source — the 3,000,000-row snapshot copied in ~19 seconds, then handed off to CDC (the log had zero WARN/ERROR lines end to end):

    time=2026-07-09T00:23:01.855-07:00 level=INFO msg="cold start; snapshot captured"
    time=2026-07-09T00:23:07.786-07:00 level=INFO msg="sync cold-start: fast parallel copy engaged (ADR-0079)" table_parallelism=1 within_table_parallelism=8 index_build_budget=0 raw_copy_eligible=true raw_copy_reason=""
    time=2026-07-09T00:23:07.929-07:00 level=INFO msg="migration: phase complete" phase=tables
    time=2026-07-09T00:23:26.269-07:00 level=INFO msg="migration: phase complete" phase=bulk_copy
    time=2026-07-09T00:23:26.269-07:00 level=INFO msg="migration: phase complete" phase=indexes
    time=2026-07-09T00:23:26.622-07:00 level=INFO msg="migration: phase complete" phase=constraints
    time=2026-07-09T00:23:26.692-07:00 level=INFO msg="bulk-copy complete; entering CDC mode"
    time=2026-07-09T00:23:28.991-07:00 level=INFO msg="laneapply: concurrent key-hash CDC apply engaged — routing row changes to W in-order lanes by primary-key hash, committing each lane concurrently on a dedicated pool; the resume position advances only to a source-tx boundary durable across all lanes (ADR-0104)" lanes_W=4 dedicated_backends=4

sync status, two samples ~20 seconds apart while the churn ran — the LSN advancing, updated seconds ago:

    STREAM     UPDATED               AGE     POSITION
    analytics  2026-07-09T07:23:52Z  4s ago  {"slot":"sluice_slot","lsn":"0/45A35E68","systemid":"766042…

    STREAM     UPDATED               AGE     POSITION
    analytics  2026-07-09T07:24:10Z  1s ago  {"slot":"sluice_slot","lsn":"0/46EDEE38","systemid":"766042…

And the lag evidence from the same window — a :9101/metrics sample ~45 seconds after CDC entry, plus sync health exiting 0:

    sluice_seconds_since_last_apply{stream_id="analytics"} 2
    sluice_sync_lag_seconds{stream_id="analytics"} 48.6099

    $ sluice sync health --stream-id analytics --target-driver postgres --target "$SLUICE_TARGET" --max-stale-seconds 60
    stream: analytics
    found: true
    state: healthy
    position: {"slot":"sluice_slot","lsn":"0/46EDEE38","systemid":"766042…
    updated_at: 2026-07-09T07:24:10Z
    seconds_since_last_apply: 3
    health-exit:0

The 48.6-second sluice_sync_lag_seconds right after CDC entry is the initial catch-up: the churn generated WAL throughout the snapshot copy, and CDC starts from the pre-copy slot position, so the first apply batches carry old commit timestamps. seconds_since_last_apply at 2–3 seconds shows apply actively flowing. Under this run's deliberately saturating churn (~15k row-changes/s, above the target's apply throughput), lag kept growing while the storm ran and drained to zero once it stopped — the honest numbers are in the caveats.

### Act 3 — the same query, on the analytics primary

Same query text, same concurrent churn (still flowing into the target via sluice), but run on the analytics database's primary. It runs to completion — there is no recovery to conflict with:

    Timing is on.
       kind   |   pairs   |  amount_sum
    ----------+-----------+---------------
     click    | 101003844 | 5046964144.54
     purchase | 101044120 | 5053641381.01
     refund   |  50467932 | 2524808050.13
     view     |  50435816 | 2523459562.89
    (4 rows)

    Time: 54789.578 ms (00:54.790)

54.8 seconds — comfortably past the 30-second guillotine that killed the identical query on the replica. The pair counts match the source exactly; the amount_sum values are higher than a pre-churn baseline because the churn's amount = amount + 0.01 increments had already been applied to the target — the copy is genuinely live, not a stale snapshot.

And the freshness claim, proven rather than asserted — a marker row inserted on the source while that query was running (07:26:06Z, churn still active) arrived on the target intact, with its source-assigned id and timestamp, without disturbing the running query:

    -- on the SOURCE primary, mid-query (07:26:06Z)
       id    |          kind           |              at
    ---------+-------------------------+-------------------------------
     3000001 | marker-20260709T072606Z | 2026-07-09 07:26:07.623209+00
    (1 row)
    INSERT 0 1

    -- poll loop on the TARGET
    arrived 07:33:09Z: 3000001|marker-20260709T072606Z|2026-07-09 07:26:07.623209+00

An honest number: the marker took ~7 minutes to land — not seconds — because it was queued, in commit order, behind the write-storm backlog (the churn's ~15k row-changes/s kept saturating the apply path until it was stopped; see the caveats). Nothing was lost and nothing reordered; once the storm stopped, the backlog drained, sluice_sync_lag_seconds collapsed to 0.0000, and row counts matched exactly (source 3000001, target 3000001). Final health from that window:

    $ sluice sync health --stream-id analytics --target-driver postgres --target "$SLUICE_TARGET" --max-stale-seconds 120
    stream: analytics
    found: true
    state: healthy
    position: {"slot":"sluice_slot","lsn":"0/8C039040","systemid":"766042…
    updated_at: 2026-07-09T07:39:58Z
    seconds_since_last_apply: 49
    health-exit:0

(--max-stale-seconds 120 on the final check because the source was by then idle apart from sluice's 1-minute stream heartbeats.)

## Caveats, honestly

- Lag is logical and seconds-level, not sub-second — and a sustained write storm can outrun it. A physical streaming replica applies WAL microseconds-to-milliseconds behind the primary; sluice is logical replication — decode, translate, apply as transactions — and its steady-state lag under ordinary write rates is measured in seconds. The honest boundary, measured in the live run: a write rate sustained above the target's apply throughput grows lag for as long as it's sustained — the run's synthetic churn generated ~15k row-changes/s against ~4–5k/s of apply into a default-size PlanetScale target, and lag climbed 48.6 → 208 seconds over ~3 minutes — in order, nothing lost, zero errors, and the backlog drained to zero once the burst ended. Size the target for the write workload (or accept lag during sustained-heavy periods); the seconds-level claim holds for ordinary rates. Don't guess: watch sluice_sync_lag_seconds on --metrics-listen, gate on sync health --max-stale-seconds, and alert with --notify-sync-lag-seconds. For dashboards and ad-hoc analytics, data-as-of-a-few-seconds-ago is almost always fine; this pattern is not a read-your-writes replica.

- It's a second database, and it costs second-database money. You're trading a bill line for query survivability and resource isolation. Size it primarily for the analytics workload — the apply stream is usually far lighter than the queries will be — but a source that sustains heavy write rates needs apply-throughput headroom on the target too (the lag caveat above).

- The target is writable — enforce read-only by role, not convention. Use the analyst role above and never hand out the postgres-role DSN. A stray write to a synced table can collide with sluice's apply (a loud apply error, not silent corruption — but an operational headache). Analytics-only additions — extra indexes, materialized views, scratch schemas — are fine, but they live outside sluice's contract: a destructive recovery (--reset-target-data) drops the synced tables, and re-creating anything you hung off them is on you.

- Very long analytics transactions can delay sluice's apply — gently. Plain row apply (INSERT/UPDATE/DELETE) is ordinary MVCC: readers don't block writers in Postgres, so your six-hour query and the apply stream coexist. The one real interaction is a forwarded DDL: an ALTER TABLE needs an exclusive lock, queues behind your long query, and briefly queues new queries behind itself — apply lag rises, your lag alert fires, and everything resumes when the query finishes. Apply waits; queries don't die. That's the whole point of the pattern — compare it with the replica's 30-second guillotine. (A days-long idle-in-transaction session also holds back vacuum on the analytics database itself; don't park transactions open there any more than you would on any primary.)

- Sequences and identity counters are not continuously synced. CDC replicates row changes, not catalog-level sequence positions — irrelevant for a read-only analytics copy, since queries read rows, not nextval(). It only matters if you ever promote this copy to take writes; that's what sluice cutover's sequence priming (--sequence-margin) is for.

- Schema forwarding from a Postgres source has an honest per-shape matrix. Column adds, drops, and type changes forward; CREATE INDEX, CHECK, and nullability changes never signal on pgoutput's wire from a Postgres source, so they cannot forward — see the ground-truth table. For this pattern that's mostly a feature (the target's index set is yours to design for analytics), but if you want a source index mirrored, create it on the target yourself.

- The standing sync holds a replication slot on your production source — forever. That's the deal with logical replication: if the sync stops for a long time, the slot pins WAL on the source and its storage grows. sluice emits severity-graded slot-retention warnings ahead of trouble, but decommissioning this pattern means sync stop --wait plus sluice slot drop — a slot is never auto-dropped. See Prepare a Postgres source for the slot-lifecycle story.

## Next steps

- Migrate & sync PlanetScale Postgres — the connection recipe (roles, sslmode, ownership) this guide builds on.

- Schema changes during a sync — the full forward / refuse semantics and the per-shape forwarding matrix.

- Operate a sync fleet — run this stream (and its siblings) under one supervised process, with the dashboard and the full alert-threshold set.

- Prepare a Postgres source — replication-slot lifecycle, retention warnings, and failover for the native CDC engine.

- sync start reference — every flag named here, with defaults.

---
Canonical page: https://sluicesync.com/docs/planetscale-postgres-analytics-replica/ · Full docs index: https://sluicesync.com/llms.txt
