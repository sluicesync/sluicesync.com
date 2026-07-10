# CREATE IF NOT EXISTS is not a lock

> CREATE TABLE / TYPE … IF NOT EXISTS does a catalog pre-check and then an insert, and those two steps aren't atomic against a concurrent creation of the same name. Race it and one side gets a unique_violation on pg_class — from the statement that reads like it can't fail.

Observed — Postgres target, parallel schema build / parallel restore creating objects concurrently. Internally the catalog-race retry wrapper (control table, then the index-build path — live-caught during a parallel restore).

## What happened

Two connections ran CREATE TABLE … IF NOT EXISTS for the same name at nearly the same instant, and one of them failed with ERROR: duplicate key value violates unique constraint "pg_class_relname_nsp_index" (SQLSTATE 23505). From the statement whose entire purpose is to be a safe no-op when the object already exists.

## Why (the mechanism)

IF NOT EXISTS is not a lock and not atomic. It is a two-step operation: check the system catalog (pg_class for a relation, pg_type for a type) for the name, and if absent, insert the catalog row. Two sessions can both pass the "absent" check before either inserts, and then the second insert collides on the catalog's own unique index — pg_class_relname_nsp_index for a table/index, pg_type_typname_nsp_index for a type — surfacing as SQLSTATE 23505 unique_violation. The guard reads like idempotence; under concurrency it is a check-then-act race, and Postgres enforces name uniqueness at the catalog layer regardless of the friendly clause.

## The repro

    -- two psql sessions, interleaved:
    -- session A                         -- session B
    BEGIN;
                                         BEGIN;
    CREATE TABLE IF NOT EXISTS t (id int);
                                         CREATE TABLE IF NOT EXISTS t (id int);
    COMMIT;                              -- blocks on A, then:
                                         -- ERROR: duplicate key value violates
                                         --   unique constraint
                                         --   "pg_class_relname_nsp_index" (23505)

## What sluice does about it

sluice retries the failing statement — but only on the narrow, provably-benign shape: a 23505 whose constraint is a catalog index (pg_class_relname_nsp_index / pg_type_typname_nsp_index), which means "someone else just created this exact object" and the correct outcome (the object exists) has been reached. A 23505 on a user table's primary key or unique constraint is a genuine data conflict and stays loud — never swallowed by the retry. The same wrapper covers both the control-table setup and the concurrent index-build path.

## The transferable lesson

IF NOT EXISTS (and CREATE OR REPLACE, and most "make it exist" DDL) is a convenience, not a concurrency primitive — it removes the error when you ran it twice in sequence, not when two workers run it at once. If your tool issues DDL in parallel, treat a catalog 23505 as an expected, retryable outcome of the race, and scope the retry tightly to the catalog constraint so a real user-data uniqueness violation still fails loudly. The tell that you have this bug is a "can't happen" duplicate-key error on a statement you thought was idempotent.

## Primary sources

- Postgres on the non-atomicity of IF NOT EXISTS — CREATE TABLE (the IF NOT EXISTS note) and the error-code appendix (23505 unique_violation).

- The system catalogs that enforce name uniqueness — pg_class / pg_type.

---
Canonical page: https://sluicesync.com/field-notes/create-if-not-exists-race/ · Full docs index: https://sluicesync.com/llms.txt
