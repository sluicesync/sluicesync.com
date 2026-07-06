# Move a PlanetScale database between regions

> PlanetScale has no native region move — create the database in the new region and let sluice copy it across, with zero downtime or in one shot.

A PlanetScale database is pinned to its region at creation, and there is no in-place region move. The path is straightforward: create a new PS-MySQL database in the target region, then use sluice to copy the data across — either a zero-downtime continuous sync + cutover (recommended) or a one-shot migrate. Both directions are MySQL→MySQL, so no cross-engine type translation is involved. Datasets that need this are typically well under 10 GB.

## Provision the target & connect

Create the destination database in the new region, sized to match (or exceed) the source. A PS-10 branch takes roughly 7–8 minutes to reach READY:

    pscale database create app-eu --region aws-sa-east-1 --cluster-size PS-10

Both the source and the target reach PlanetScale through the same global connect host, aws.connect.psdb.cloud:3306 — PlanetScale routes to the right region by credential, not by hostname. The connection strings are standard go-sql-driver MySQL DSNs, and ?tls=true is required on both:

    # source (CDC read) — export as SLUICE_SOURCE
    USERNAME:PASSWORD@tcp(aws.connect.psdb.cloud:3306)/app-us?tls=true

    # target (write) — export as SLUICE_TARGET
    USERNAME:PASSWORD@tcp(aws.connect.psdb.cloud:3306)/app-eu?tls=true

USERNAME is the generated username field returned by pscale password create <db> <branch> <label> — not the label you pass on the command line — and PASSWORD is its plain_text value. Prefer environment variables (SLUICE_SOURCE / SLUICE_TARGET) over putting the DSN in argv, so credentials don't land in your shell history or process list.

The target driver is planetscale, not mysql. The mysql engine cold-copies with LOAD DATA INFILE, which Vitess/PlanetScale blocks; the planetscale engine uses batched inserts and speaks VStream for CDC. Use --source-driver planetscale and --target-driver planetscale on both ends.

The target password needs --role admin. sluice creates the data tables plus (for a sync) small control tables, and lesser roles (reader/writer/readwriter) are denied DDL on a production branch. Mint it with pscale password create app-eu main mover --role admin. The source password only needs read access.

Current-version flag. On unsharded PlanetScale databases, sluice ≤ v0.99.189 currently requires --allow-cross-shard-merge on sync start / migrate because of a shard-detection quirk (a fix is in progress). It is safe on a normal single-shard database, and the examples below include it so they work as shown.

## Option A — zero-downtime (recommended)

A continuous sync snapshots and bulk-copies the source, then streams live CDC — so the source stays writable the whole time and you flip traffic in a brief, controlled window. Start with a dry-run to review the plan, then launch the long-lived stream:

    # review the plan first
    sluice sync start --stream-id region-move \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --allow-cross-shard-merge --dry-run --format json

    # launch the long-lived stream (snapshot -> bulk copy -> live CDC)
    sluice sync start --stream-id region-move \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --apply-batch-size 50 --allow-cross-shard-merge

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

## Option B — one-shot migrate

If you can take a short maintenance window, a one-shot migrate is simpler — one command, no control tables left behind, and identity_sync auto-primes AUTO_INCREMENT so there's no separate cutover step:

    sluice migrate \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --allow-cross-shard-merge --dry-run

    sluice migrate \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --allow-cross-shard-merge

    sluice verify \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET"

The catch: a migrate is a point-in-time copy with no CDC, so any row written to the source after it starts is missed. That means you must freeze writes to the source for the entire copy window — about 14 minutes for the 1.2 GB test dataset. It's a good fit for a small database you can quiesce briefly.

## Which to choose

Zero-downtime (Option A) is the better default for a real region move: no write freeze, and in testing it was also about 3× faster on the bulk copy than one-shot (~5 minutes vs ~14 minutes for the same 1.2 GB). One-shot (Option B) wins only on simplicity, when a brief maintenance window is acceptable and you'd rather not run a long-lived stream or a separate cutover.

## Before you start & gotchas

- Foreign keys. Vitess rejects FOREIGN KEY DDL (VT10001). If the source schema declares foreign keys, they must be dropped (kept as plain indexed columns) before the move. This applies to any DDL against PlanetScale, not just sluice.

- --allow-cross-shard-merge is currently required on unsharded databases — see the current-version note under Provision the target.

- The sync stop --wait drain message. On VStream teardown, sync stop --wait may print a "did not complete drain within …" timeout even though the stream did drain and exit cleanly. Verify the process actually exited rather than treating that message alone as a failure.

- Throughput is target-tier-CPU-bound. The bulk copy is limited by the target cluster's CPU; scale the tier for a faster copy.

## Next steps

- PlanetScale & Vitess — the flavor, cold-start throughput knobs, and VStream lag reality in depth.

- Zero-downtime migration — the snapshot→CDC cutover flow, engine-agnostic.

- sync start reference — every flag named here, with defaults.

---
Canonical page: https://sluicesync.com/docs/planetscale-region-move/ · Full docs index: https://sluicesync.com/llms.txt
