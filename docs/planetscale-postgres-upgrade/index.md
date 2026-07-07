# Upgrade or re-platform a PlanetScale Postgres database

> PlanetScale Postgres has no in-place major-version upgrade or CPU-architecture swap — provision a new instance on the target, let sluice sync across, then cut over.

PlanetScale Postgres has no hands-off, in-place major-version upgrade — and no in-place CPU-architecture swap. The near-zero-downtime path is the same pattern the region-move guide uses, along a different axis: provision a new PlanetScale Postgres instance on the target version (or architecture), use sluice to cold-copy and continuously sync the data across, verify, then cut traffic over. Because sluice's Postgres CDC is logical replication — row-level changes, not physical WAL pages — it carries data across a major-version boundary the way logical replication is the standard tool for near-zero-downtime PG major upgrades, and it's indifferent to the underlying CPU architecture. Live-validated: a real PlanetScale PG 17.10 → PG 18.4 move — cold-copy + continuous CDC + verify all clean, byte-identical value fidelity, no version-specific surprises.

## When you need this

Two axes, one flow:

- Major-version upgrade (e.g. 17→18, and 18→19 when it lands) — to stay current and pick up new PostgreSQL features and performance work. PlanetScale doesn't upgrade a database's major version in place, so you move to a fresh instance created on the newer version.

- CPU-architecture change (ARM→x86, or back) — when your instance is on an architecture whose instance sizes are constrained and you need to move to the other. The architecture is chosen when the instance is created, so this too is a spin-up-new-instance move.

Both reduce to the same three steps: spin up a new instance on the target, sync, cut over. sluice doesn't touch or even observe the architecture — logical replication is arch-transparent, so an ARM-source → x86-target sync is identical to the version-upgrade flow below. The live test's source and target both ran on aarch64; the version delta is the harder case (it crosses a catalog/format boundary) and it passed clean. The architecture case adds no schema or catalog difference at all — it's the same PG data on different silicon — so it's the strictly-simpler variant of the same procedure, not a separate one.

## Provision the target

Create the new instance on the target major version. --major-version selects the PG major; the default is the latest (18 today), and 17 is also available — pin it explicitly if you want a specific target:

    pscale database create <new-db> --engine postgresql --major-version <NEW> \
        --region <region> --replicas 0 --wait

For an architecture change, provision the new instance on the target architecture instead. The architecture is selected at instance creation on PlanetScale (the exact instance-type surface can vary — see PlanetScale's instance-type docs rather than pinning a specific flag here). Everything downstream is identical to the version case.

Take the target DSN from the Default postgres role and rewrite sslmode=verify-full → sslmode=require — the same recipe as the PlanetScale Postgres guide:

    pscale role reset-default <new-db> main --force --format json   # -> database_url

    # DST_NEW = that database_url, with sslmode=verify-full rewritten to sslmode=require

Both ends connect as the Default postgres role. The source needs the REPLICATION attribute to create the logical-replication slot, which the custom pscale_api_* roles lack; the target wants a durable table owner. The Default postgres role has REPLICATION and owns the schema — use it on both. (Same requirement, and the same SLUICE-E refusal if you don't, as the PlanetScale Postgres sync guide.)

## Sync across the version

This is the exact validated sequence. One sync start, both ends the plain postgres driver:

    sluice sync start --stream-id pg-upgrade \
        --source-driver postgres --source "$SRC_OLD" \
        --target-driver postgres --target "$DST_NEW"

sluice cold-copies every row, then logs bulk-copy complete; entering CDC mode and tails logical-replication CDC — so the old instance stays fully writable the entire time while the new one catches up. Watch freshness from another shell and gate cutover on it:

    sluice sync status --stream-id pg-upgrade \
        --target-driver postgres --target "$DST_NEW"

    sluice sync health --stream-id pg-upgrade \
        --target-driver postgres --target "$DST_NEW" --max-stale-seconds 30

Live result (PG 17.10 → 18.4): 50 rows cold-copied, then 6 INSERT / 1 UPDATE / 1 DELETE on the source replicated to the PG 18 target in about 15 seconds. A subsequent verify reported 1 table checked, 1 clean, 0 mismatched, and numeric / timestamptz / jsonb / boolean values were byte-identical across the version boundary — no copy or CDC WARNs.

## Verify and cut over

Gate cutover on a clean verify plus a fresh sync health:

    sluice verify \
        --source-driver postgres --source "$SRC_OLD" \
        --target-driver postgres --target "$DST_NEW"

Then drain the stream cleanly and repoint your application's DATABASE_URL at the new (upgraded) instance:

    sluice sync stop --stream-id pg-upgrade \
        --target-driver postgres --target "$DST_NEW" --wait

verify lists sluice's own bookkeeping tables as informational. A clean sync leaves sluice's control tables (sluice_cdc_schema_history, sluice_shard_consolidation_lease) on the target; verify reports them as target-only rows for transparency, not as mismatches. Your data tables are what the 0 mismatched line covers.

## Gotchas

- Source and target both connect as the Default postgres role — the source for REPLICATION (slot creation), the target for durable table ownership. Custom pscale_api_* roles lack REPLICATION.

- Rewrite sslmode=verify-full → sslmode=require on both DSNs — PlanetScale's Postgres server cert isn't in the public trust store, so verify-full fails the handshake.

- --major-version defaults to the latest. If you want a specific target major, pin it explicitly; otherwise a fresh instance lands on the newest version PlanetScale offers.

- No version-specific surprises at 17→18 for the core type set — numeric, timestamptz, jsonb, boolean all round-tripped byte-identically, with no copy/CDC WARNs. A wider or more exotic type surface deserves its own verify before cutover regardless.

- Provision the target with headroom. Size the new instance (PlanetScale sizing) to match or exceed the source before you cut over.

## Next steps

- Migrate & sync PlanetScale Postgres — the connection recipe (roles, sslmode) and migrate/sync depth this guide builds on.

- Move PlanetScale regions — the same provision-sync-cutover flow across a different axis (regions).

- Zero-downtime migration — the snapshot→CDC cutover flow in depth, engine-agnostic.

- Command reference — every flag named here, with defaults.

---
Canonical page: https://sluicesync.com/docs/planetscale-postgres-upgrade/ · Full docs index: https://sluicesync.com/llms.txt
