# Schema changes during a live sync

> How sluice keeps a running sync online while the source schema evolves — what forwards automatically, what refuses loudly, and how to recover.

A source schema rarely stands still. Columns get added, types get widened, indexes come and go while a continuous sync is running. sluice does not manage those migrations for you — tools like Atlas, sqitch, Flyway, and liquibase do that — but it does keep the stream online through them. By default it forwards the operator's own committed DDL onto the target, so a routine ALTER TABLE no longer wedges the sync. This page covers what forwards automatically, the narrow set of changes that still refuse loudly, and the drained-migrate recovery when one does.

## The control: --schema-changes

A single tristate flag on sync start (and per-sync in a sync run fleet spec) governs the behavior, introduced in ADR-0091:

Mode · Behavior ·

--schema-changes=forward (default) · Apply every unambiguous source schema change on the target automatically, logging each applied DDL at INFO. The sync stays online through routine schema evolution. ·

--schema-changes=refuse · The conservative pre-v0.92 behavior: any source DDL surfaces loudly with a structured drift diff and the drained-model recovery hint. For operators who gate DDL through a separate change-management process. ·

This is a behavior change on upgrade. A stream that previously refused on source DDL now forwards it. Set --schema-changes=refuse to keep the old drained-model default. Note also that --schema-changes is a no-op under Shape A (--inject-shard-column): the multi-shard boundary router already forwards every shape via its lease. The older --forward-schema-add-column boolean is deprecated — forwarding is on by default and covers every shape, so the flag is subsumed; setting it logs a deprecation warning and forwards.

## What forwards, by source engine

Under forward, the intercept can emit any shape's DDL, but a change only reaches the target if the source's CDC stream actually carries its detail on the wire. Postgres logical replication (pgoutput) carries less than MySQL's information_schema re-read, so the honest matrix differs by source engine. This is the ground-truth table from ADR-0091 §1d — do not assume a shape forwards without checking it:

Shape · MySQL source · Postgres source ·

ADD COLUMN · forwards · forwards ·

DROP COLUMN · forwards · forwards ·

ALTER COLUMN TYPE (same- or cross-engine) · forwards · forwards ·

ALTER NULLABILITY · forwards · refuses1 ·

Column REORDER · no-op2 · no-op2 ·

CREATE / DROP INDEX · refuses3 · never signaled on the wire — cannot forward; mirror manually1 ·

ADD / DROP / MODIFY CHECK · refuses3 · never signaled on the wire — cannot forward; mirror manually1 ·

RENAME COLUMN · refuses (§rename) · forwards via attnum4 ·

RENAME TABLE / multi-shape combo · refuses · refuses ·

1 pgoutput's relation message carries only column name + type + the replica-identity key flag — no nullability flag, no secondary-index or CHECK metadata. The wire never signals these on a Postgres source, so they produce no boundary to forward. A resulting incompatibility surfaces as a loud apply error on the next affected row, not silent corruption.
2 sluice decodes rows by column name, never by position, so a pure reorder needs no DDL — it is a safe no-op.
3 MySQL's CDC projection reads only {schema, name, columns, primary key} on a DDL boundary; it does not project secondary indexes or CHECK constraints. Forwarding them would need a new catalog projection (perf-only for indexes; cross-engine expression-translation-hazardous for checks), so both are deferred.
4 A Postgres RENAME is proven via the stable pg_attribute.attnum — see RENAME COLUMN.

Every forwarded DDL is logged at INFO as it lands, so the applied change is visible in the sync's log stream. Cross-engine type ALTERs are retargeted through the same translation path a cold-start CREATE TABLE uses; a widening ALTER forwards cleanly, while a narrowing or incompatible one is rejected by the target engine and surfaces as a loud, retryable refuse (position not advanced).

## What always refuses, even under forward

Two shapes never auto-apply, because forwarding the wrong guess would silently lose data:

### RENAME COLUMN

A column rename and a DROP x + ADD y of the same type are indistinguishable from the replication stream alone — both present as exactly one dropped column and one added column. Guessing RENAME when the truth is drop+add keeps stale data under the new name; guessing drop+add when the truth is RENAME drops the column's data on the target. The only safe disambiguation is a stable column identity that survives a rename:

- Postgres has one — pg_attribute.attnum is stable across a rename. The PG CDC reader carries it as the column's stable id; the intercept forwards a rename only when the before and after columns share the same non-zero attnum (proven rename, data preserved) and refuses otherwise. Because the proof is definitive, a bug here can only ever refuse safely, never mis-forward.

- MySQL has no equivalent — ORDINAL_POSITION changes on reorder and there is no creation id, so a MySQL-source rename is fundamentally unprovable from catalog state. It refuses, permanently. Drain and rename on both ends explicitly.

### ADD COLUMN with a computed / volatile DEFAULT

An ADD COLUMN whose DEFAULT is a non-deterministic function is refused, because evaluating it in the target's session diverges from the per-row values the source already inserted (ADR-0058 §2a). The refused functions include NOW() / CURRENT_TIMESTAMP / clock_timestamp(), nextval(), gen_random_uuid(), random(), and MySQL's UUID() / RAND() — matched schema-qualified or bare, and detected even when wrapped (e.g. COALESCE(NULL, NOW())). A constant DEFAULT forwards normally. If the probe of a column's default can't be read at all, sluice refuses on uncertainty rather than risk a wrong value.

Multi-shape combos (more than one structural change in a single boundary) also refuse — the IR delta can't be unambiguously ordered — as does a target DDL apply that fails on lock contention, permissions, or an unrecognized type. Every one of these leaves the CDC position un-advanced, so a retry replays the boundary once you've reconciled by hand.

## The refusal message

When a change refuses, the error is deliberately greppable and names the specific offending object plus the operator action. It carries three parts: the classify error (which shape / how many changes), a structured drift diff that names the exact columns / indexes / constraints that differ, and a recovery hint. The hint spells out the drained model:

- Run sluice sync stop --wait to drain in-flight changes.

- Apply the schema change on the target (manually, or via sluice schema migrate).

- Resume with sluice sync start --resume.

- It also notes that --schema-changes=refuse keeps the drained model as the default for any subsequent source DDL.

## Operator runbook: recovering a refused change

When a change refuses — or when you run --schema-changes=refuse deliberately — the recovery is the drained-schema-migrate sequence. Stop the stream with --wait so the CLI blocks until the streamer confirms a graceful drain (the in-flight batch is committed and the CDC position is persisted past the last applied event), apply the DDL to whichever side needs it, then resume from the persisted position:

    # 1. Drain and stop — --wait blocks until the drain is confirmed
    sluice sync stop --wait \
        --stream-id app-prod \
        --target-driver postgres --target 'postgres://...target...'

    # 2. Apply the schema change on source and/or target as appropriate
    psql "$SOURCE_DSN" -c 'ALTER TABLE accounts RENAME COLUMN label TO name;'
    psql "$TARGET_DSN" -c 'ALTER TABLE accounts RENAME COLUMN label TO name;'

    # 3. Resume from the persisted CDC position
    sluice sync start --resume \
        --stream-id app-prod \
        --source-driver mysql    --source 'root:rootpw@tcp(localhost:3306)/app' \
        --target-driver postgres --target 'postgres://...target...'

The --resume flag picks up the persisted CDC position (source LSN / GTID set / VStream cursor), so pre-stop events apply cleanly and the first event after resume sees the new shape on both sides. Without --resume, sluice refuses to bulk-copy into a populated target. The order "stop → ALTER source → ALTER target → start" is robust regardless of which side commits the DDL first, as long as both sides carry the new shape before resume.

Plan the target-side change first. sluice schema diff runs the source schema through sluice's translation pipeline and reports drift against the target's actual schema — apply the ALTER on the source, run the diff, and it surfaces the missing-on-target columns / type mismatches with suggested ALTER statements as a starting point. It does not know your data volume or lock duration, so review them before running.

## Next steps

- sync start reference — the --schema-changes row and the full sync flag set.

- Migrate MySQL to Postgres — the one-shot migration the drained model resumes onto.

- schema diff / schema migrate — pre-flight drift and apply the target-side change.

---
Canonical page: https://sluicesync.com/docs/schema-changes/ · Full docs index: https://sluicesync.com/llms.txt
