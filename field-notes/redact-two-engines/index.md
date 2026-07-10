# One redaction flag: clamp on MySQL, refuse on Postgres

> --redact randomize:int:100000,200000 into a SMALLINT column loud-refused on a Postgres target and silently clamped every row to 32767 on a MySQL one — turning an anonymization rule into a constant, and a compliance guarantee into a compliance failure.

Observed — a PG→MySQL cross-engine migrate with a randomize:int redaction rule, compared against the same rule PG→PG. Fixed with a config-load preflight.

## What happened

A redaction rule --redact 's=randomize:int:100000,200000' — &ldquo;replace column s with a random integer in [100000, 200000]&rdquo; — was pointed at a SMALLINT column, whose range is [-32768, 32767]. Into a Postgres target it loud-refused: 143556 is greater than maximum value for int2. Into a MySQL target it exited 0, printed migration complete, emitted no warning, and wrote 32767 into every single row. The operator asked for random values to anonymize a column; they got a deterministic constant — and the original values were gone.

## Why (the mechanism)

The requested range overflows the target column's type on both engines; the two engines just react differently, and sluice was inheriting the reaction instead of deciding it. Postgres's binary COPY encoder rejects an out-of-range int2 outright, so the overflow surfaced as a loud error. MySQL's writer session runs with STRICT_TRANS_TABLES disabled — sluice relaxes it to read legacy data like zero-dates — and in non-strict mode MySQL silently clamps an out-of-range integer to the column's maximum rather than erroring. So every generated value above 32767 became 32767. Two compounded failures: a PII-compliance failure (the whole column collapses to one constant, trivially distinguishable from real data) and silent loss of the original values. The correctness of a redaction guarantee was resting on a target engine's native enforcement — enforcement that sluice's own session had switched off on one of the two engines.

## The repro

    -- PG source: a SMALLINT column (range [-32768, 32767])
    CREATE TABLE redact_overflow (id BIGINT PRIMARY KEY, s SMALLINT);
    INSERT INTO redact_overflow VALUES (1, 100), (2, 200);

    sluice migrate \
      --source-driver=postgres  --source='postgresql://.../src' \
      --target-driver=mysql     --target='root:...@tcp(localhost:3317)/dst' \
      --include-table=redact_overflow \
      --redact='redact_overflow.s=randomize:int:100000,200000'

    # MySQL target:  every row s = 32767   (exit 0, "migration complete", no WARN)
    # PG target:     loud refusal -- "143556 is greater than maximum value for int2"

## What sluice does about it

The redaction subsystem now runs a preflight at config-load time that compares each randomize:int rule's LO,HI range against the column's representable integer range and refuses loudly — before a single row is written — when the range can't fit. Both engines now fail the same way, up front, with an actionable message (widen the target type with --type-override, or choose a range within the column's bounds). A guarantee that used to depend on which engine you happened to target, and on whether strict mode happened to be on, is now enforced by sluice itself, identically, on every path.

## The transferable lesson

A transform that carries a promise — anonymize this, never leak that — must have identical, verified semantics on every target it can run against. If your correctness is really being provided by a downstream engine's native validation, then the moment you touch that engine's session (relax a SQL mode, change a workload, switch drivers) you can silently void the promise on that engine and not the others. Enforce the invariant yourself, at the earliest point you can (config load), so it can't diverge by target — and so the failure is a refusal the operator sees, not a constant they discover in an audit.

## Primary sources

- MySQL — Strict SQL Mode — with STRICT_TRANS_TABLES off, out-of-range values are clamped and adjusted rather than rejected.

- PostgreSQL — Numeric Types — an out-of-range smallint/int2 is an error, not a clamp.

- sluice's redaction strategies — Redact PII.

---
Canonical page: https://sluicesync.com/field-notes/redact-two-engines/ · Full docs index: https://sluicesync.com/llms.txt
