<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
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

Columns in a non-UTF-8 character set (v0.156.3). vttablet's VStream row event carries a latin1, cp1251, sjis, … column's stored bytes, and sluice now converts them by the field's collation, in the COPY phase and in CDC. Three VStream-specific edges: a non-ASCII value in a gbk, big5, tis620 or gb18030 column refuses with CHARSET-NOT-DECODABLE (vttablet sends those with collation 0); a _bin-collated text column arrives typed VARBINARY/BLOB/BINARY and is decoded as text; and vttablet reports a replayed row's current collation, so a replay across a charset change is decoded by the new charset — a detected replay across a change into a non-UTF-8 charset refuses, but an online schema change (a deploy request, Vitess online DDL) swaps in a shadow table and is not seen. See non-UTF-8 character sets. These arms were measured on vttestserver, not against PlanetScale.

## Warm-resume & auto-resnapshot

On restart, sluice resumes from the persisted VGTID position once the target proves the copy finished (below). PlanetScale's binlog-retention window is finite, so a resume from a position older than the source's retained binlogs is routine — and by default (ADR-0093, parity with the self-hosted binlog path) sluice auto-recovers with a fresh cold-start re-snapshot rather than failing. On an idempotent VStream source the upsert copy absorbs the overlap and the target is not dropped.

When a full re-snapshot is expensive (very large tables) and you'd rather decide deliberately, pass --no-auto-resnapshot. sluice then fails loudly with an actionable error naming the recovery commands (--restart-from-scratch / --reset-target-data) instead of re-copying. It gates both the pre-flight fall-through and the reactive VStream recovery.

A cold start stopped during its copy is re-copied, never resumed (since v0.163.3, VSTREAM-COPY-RESUME-WITHDRAWN). Before v0.163.3 sluice saved the copy's position as it ran and continued from it on the next start, but a continued copy could not make the target match the source: Vitess copies the already-finished tables again rather than replaying their changes, and that second copy only adds and overwrites rows, so any row the source deleted while the stream was stopped stayed on the target, as did every old row of a table dropped and re-created under its name (measured on Vitess 24: 6,701 rows on the target against 701 on the source after a re-create; VSTREAM-COPY-RESUME-RECREATED-TABLE, HIGH, silent). Since v0.163.3 no position is saved until the copy finishes, so a stop or kill during the copy ends in a refusal:

- a stream's first cold start leaves no position, so its re-run finds the copied rows and refuses with SLUICE-E-COLDSTART-TARGET-NOT-EMPTY;

- a re-copy of an existing stream (--restart-from-scratch, or the automatic re-snapshot above) keeps its old position under the in-progress mark, and its re-run refuses COLD-START-INCOMPLETE;

- a mid-copy position saved by an earlier release is refused under VSTREAM-COPY-RESUME-WITHDRAWN when it carries a copy cursor, and under VSTREAM-COPY-COMPLETION-UNPROVEN when it does not (v0.163.4).

The remedy for all three is the same command with --restart-from-scratch, which clears the in-scope target tables and copies them again; with --schema-already-applied it cannot clear them (they are yours), so it refuses while they hold rows (RESTART-FROM-SCRATCH-TARGET-NOT-CLEARED): empty them, then re-run. Do not use --force-cold-start here: it copies by upsert over the rows already there and keeps the deleted ones. A stream that has reached CDC resumes from its saved position as it always has. A transient fault during the copy no longer continues it in place either (since v0.163.6; below). These measurements were on a local Vitess 24 cluster, not on PlanetScale itself.

A transient fault during the copy restarts the cold start (since v0.163.6, VSTREAM-COPY-RECONNECT-STALE-ROWS). From v0.99.5 through v0.163.5, a retriable error mid-copy (a dropped vtgate connection, a reparent) re-opened the VStream in place from the position the copy had reached. Vitess then replays the source's changes since the old snapshot as row events inside the copy phase, and sluice's copy keeps only after-images, so every DELETE in the reconnect window was dropped while updates landed, at exit 0 (measured through a fault proxy: 20 of 20 window deletes stale in every run of every affected cell; who needs to check). The in-place reconnect is removed. A fault now ends the copy and the stream's outer retry takes it:

- a stream's first cold start finds no position, clears the in-scope target tables and copies them again from a new snapshot;

- a re-copy of a stream that already reached CDC refuses COLD-START-INCOMPLETE, and the remedy is the same command with --restart-from-scratch;

- where the tables cannot be cleared the retry refuses: under --schema-already-applied with RESTART-FROM-SCRATCH-TARGET-NOT-CLEARED, worded as "a fault during the copy made this run restart the copy" (empty the in-scope target tables and run the same command again), and under --inject-shard-column the shard preflight refuses until this shard's rows are deleted. Before v0.163.6, a first cold start under --schema-already-applied whose copy faulted while the target's position read also failed re-copied by upsert over the interrupted copy, keeping the source's deletes in between, at exit 0; it now requires every in-scope target table to be empty and refuses otherwise (SAA-COLD-COPY-RETRY-UNCLEARED).

What it costs. Each mid-copy fault costs a full re-copy of the in-scope tables, where before it cost a few seconds of reconnect. During a first cold copy the retry budget never refills, so after --apply-retry-attempts faults (8 by default, counted over the whole copy) the run exits with apply retry budget exhausted and the last fault in the message. When each restarted copy reaches vtgate and fails later, mid-read, at the default backoff (100 ms doubling) a vtgate outage longer than about 13 seconds uses all 8, and so do 8 separate blips over one long copy; a PlanetScale reparent that keeps vtgate unavailable for longer than the budget covers ends a first cold start. When vtgate refuses or drops connections outright, the budget does not apply (Bug 330, correcting v0.163.6's notes): the restarted copy's stream open fails with an error not counted as retriable, so a first cold copy exits after one retry with open snapshot stream: … rpc error: code = Unavailable, whatever --apply-retry-attempts says (measured: a 3-second refused outage ended the run with --apply-retry-attempts=30). No row is lost, and a fix that counts a failed open against the budget is planned. Either way the interrupted copy stays on the target, so a plain re-run refuses SLUICE-E-COLDSTART-TARGET-NOT-EMPTY. The remedy is the same command with --restart-from-scratch; a higher --apply-retry-attempts rides out more mid-read faults only. Under --schema-already-applied, empty the in-scope tables first: that flag is your statement that they are empty, so a new process cannot know they hold a partial copy. schema add-table and backup full read through the same copy and now fail on a mid-copy fault instead of continuing in place: a failed schema add-table leaves its pending record, which refuses the next warm resume, and its re-run refuses the populated table, so empty it and run the command again; a failed backup full fails, so run it again. A stream that has reached CDC is unchanged, because its change stream has its own reconnect, which is not a copy reconnect. migrate never used this copy and is unaffected. These measurements were on a local vttestserver cluster, not on PlanetScale itself.

Fixed in v0.163.7: two silent defects in the PlanetScale/Vitess copy, one defect reached two ways (HIGH, silent).

- vstream_copy_single_stream=true is refused for more than one table (VSTREAM-SINGLE-STREAM-CATCHUP-DELETE-DROPPED; marker VSTREAM-SINGLE-STREAM-MULTI-TABLE). sluice copies each table in its own VStream, one table at a time (ADR-0095); the parameter used to switch that off and copy every table in one stream. One VStream copying several tables does not stay at one snapshot: before each table after the first, Vitess catches up the tables it has already copied by replaying every change made since, inside the copy, and sluice's copy kept only the inserted and updated rows of that replay, so a row deleted on the source from a table already copied, while a later table was still copying, stayed on the target at exit 0 (measured on a local vttestserver with no fault: 60 of 60 such deletes stayed; the default per-table copy was exact). With more than one table in the copy scope (after --include-table, --exclude-table and the default exclusions) the parameter is now refused, as a codeless exit 1, before anything is written: sync start (a first cold start, --restart-from-scratch, --reset-target-data, and the automatic re-snapshot) refuses after reading the source schema and before it writes to any in-scope table, clears the stream's apply marks or saves a position, so an established stream refused this way keeps its target and position and can be warm-resumed as it was. A cold-start sync start --dry-run refuses the same scope, and backup full refuses before its snapshot opens rather than falling back to its non-snapshot copy. A sync run leg that hits it is not restarted: edit the leg's source DSN, then reload. Remedy: remove the parameter from the source DSN. A one-table scope keeps it and copies exactly as before.

- --slot-name on a PlanetScale/Vitess source no longer widens the copy to the whole keyspace (VSTREAM-SLOT-NAME-UNSCOPED-COPY). VStream has no replication slot, so the flag was documented as ignored, but a cold start given it skipped the per-table dispatch and opened one VStream over the whole keyspace: every table was streamed regardless of --include-table, the --where filter was not applied to the copy (rows outside it landed on the target), and the catch-up above dropped deletes made during the copy (measured on a local vttestserver: 100 rows outside a --where on each of two tables, 20 of 20 deletes on the first table kept). On planetscale and vitess the flag now changes nothing: the copy stays scoped to --include-table and filtered by --where. Affected: v0.99.12 through v0.163.6 (the --where part since v0.99.278), including a fleet leg's slot-name key.

If either applied to a cold start or backup full on an earlier release (for the parameter, v0.99.63 through v0.163.6, and every multi-table PlanetScale/Vitess cold start before v0.99.63, which copied in one stream by default; not measured), the target or backup may hold rows the source deleted during the copy, or rows outside the --where. To check a stream: let it catch up, pause writes on the source, and run sluice verify --depth count against the same source and target, passing the stream's own --where values (without them every filtered table reports a mismatch by design). A table with more rows on the target than on the source kept rows it should not have. To repair, re-run the same sync start without the parameter or flag, with --restart-from-scratch; under --schema-already-applied it refuses while the tables hold rows (RESTART-FROM-SCRATCH-TARGET-NOT-CLEARED), so empty them yourself (for example with TRUNCATE), then re-run. Re-take a backup taken with the parameter. Still open at v0.163.7: schema add-table from a PlanetScale/Vitess source still opens a keyspace-wide copy, which may meet the same catch-up drop (VSTREAM-ADD-TABLE-KEYSPACE-WIDE-COPY). Measured since, in v0.163.8 (details): with --no-drain the add left 80 deleted rows and 10 updated rows stale on a MySQL 8.0 target, so --no-drain from a PlanetScale/Vitess source is now refused (NO-DRAIN-VSTREAM-SOURCE); the drained add was exact when the stream was really stopped. What remains is loud: the drained add still reads the whole keyspace (40.3 MB beside a 150,000-row unrelated table), and beside an 80 MB unrelated table it refuses at the 64 MiB snapshot buffer (schema add-table has no --max-buffer-bytes). These measurements were on a local vttestserver, not on PlanetScale itself.

Fixed in v0.163.8: schema add-table --no-drain from a PlanetScale or Vitess source is refused (NO-DRAIN-VSTREAM-SOURCE, HIGH, silent). Into a MySQL-family target it took the binlog filter-flip path, and its keyspace-wide add-table copy left rows the source deleted or changed during the add on the target at exit 0 (measured on a local vttestserver into MySQL 8.0: 80 deleted rows kept and 10 rows at their old values). Use the drained workflow and keep the stream stopped until add-table returns — add-table does not yet detect a running stream (DRAINED-ADD-TABLE-RUNNING-STREAM-UNCHECKED, open). Affected ranges, the check and the re-copy remedy: schema changes.

Fixed in v0.163.9: a multi-shard cold start or backup full kept rows the source deleted on a shard that finished copying first (Bug 331, CRITICAL, silent, VSTREAM-SHARD-SKEW-COPY-CHANGES-DROPPED; sync since v0.2.0, backup full since v0.44.0, by the code). Each table's copy spans every shard, and shards finish at different times. Vitess streams a finished shard's changes at once, inside the copy, and sluice's copy kept only their after images, so deletes were dropped and a key change left its old row; the table's resume position was already past them, so the change stream never replayed them. That was the default copy, with no flag and no fault, in the per-table, one-table and concurrent copies alike (measured by the v0.163.7 regression cycle: 52 of 52 deletes on the early shard kept at exit 0; a backup full's restore failed with SQLSTATE 23505). Now a finished shard's changes are held and its position rewound to where it finished copying, so the change stream (or the backup's incremental) replays them with both row images; the run logs shard finished its copy before the stream did; its later changes are replayed from its copy position once per such shard. A one-shard keyspace was not affected by this mechanism.
VSTREAM-COPY-ROW-CHANGE-REFUSED (new, loud, retriable). When vtgate restarts a shard's stream mid-copy after a retriable tablet error (a reparent, a vttablet restart, PlanetScale maintenance), vttablet replays the table's changes since the shard's snapshot inside the copy; through v0.163.8 sluice dropped the replayed deletes (VSTREAM-VTGATE-SHARD-RETRY-CATCHUP-DELETES, derived from the Vitess code, not reproduced). Now such a DELETE, a key-changing UPDATE, a change with no image, or a partial after image (a self-hosted Vitess on binlog_row_image=NOBLOB or PARTIAL_JSON) refuses its table, and the refusal takes the same route as a fault during the copy: a first cold start clears and re-copies in process, a re-copy of an established stream refuses COLD-START-INCOMPLETE (remedy --restart-from-scratch), --schema-already-applied refuses RESTART-FROM-SCRATCH-TARGET-NOT-CLEARED, and backup full fails and can be re-run. A drained schema add-table does not refuse: it leaves those changes to the stopped stream, which replays them when restarted, and counts them in an INFO line; that relies on the stream really being stopped, which nothing checks yet (DRAINED-ADD-TABLE-RUNNING-STREAM-UNCHECKED, open).

Who needs to act: anyone who cold-started a stream (v0.2.0 through v0.163.8) or took a backup full (v0.44.0 through v0.163.8) from a multi-shard keyspace while it took deletes or key changes. Let the stream catch up, pause writes, and run sluice verify --depth count with the stream's --where values: more rows on the target than on the source means kept rows (a matching count is evidence, not proof). Re-copy with --restart-from-scratch, and re-take affected backups: a restore that failed on 23505 is this defect, but one that restores fine can still hold deleted rows. Full detail, caveats and the measured remedy: schema changes.

A warm resume needs proof that the copy finished (since v0.163.4, VSTREAM-COPY-COMPLETION-UNPROVEN, Bug 327). A cold start stopped mid-copy by v0.163.1 or earlier often saved only the copy's first checkpoint, which carries no copy cursor and looks exactly like a finished copy's CDC anchor; v0.163.2 and v0.163.3 warm-resumed from it, logged only INCLUDE-TABLE-SCOPE-UNRECORDED, and never copied the rest (measured on v0.163.3: 40,000 to 49,000 of 300,000 rows missing, exit 0). So every warm resume from a planetscale or vitess source now asks the target for proof, before the change stream opens. The stream's established-tables record (written with the CDC anchor, after the copy, since v0.163.0) is proof on its own. The cold-start progress header (sync-<stream-id> in sluice_migrate_state, since v0.149.0) at complete counts only with target evidence: every table it records as copied still holds rows on the target (or is empty on the source too), and, on a Postgres target whose session is on UTC all year, the stream's position row was written after the header; on a MySQL-family target the header alone never proves the copy. A pass records the established tables, so later starts pass on the record. Anything it cannot read refuses rather than passes, and the refusal has applied no change. There are two remedies: the safe one is the same command with --restart-from-scratch, which clears the in-scope target tables and copies them again; the other is --assert-copy-finished, once, followed by a check that is mandatory: let the stream catch up, pause writes on the source, and run sluice verify --depth count against the same source and target (--depth sample refuses a PlanetScale/Vitess source), then re-copy with --restart-from-scratch any table it reports short. The flag records the tables at once, and from then on nothing refuses the stream again (measured: a copy 150,500 rows short passed every later start until verify reported t2_big MISMATCH source=299500 target=149000; complete copies reported OK). Row counts compared while the stream is stopped cannot replace that check: the stream has applied none of the source's writes since it stopped, so they differ even for a finished copy (measured: 4,992 on the target against 4,989 on the source for a complete one). That the stream has been streaming changes is no evidence either. The flag is refused when the target contradicts it. Expect a one-time refusal on some healthy streams too: one last cold-started on v0.148.x or earlier, or on v0.149.0 through v0.162.x into a MySQL-family target or a Postgres target not on UTC all year, or one handed off from a backup chain with --position-from-manifest on v0.163.3 or earlier (no record, no progress row). Correction (Bug 328): this section first said to compare row counts before passing the flag; that advice is withdrawn, and v0.163.5 corrects the flag's help and the refusal's message. MySQL binlog, Postgres, SQLite/D1 and trigger-CDC sources are unaffected. A sync run leg refused this way is not restarted; take it out of the fleet and run sluice sync start once (procedure).

## The throttler & lag reality

Some VStream delays you act on; some you wait out. The measured findings reset a few intuitions:

- The #1 real-world stall is a co-tenant VReplication migration on the same keyspace (an OnlineDDL on a large table), not your own write rate — its copy moves the shared shard-lag metric that gates every app. A write-heavy primary alone rarely trips the default 5s lag throttler on a healthy cluster.

- Upsizing the cluster or vtgate does not clear a replica-lag throttle. The lever is source-side: reduce load, and avoid huge single transactions during bulk-copy and cutover.

### The mid-stream throttle signature

When a throttle engages mid-stream, vtgate strips the in-band throttled flag from the events sluice sees, so the symptom is: heartbeats still flowing, zero change events, and sluice_lag_seconds climbing while sluice_seconds_since_last_event stays low (< 6s). No gRPC error arrives, so the stream stays connected and catches up when the throttle clears. sluice surfaces the symptom as a rate-limited WARN — "alive (heartbeats flowing) but NO change events for Ns" — once per quiet spell. Out-of-band, check SHOW VITESS_THROTTLED_APPS on the primary. The soft window is tunable per-DSN with vstream_idle_warn_timeout (a Go duration; 0 disables the WARN only, not the hard liveness guards).

Corrected finding — a genuinely idle source does NOT fire this WARN on real PlanetScale. vtgate emits periodic idle VGTIDs that re-arm sluice's soft-idle timer, so the WARN is specific to a throttle or a large-transaction stall — not routine quiet. (Older guidance said an idle source produces the same WARN; on a real PlanetScale endpoint it does not.) If you see the WARN, treat it as a throttle/large-tx signal and check the throttled-apps list.

Once the stream has reached CDC, a tablet failover / planned reparent terminates the stream; the streamer's outer loop reconnects from the persisted position — a single brief seconds_since_last_event spike is almost always transient. A reparent during the cold-start copy instead restarts the copy (since v0.163.6; what that costs). See the in-repo VStream troubleshooting runbook for the full cause catalogue.

## Storage auto-grow & primary reparent

A non-Metal PlanetScale instance crossing a storage boundary briefly disrupts in-flight writes while the volume grows and a new primary is promoted. sluice rides these windows automatically — no flags required — across cold-copy write, source read, and the post-copy index/constraint phase. You'll see WARN lines naming the transient (Vitess 1105 "not serving" / read-only) and the retry; they're expected and self-clearing. A genuine, non-transient failure still surfaces loudly and promptly. The one exception is a PlanetScale/Vitess source still in its cold-start copy: since v0.163.6 a fault on the VStream copy read restarts the copy rather than riding through, and enough of them end a first cold start (details).

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
