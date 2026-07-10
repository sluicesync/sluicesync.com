# MySQL won't match a JSON column by bind parameter

> WHERE json_col = ? matches zero rows in MySQL whether you bind the value as a string or as bytes — the server won't cast the parameter to JSON for the comparison. On a CDC UPDATE, replay-idempotency tolerance turns that zero-row match into silent divergence.

Observed — MySQL → MySQL logical replication (CDC apply) touching a JSON column. Internally the applier value-shaping fix, ADR-0013 (v0.2.2).

## What happened

A MySQL-to-MySQL CDC UPDATE on a table with a JSON column silently applied nothing: zero rows affected, stream position advanced, exit 0, no error. The same applier in the other direction — Postgres to MySQL — failed loudly on the identical column, crashing with Cannot create a JSON value from a string with CHARACTER SET 'binary'. One applier, one JSON column, two directions, opposite symptoms — and only the loud one was safe.

## Why (the mechanism)

The applier bound the row's values straight into parameterised SQL. Two MySQL-isms bit, in sequence:

- The bytes. go-sql-driver/mysql tags a []byte parameter with the _binary introducer, and MySQL rejects that for a JSON column (… CHARACTER SET 'binary') — the loud PG→MySQL crash. The bulk-copy path had already learned to convert JSON []byte to a string; the CDC path hadn't inherited the fix.

- The comparison. The deeper one, and the silent one: MySQL's = does not implicitly cast a ? bind parameter to JSON — bind the value as a string or as []byte, either way WHERE doc = ? compares a JSON column against a non-JSON parameter and matches nothing. The UPDATE found no row to change.

What made the second one invisible is a property of every correct CDC applier: it must tolerate zero rows affected, because logical-replication resume re-applies events idempotently (a re-applied UPDATE legitimately matches zero rows the second time — that tolerance is what makes replay safe). So the applier could not tell "already applied" from "never matched," logged the zero-row result as normal, advanced the position, and diverged the target with no signal.

## The repro

The comparison, in isolation — no replication needed:

    CREATE TABLE ledger (id BIGINT PRIMARY KEY, doc JSON);
    INSERT INTO ledger VALUES (1, '{"k":"v"}');

    -- a JSON column compared against a (string/bytes) parameter:
    SELECT * FROM ledger WHERE doc = '{"k":"v"}';              -- 0 rows
    -- the same comparison, parameter cast to JSON first:
    SELECT * FROM ledger WHERE doc = CAST('{"k":"v"}' AS JSON); -- 1 row

    -- so a CDC applier binding: UPDATE ledger SET ... WHERE doc = ?
    --   matches nothing, reports 0 rows affected, and (idempotency
    --   tolerance) advances the stream position anyway.

## What sluice does about it

The CDC applier now routes every bound value through the same per-type prepareValue shaping the bulk-copy path uses (JSON []byte → string, and the rest), driven by a lazily-populated per-table column-type cache. For the comparison itself, a placeholderFor(type) helper emits CAST(? AS JSON) instead of a bare ? for JSON-typed columns, so the equality is JSON-to-JSON and matches. The Postgres applier needs no cast equivalent — pgx inspects per-column type metadata natively. And a Debug line now fires whenever an UPDATE or DELETE matches zero rows: resume idempotency still depends on tolerating that case, but the silence now leaves a footprint.

## The transferable lesson

A parameterised = against a typed column is not type-agnostic: MySQL will not coerce a bind parameter into JSON, so a comparison that reads correctly matches nothing at runtime. And when the consumer is a CDC applier, its idempotency tolerance — the very thing that makes replay safe — is exactly what hides a never-matched predicate. This is the MySQL sibling of a Postgres story we hit on the same class: REPLICA IDENTITY FULL silently ate our UPDATEs, where a jsonb value failed an equality round-trip. Same shape, two engines, two root causes: when equality quietly stops matching, replay-tolerance swallows the loss.

## Primary sources

- MySQL JSON comparison & the need to cast — The JSON Data Type and CAST(… AS JSON).

- The _binary charset introducer behavior — character set introducers.

- Why a CDC applier tolerates zero-row applies — How sluice copies your data.

---
Canonical page: https://sluicesync.com/field-notes/mysql-json-where-cast/ · Full docs index: https://sluicesync.com/llms.txt
