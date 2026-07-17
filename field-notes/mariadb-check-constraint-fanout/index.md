# The join that's 1:1 on MySQL 8 and fans out on MariaDB

> MariaDB has no distinct JSON storage type — a JSON column is LONGTEXT plus an auto-generated CHECK named after the column — and its constraint names are unique per table, not per schema. A catalog join that is provably 1:1 on MySQL 8 becomes a cartesian fan-out on MariaDB, and because JSON columns are named after their column it fires for the most ordinary schema imaginable: two tables that each have a `meta` JSON column. The fix cannot be symmetric, because MySQL 8's CHECK_CONSTRAINTS has no TABLE_NAME column to join on.

Observed — adding MariaDB type fidelity to sluice's schema reader (v0.99.270, ADR-0169, tracked as Bug 198), ground-truthed live on mariadb:11.4 and mariadb:10.11. It surfaced not on an exotic schema but on the plainest one: two tables, each with a JSON column of the same name.

## JSON is a CHECK, named after the column

MariaDB has no distinct JSON storage type. A column declared JSON is stored as LONGTEXT with an auto-generated constraint — a CHECK whose expression is exactly json_valid(<col>) and whose name is the column name. Declare meta JSON and you get a longtext column plus a CHECK named meta. That is the first surprise, and on its own it is harmless — sluice reads the column back as textual JSON and strips the MariaDB-internal auto-CHECK from the IR so it is not re-emitted as an invalid json_valid() CHECK on a Postgres target (a user-authored CHECK on the same column is preserved).

## The uniqueness scope nobody advertises

The second surprise is a catalog convention that differs between two engines sharing a wire protocol: MariaDB constraint names are unique per table; MySQL 8's are unique per schema. So two tables in one MariaDB database can each carry a constraint named meta — and because a JSON column's auto-CHECK is named after the column, they routinely do.

sluice's reader joined information_schema.check_constraints to table_constraints on (constraint_schema, constraint_name) to recover each CHECK's expression. On MySQL 8 that pair is a key, so the join is 1:1. On MariaDB it is not: any two tables sharing a constraint name make the join fan out, each table picking up every same-named CHECK once per sharing table — and cross-contaminating, so table a captures table b's CHECK too. The emitted CREATE TABLE then carries duplicate CHECKs and is refused loudly at creation, before any row is copied:

    Error 1826 (HY000): Duplicate CHECK constraint name 'meta'   -- MySQL / MariaDB target
    SQLSTATE 42710: constraint "meta" ... already exists            -- Postgres target

This is a loud failure, not silent loss — but it blocks migrate and backup/restore of an entirely ordinary schema. A single-table database does not reproduce it; you need two tables sharing a name, which JSON columns named meta, data, or payload hand you for free.

## Why the fix can't be symmetric

The obvious repair is to add table_name to the join predicate. It works on MariaDB. It does not compile on MySQL 8: information_schema.CHECK_CONSTRAINTS on MySQL 8 has no TABLE_NAME column at all — referencing it is a hard SQL error, not an empty result (live-verified; MariaDB's CHECK_CONSTRAINTS does carry it). So the corrected join has to be flavor-gated: MariaDB gets the extra cc.table_name = tc.table_name predicate, and the MySQL-8 query is left exactly as it was.

## The transferable lesson

Constraint-name uniqueness scope is a catalog convention, not a protocol guarantee — and it differs between engines that otherwise speak the same wire protocol and share most of information_schema. A query that is provably 1:1 on one is a cartesian product on the other, and the failure hides behind the most ordinary column name in your schema. When you port a metadata query across a MySQL-family flavor, re-derive the join's cardinality against the actual catalog, and expect the corrected version to be asymmetric: the columns you need to disambiguate on one engine may not exist on the other.

## Primary sources

- sluice ADR-0169 (MariaDB flavor Phase 2 — JSON identity and the check-constraint join fan-out) and CHANGELOG 0.99.270; live read-back on mariadb:11.4 and mariadb:10.11.

- MariaDB Knowledge Base — CHECK constraints (per-table name scope; the implicit json_valid() constraint on JSON columns) and information_schema.CHECK_CONSTRAINTS (which carries TABLE_NAME).

- MySQL 8.0 Reference Manual — information_schema.CHECK_CONSTRAINTS (schema-scoped names; no TABLE_NAME column).

---
Canonical page: https://sluicesync.com/field-notes/mariadb-check-constraint-fanout/ · Full docs index: https://sluicesync.com/llms.txt
