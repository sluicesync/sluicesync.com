# Move a PlanetScale database between regions

> PlanetScale has no native region move — create the database in the new region and let sluice copy it across, with zero downtime or in one shot.

A PlanetScale database is pinned to its region at creation, and there is no native, in-place region move. The path is the same in spirit for every setup — create a new database in the target region and let sluice copy the data across (both ends are MySQL→MySQL, so no cross-engine type translation is involved) — but the exact shape depends on how your data is laid out. This guide covers three cases: Case 1 — a single unsharded database (the common one), Case 2 — several unsharded databases, and Case 3 — a sharded keyspace. Read Before you start and Provision the target first — they apply to all three — then jump to the case that matches your setup.

## Before you start & gotchas

- Foreign keys — enable them on the target first. PlanetScale does not accept FOREIGN KEY DDL by default (Vitess rejects it with VT10001). If your schema uses foreign keys, turn on "Allow foreign key constraints" in the target database's Settings → General tab before you migrate — with no open deploy requests — so sluice's foreign-key DDL is accepted and the constraints are preserved (how to enable them). It is supported on unsharded databases only, cyclic foreign keys with CASCADE are not supported, and deploy requests do not validate the referential integrity of pre-existing rows. If you would rather not carry the foreign keys at all, dropping them also works — sluice emits each column's covering index as a separate statement, so those are kept. For the skip-vs-enable decision in full — including --skip-foreign-keys, which keeps the columns indexed for you — see Foreign keys on a Vitess / PlanetScale target.

- Sharding. A normal unsharded PlanetScale database (the default) needs no special flag on v0.99.190+; --allow-cross-shard-merge applies only to a genuinely sharded source keyspace — see the note under Provision the target.

- One run per keyspace. A PlanetScale database is a single keyspace, and each sync start / migrate moves one source keyspace to one target. To move several databases, run one per database (each with its own --stream-id and target) or supervise them with a sync fleet config — no single run spans multiple source keyspaces.

- The sync stop --wait drain message. On VStream teardown, sync stop --wait may print a "did not complete drain within …" timeout even though the stream did drain and exit cleanly. Verify the process actually exited rather than treating that message alone as a failure.

- Throughput is target-tier-CPU-bound. The bulk copy is limited by the target cluster's CPU; scale the tier for a faster copy.

## Provision the target & connect

Create the destination database in the new region, sized to match (or exceed) the source. A PS-10 branch takes roughly 7–8 minutes to reach READY:

    pscale database create app-sa --region aws-sa-east-1 --cluster-size PS-10

Both the source and the target reach PlanetScale through the same global connect host, aws.connect.psdb.cloud:3306 — PlanetScale routes to the right region by credential, not by hostname. The connection strings are standard go-sql-driver MySQL DSNs, and ?tls=true is required on both:

    # source (CDC read) — export as SLUICE_SOURCE
    USERNAME:PASSWORD@tcp(aws.connect.psdb.cloud:3306)/app-us?tls=true

    # target (write) — export as SLUICE_TARGET
    USERNAME:PASSWORD@tcp(aws.connect.psdb.cloud:3306)/app-sa?tls=true

USERNAME is the generated username field returned by pscale password create <db> <branch> <label> — not the label you pass on the command line — and PASSWORD is its plain_text value. Prefer environment variables (SLUICE_SOURCE / SLUICE_TARGET) over putting the DSN in argv, so credentials don't land in your shell history or process list.

The target driver is planetscale, not mysql. The mysql engine cold-copies with LOAD DATA INFILE, which Vitess/PlanetScale blocks; the planetscale engine uses batched inserts and speaks VStream for CDC. Use --source-driver planetscale and --target-driver planetscale on both ends.

The target password needs --role admin. sluice creates the data tables plus (for a sync) small control tables, and lesser roles (reader/writer/readwriter) are denied DDL on a production branch. Mint it with pscale password create app-sa main mover --role admin. The source password only needs read access.

No special flag for a normal database. On v0.99.190+, an ordinary unsharded PlanetScale database — the default, one keyspace per database — syncs and migrates with no extra flags. --allow-cross-shard-merge is only for a genuinely sharded source keyspace, where it opts out of the guard that stops rows from different shards colliding on a shared key (prefer --inject-shard-column when the key isn't globally unique across shards). On sluice ≤ v0.99.189 an unsharded database needed --allow-cross-shard-merge as a workaround for a shard-detection bug fixed in v0.99.190 — upgrade and drop it.

## Case 1 — a single unsharded database

The overwhelming majority of PlanetScale databases are a single unsharded keyspace — this is the straightforward case. Pick a zero-downtime continuous sync + cutover (recommended) or a one-shot migrate; both are MySQL→MySQL. Datasets that need this are typically well under 10 GB.

### Option A — zero-downtime (recommended)

A continuous sync snapshots and bulk-copies the source, then streams live CDC — so the source stays writable the whole time and you flip traffic in a brief, controlled window. Start with a dry-run to review the plan, then launch the long-lived stream:

    # review the plan first
    sluice sync start --stream-id region-move \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --dry-run --format json

    # launch the long-lived stream (snapshot -> bulk copy -> live CDC)
    sluice sync start --stream-id region-move \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --apply-batch-size 50

Watch it catch up from another shell, and gate cutover on freshness:

    sluice sync status --stream-id region-move \
        --target-driver planetscale --target "$SLUICE_TARGET"

    sluice sync health --stream-id region-move \
        --target-driver planetscale --target "$SLUICE_TARGET" --max-stale-seconds 30

At ~1.2 GB the cold-start-to-tailing transition took about 5 minutes in testing (bulk copy ~4 MB/s, PS-10 CPU-bound — a larger cluster tier is the throughput lever). Once the stream is tailing, cut over: cutover primes the target's AUTO_INCREMENT past the source's, with a safety margin, so the application can start writing to the target without primary-key collisions. Then stop the stream and verify:

    sluice cutover \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET"

    sluice sync stop --stream-id region-move \
        --target-driver planetscale --target "$SLUICE_TARGET" --wait

    sluice verify \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET"

Wait for caught-up before cutover. A trickle of changes can take tens of seconds to ~2 minutes to appear on the target — that latency is PlanetScale VStream's roughly 60 s server-side delivery cadence, not sluice (the applier commits within seconds of receiving an event). Under sustained write load, lag stays low. So before you cut over, wait for sync health / verify to report caught-up rather than trusting a fixed timer.

Keep --apply-batch-size in the 25–50 range on a PS target. Above 50, a batch's apply transaction can trip Vitess's 20-second transaction killer. 50 is a safe default here.

### Option B — one-shot migrate

If you can take a short maintenance window, a one-shot migrate is simpler — one command, no control tables left behind, and identity_sync auto-primes AUTO_INCREMENT so there's no separate cutover step:

    sluice migrate \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET" --dry-run

    sluice migrate \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET"

    sluice verify \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET"

The catch: a migrate is a point-in-time copy with no CDC, so any row written to the source after it starts is missed. That means you must freeze writes to the source for the entire copy window — about 14 minutes for the 1.2 GB test dataset. It's a good fit for a small database you can quiesce briefly.

### Which to choose

Zero-downtime (Option A) is the better default for a real region move: no write freeze, and in testing it was also about 3× faster on the bulk copy than one-shot (~5 minutes vs ~14 minutes for the same 1.2 GB). One-shot (Option B) wins only on simplicity, when a brief maintenance window is acceptable and you'd rather not run a long-lived stream or a separate cutover.

## Case 2 — several unsharded databases

A PlanetScale database is one keyspace, and each sync start / migrate moves exactly one source keyspace to one target — so moving several databases means one run per database, each with its own --stream-id and its own target. There is nothing exotic here: it is Case 1 repeated per keyspace, run in parallel or supervised together.

Per database: create the target database in the new region, mint its --role admin password, and run the same Case-1 flow (Option A or Option B) with a distinct --stream-id. Moving two databases (app-us-1→app-sa-1 and app-us-2→app-sa-2) is just two independent invocations, each pointed at its own source and target:

    # database 1
    sluice sync start --stream-id app-1-region-move \
        --source-driver planetscale --source "$SLUICE_SOURCE_1" \
        --target-driver planetscale --target "$SLUICE_TARGET_1" \
        --apply-batch-size 50

    # database 2 — independent stream, independent target
    sluice sync start --stream-id app-2-region-move \
        --source-driver planetscale --source "$SLUICE_SOURCE_2" \
        --target-driver planetscale --target "$SLUICE_TARGET_2" \
        --apply-batch-size 50

Supervise many at once with a fleet config. Running each sync as its own process gets unwieldy past a handful. A sync fleet config collapses them into one supervised, failure-isolated process — one entry per database, each with its own stream-id and target — so a whole fleet of region moves runs and reloads from a single place.

## Case 3 — a sharded keyspace

A genuinely sharded PlanetScale keyspace — multiple shards behind a vindex — is supported as a source on sluice v0.99.191+; earlier versions failed the cold copy with 0 rows. Because vtgate merges all shards into one logical stream, sluice's cross-shard-collision guard requires you to opt in: pass --allow-cross-shard-merge when your key is globally unique across shards (a hash vindex puts each id on exactly one shard, so ids are disjoint and the merge is safe), or --inject-shard-column to add a shard-discriminator column instead.

Multi-keyspace sources are shard-complete (v0.99.196+). If your database holds several keyspaces, sluice cross-checks shard discovery against SHOW VITESS_TABLETS: vtgate's SHOW VITESS_SHARDS can silently omit a fully-serving secondary sharded keyspace, so trusting it alone could miss an entire keyspace's shards. sluice unions the two sources and warns on any discrepancy, so a sync or backup never silently skips a shard. A single-keyspace source was never affected (migrate isn't either — its bulk copy is a plain scatter query vtgate fans out across every serving shard).

### Sub-case A — merge into an unsharded target

The simplest path, and it works out of the box: point the sharded source at an unsharded target database with --allow-cross-shard-merge, and every shard's rows land in the one target table. Live-proven — all rows copied, no FailedPrecondition. Note the source DSN's database is the keyspace name (here sks):

    sluice migrate \
        --source-driver planetscale \
        --source "USER:PASS@tcp(aws.connect.psdb.cloud:3306)/sks?tls=true" \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --allow-cross-shard-merge

### Sub-case B — preserve sharding (sharded → sharded)

To keep the data sharded, create a target keyspace sharded with the same vschema / vindex. sluice's cold copy and live CDC then route every row to the correct target shard — validated: INSERT / UPDATE / DELETE across both shards land on the matching shard, with under 20 seconds of CDC lag.

Control tables live in a sidecar keyspace — handled automatically on v0.99.193+. A sharded target can't hold sluice's internal control tables (sluice_cdc_state, sluice_cdc_schema_history, sluice_shard_consolidation_lease) directly — Vitess requires every table in a sharded keyspace to carry a vindex. On v0.99.193+ sluice handles this: it auto-detects the database's default unsharded keyspace and creates its control tables there, so a sharded→sharded sync just works with no manual setup. Pass --control-keyspace <name> only to override (and if the database has several unsharded keyspaces, sluice asks you to choose one). On a sharded target the control-table write then rides the data transaction cross-keyspace (best-effort, not two-phase) — safe in practice, since a hard crash warm-resumes cleanly from the persisted position with no duplicates or gaps. On sluice before v0.99.193 this aborted with VT09001: … does not have a primary vindex before any rows copied; upgrade to v0.99.193+. (The merge sub-case A and a one-shot full backup/restore below never need a sidecar; a chain restore into a sharded target does — see below.)

### Backup / restore a sharded source

If you just want a point-in-time copy of a sharded keyspace into a plain database, backup full reads a sharded source with no special flag — it flattens the shards into one logical stream — and restore into a PlanetScale MySQL database needs no --allow-cross-shard-merge, because the backup already flattened it:

    sluice backup full \
        --source-driver planetscale \
        --source "USER:PASS@tcp(aws.connect.psdb.cloud:3306)/sks?tls=true" \
        --output-dir ./sks-backup

    sluice restore \
        --from-dir ./sks-backup \
        --target-driver planetscale --target "$SLUICE_TARGET"

Restoring back into a sharded keyspace. Flattening on the backup side doesn't lock you into an unsharded target. Restore into a keyspace that's sharded with the same vindex and Vitess re-routes every row to its correct shard by the vindex hash — the same routing the live sync in sub-case B uses — so per-shard placement on the target matches the source exactly. Create the target keyspace sharded with a matching vschema first, then point restore at it (the --target database is the keyspace name):

    sluice restore \
        --from-dir ./sks-backup \
        --target-driver planetscale \
        --target "USER:PASS@tcp(aws.connect.psdb.cloud:3306)/sks?tls=true"

A full restore just works; a chain restore needs the same sidecar as sync (v0.99.195+). A single full restore into a sharded target needs no extra flags — it writes only your data tables, which Vitess shards by their vindex, and creates no control tables; per-shard placement matches the source. A chain restore (a full plus one or more incrementals) is different: replaying the incrementals writes sluice's CDC control tables (sluice_cdc_state and friends), which a sharded keyspace can't hold — so restore --control-keyspace <name> routes them to an unsharded sidecar keyspace, auto-detected on v0.99.195+ exactly like the sync case above (pass the flag only to override, or if the database has several unsharded keyspaces). Before v0.99.195 a chain restore into a sharded target aborted with … does not have a primary vindex; a single full restore was always fine.

## Next steps

- PlanetScale & Vitess — the flavor, cold-start throughput knobs, and VStream lag reality in depth.

- Zero-downtime migration — the snapshot→CDC cutover flow, engine-agnostic.

- sync start reference — every flag named here, with defaults.

---
Canonical page: https://sluicesync.com/docs/planetscale-region-move/ · Full docs index: https://sluicesync.com/llms.txt
