# Move a PlanetScale database to another organization

> PlanetScale has no in-place org transfer — its documented path is an offline dump and restore. sluice turns the same move into a zero-downtime sync, and lets you change region or cluster size in the same pass.

Databases belong to an organization at creation, and there is no in-place transfer between organizations — moving one means creating a new database in the target org and copying the data across. To sluice, an org move and a region move are the same operation: both ends connect through the same global host and PlanetScale routes by credential, so sluice never sees the organization at all. Every case, gotcha, and command in the region-move guide applies verbatim here. This page covers only what an org move adds: choosing between the dump path and a live copy, credentials that come from two different orgs, and the org-level settings that don't travel with the data.

## Choose your path

Three ways to make the move:

- PlanetScale's documented path — pscale database dump + restore-dump. Dump from the source org, restore into a database in the target org (the officially recommended flow). It is offline: rows written after the dump starts are not in it, so you freeze writes for the whole window, and the window scales with database size. Fine for a small database with an acceptable maintenance window. On pscale v0.218.0+, --allow-different-destination lets the destination database/branch name differ from the source's without renaming the dump files.

- sluice zero-downtime sync + cutover (recommended). A continuous sync bulk-copies the source, then streams live CDC until you cut over — the source stays writable the whole time. This is Case 1, Option A of the region-move guide, unchanged.

- sluice one-shot migrate. Simpler than the dump path at a similar downtime shape (freeze writes for the copy window), with schema, indexes, foreign-key handling, and AUTO_INCREMENT priming handled in one command — Case 1, Option B.

One thing both sluice paths give you that the dump path can't: the target is an ordinary new database, so you can change region and/or cluster size in the same move — pick the new org's region and tier when you create it, and the copy lands there directly.

## Credentials from two orgs — the one mechanical difference

The source password is minted in the source org and the target password in the target org — pass --org to each pscale call rather than relying on the CLI's default org:

    # source org: read access is enough
    pscale password create app main mover --org source-org

    # target org: sluice creates tables (and, for a sync, control tables) -> --role admin
    pscale password create app main mover --role admin --org target-org

USERNAME is the generated username field each command returns — not the label — and PASSWORD its plain_text value. Both DSNs point at the same global host; the credential alone decides which org (and database) you reach:

    # source (org A) — export as SLUICE_SOURCE
    USERNAME:PASSWORD@tcp(aws.connect.psdb.cloud:3306)/app?tls=true

    # target (org B) — export as SLUICE_TARGET
    USERNAME:PASSWORD@tcp(aws.connect.psdb.cloud:3306)/app?tls=true

The two databases can share a name — names are scoped per organization, so app in the source org and app in the target org are distinct databases and the DSNs above are unambiguous. Prefer environment variables over putting DSNs in argv, and use --source-driver planetscale --target-driver planetscale on both ends exactly as in the region-move guide.

## Settings don't travel — the re-apply checklist

The copy moves your schema and rows. Everything configured on the database or the organization stays behind, and the new database starts from defaults in the new org:

- Foreign keys — enable them on the target before the copy. "Allow foreign key constraints" is a per-database setting, so the new database in the new org has it off even if the source had it on. Turn it on in the target's Settings → General (no open deploy requests) before you migrate, or sluice's FK DDL is rejected with VT10001. Full decision notes — including --skip-foreign-keys — in Foreign keys on Vitess and the region-move guide's foreign-key note.

- Branch promotion and safe migrations — copy first, promote after. A fresh database's default branch starts as a development branch, which is exactly what you want during the copy: sluice can create tables directly. Once the move is done and traffic is cut over, promote the branch to production and re-enable safe migrations / deploy-request protections to match the source org's posture — not before, or the target rejects sluice's DDL.

- Service tokens, OAuth apps, and CI credentials are org-scoped. Anything that authenticated against the source org — deploy pipelines, pscale service tokens, monitoring — needs new credentials minted in the target org and swapped into app config at cutover time.

- Backups, insights, and alerting. Backup schedules, alert destinations, and any beta features enabled on the source database are per-database configuration — re-create them on the target after the move.

## The copy itself — follow the region-move guide

With the two DSNs in SLUICE_SOURCE / SLUICE_TARGET, the move is byte-for-byte the region-move flow: Case 1 for a single unsharded database (the common one), Case 2 for several databases (one run per keyspace, or a fleet config), Case 3 for a sharded keyspace. All the gotchas carry over too — --upfront-indexes on large tables, --apply-batch-size in the 25–50 range, waiting for caught-up before cutover. The zero-downtime shape, for orientation:

    sluice sync start --stream-id org-move \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET" \
        --apply-batch-size 50

    # ... watch sync status / sync health until caught up, then:
    sluice cutover \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET"

    sluice sync stop --stream-id org-move \
        --target-driver planetscale --target "$SLUICE_TARGET" --wait

    sluice verify \
        --source-driver planetscale --source "$SLUICE_SOURCE" \
        --target-driver planetscale --target "$SLUICE_TARGET"

After verify reports a match and the application is writing to the target org, walk the settings checklist above, then wind down the source database on your own schedule — it is untouched by the move and remains your rollback until you delete it.

## Next steps

- Move PlanetScale regions — the full copy mechanics this page leans on: all three cases, provisioning, and every gotcha.

- Foreign keys on Vitess — the enable-vs-skip decision in full.

- Zero-downtime migration — the snapshot→CDC cutover flow, engine-agnostic.

---
Canonical page: https://sluicesync.com/docs/planetscale-org-move/ · Full docs index: https://sluicesync.com/llms.txt
