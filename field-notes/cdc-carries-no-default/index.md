<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# The replication stream never tells you the column default

> Neither pgoutput nor the MySQL binlog carries a column's DEFAULT. Forward an ADD COLUMN … DEFAULT now() over CDC and the target re-evaluates the default on its own — so every row that shipped before the ALTER gets a different value than the source's backfill.

Observed — cross-engine CDC schema-change forwarding, an ALTER TABLE … ADD COLUMN … DEFAULT <volatile> on the source mid-stream. Internally ADR-0058 (online schema-change forwarding) + Bug 90 / Bug 91.

## What happened

A source added a column with a default — ALTER TABLE orders ADD COLUMN created_at timestamptz DEFAULT now() — while CDC was tailing it. The DDL forwarded to the target and new rows looked fine. But every row that had already shipped to the target before the ALTER carried a different created_at than the same row on the source. Silent per-row divergence across the whole pre-existing table.

## Why (the mechanism)

Two facts combine. First, the replication wire format does not carry a column's DEFAULT. pgoutput's RelationMessage describes each column's name, type OID, and flags — there is no attdefault slot. MySQL's TableMapEvent describes column types and metadata — there is no COLUMN_DEFAULT. A CDC schema-forwarder literally cannot see the default in the stream; it only sees the DDL text (or the relation shape).

Second, a volatile default is evaluated at ALTER time, per row. When the source runs ADD COLUMN … DEFAULT now() (or random(), gen_random_uuid(), MySQL UUID() / RAND()), it backfills every existing row with the default evaluated then, on the source. If the target only replays the DDL, it re-evaluates the default independently — a different now(), different random values, different UUIDs — for its own copy of those rows. The two backfills disagree, row by row. A constant default (DEFAULT 0, DEFAULT 'active') is safe precisely because it evaluates identically on both sides; the failure dispatches on the default's volatility class, not on any one function.

## The repro

    -- source, with CDC tailing and rows already replicated to the target:
    ALTER TABLE orders ADD COLUMN created_at timestamptz DEFAULT now();
    --   source backfills existing rows with the ALTER-time now(), e.g.
    --   2026-05-25 10:00:00+00 for every pre-existing row.

    -- target, replaying only the DDL:
    ALTER TABLE orders ADD COLUMN created_at timestamptz DEFAULT now();
    --   target backfills the SAME rows with ITS now(), e.g.
    --   2026-05-25 10:00:07+00 — 7 seconds off, every row, silently.

## What sluice does about it

sluice classifies the default's volatility when it forwards an ADD COLUMN. A constant/immutable default is safe to replay as-is. A volatile default (time, random, UUID, sequence nextval — a nextval is as non-reproducible as now()) cannot be reconstructed identically from the DDL alone, so sluice never lets the target re-evaluate it. If the source still declares it when the ADD COLUMN reaches sluice, the forward refuses loudly (ADR-0058 §2a). If it was dropped or changed before then, the forward carries what the source declares at that point, and the added-column backfill — on by default since v0.156.1 — then overwrites every already-shipped target row with the value the source actually filled it with, read from the source by primary key. Either way, two independent evaluations are never trusted to agree.

Correction (v0.156.1). An earlier version of this note said sluice forwards a volatile default and backfills the already-shipped rows. It does not: a volatile DEFAULT still declared at the boundary is refused, not backfilled, and the backfill that repairs a dropped or changed one was opt-in (--backfill-added-column) until v0.156.1. The same release fixed the wider shape this note did not cover: a constant DEFAULT dropped right after the ADD COLUMN — which is exactly what Django's AddField does — left the pre-existing target rows with the target's fill rather than the source's values. On a Postgres or PlanetScale/Vitess source, whose change streams carry no DEFAULT at all, the forward also added the column without one until v0.156.1, so those rows held NULL. See the backfill.

## The transferable lesson

A replication stream carries data changes, not the schema's generative rules — the DEFAULT is metadata that lives in the catalog, and neither pgoutput nor the binlog puts it on the wire. So "replay the DDL on the target" is only correct when the default is a constant. The moment a default is volatile, the source's ALTER-time backfill and the target's replayed backfill are two independent evaluations of a non-deterministic expression, and they will not match. If you forward schema changes over CDC, classify default volatility explicitly and treat volatile defaults as data to be copied from the source, never as DDL to be re-run.

## Primary sources

- pgoutput RelationMessage (no default field) — logical replication message formats.

- Postgres function volatility categories — function volatility.

- MySQL binlog TABLE_MAP_EVENT — Table_map_event.

- How sluice handles source schema changes during a sync — Schema changes during a sync.

---
Canonical page: https://sluicesync.com/field-notes/cdc-carries-no-default/ · Full docs index: https://sluicesync.com/llms.txt
