# The binlog keeps your SQL comments — and our TRUNCATE parser didn't know

> A leading -- comment on a TRUNCATE made our CDC reader miss the statement entirely. The source emptied; the target kept every row, forever, with no error and no lag.

Observed — MySQL binlog CDC. Internally Bug 140 (fixed in PR #208). Postgres is immune (see below).

## What happened

A CDC stream from MySQL silently diverged: the source ran a TRUNCATE, the source table emptied, and the target kept every one of its rows — indefinitely, with no error and no replication lag to hint at the gap. The stream looked perfectly healthy. It just never applied the truncate.

## Why (the mechanism)

MySQL's binlog QUERY_EVENT preserves a statement's leading comment verbatim — it strips only the trailing delimiter. Our CDC reader recognized a truncate by checking whether the event body starts with TRUNCATE. So a statement written as:

    -- clear staging
    TRUNCATE TABLE t;

arrived in the binlog as -- clear staging
TRUNCATE TABLE t, failed the &ldquo;starts with TRUNCATE&rdquo; test, and fell through to generic DDL handling — which quietly did nothing for this statement. The truncate was never applied to the target.

This is not a synthetic-harness artifact. Hand-written migrations and ORM/APM query tags (/* trace=... */, -- deploy 2026-...) prepend comments to statements routinely, and MySQL dutifully records them in the binlog. Any consumer that pattern-matches SQL out of a binlog by prefix will trip on them.

## The repro

Run a commented TRUNCATE against a MySQL source under CDC and watch the target keep its rows:

    -- on the source, under an active CDC stream:
    INSERT INTO t VALUES (1), (2), (3);
    -- leading comment: preserved verbatim in the binlog QUERY_EVENT
    -- clear staging
    TRUNCATE TABLE t;

    -- source: 0 rows.  target (before the fix): still 3 rows, no error, no lag.

It was found by a randomized convergence fuzzer whose 5th generated transaction happened to be a commented TRUNCATE — a shape no hand-written test corpus in the project had ever produced.

## What sluice does about it

The reader now strips leading comment prefixes (both -- line comments and /* ... */ block comments) before pattern-matching the statement, so a commented TRUNCATE is recognized and applied like any other. Postgres was never affected: pgoutput emits a typed TruncateMessage with the relation OIDs, so there is no string to parse and no comment to trip over — the immunity is a direct consequence of a typed replication protocol versus a re-parsed SQL one.

## The transferable lesson

Two lessons, both cheap to internalize. First: anything that pattern-matches SQL text out of a binlog must normalize comments (and whitespace) before matching — the binlog is not the clean statement you typed, it's the statement plus whatever the client prepended. Second: randomized differential convergence testing finds the shapes your hand-written corpus never will. A fuzzer that runs the same random workload through two implementations and diffs the targets surfaces exactly this class of &ldquo;nobody thought to write that test&rdquo; bug.

## Primary sources

- MySQL binlog event reference (QUERY_EVENT carries the statement text) — MySQL internals / binary log documentation.

- Postgres logical replication message formats (typed Truncate message) — PostgreSQL logical replication message formats.

- sluice CDC behavior across engines — How sluice copies your data.

---
Canonical page: https://sluicesync.com/docs/field-notes/binlog-comment-truncate/ · Full docs index: https://sluicesync.com/llms.txt
