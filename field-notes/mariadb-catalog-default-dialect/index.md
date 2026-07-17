# MariaDB reports its defaults in a different dialect

> "MariaDB is basically MySQL" survives the wire protocol and dies in information_schema. Point the same DDL at both and COLUMN_DEFAULT speaks two dialects: MySQL 8 reports a string default as bare abc, MariaDB reports 'abc' with the quotes; a defaultless nullable column is SQL NULL on MySQL and the four-character string NULL on MariaDB; DEFAULT CURRENT_TIMESTAMP reads as current_timestamp() with an empty extra. A MySQL-convention reader emits corrupted defaults — and MariaDB's SYSTEM VERSIONED tables and SEQUENCEs vanish behind the near-universal table_type='BASE TABLE' filter.

Observed — scoping the mariadb flavor for sluice, side by side on mariadb:11.4, mariadb:10.11, and mysql:8.4 (2026-07-16); the flavor shipped in v0.99.268 (ADR-0168). Before the flavor existed, every MariaDB-source operation failed loudly on one MySQL-8-only catalog column, so no silent-loss path was ever reachable in a released version — and the shim that keeps it that way had to land the same instant that protective wall came down.

## The defaults table speaks a different dialect

MariaDB and MySQL 8 share a wire protocol, most of information_schema, and almost all DDL. They do not share how COLUMNS.COLUMN_DEFAULT renders a default. On identical DDL:

                            MySQL 8                       MariaDB
    DEFAULT 'abc'           abc                           'abc'         (quotes kept)
    nullable, no default    NULL (SQL NULL)               NULL          (the 4-char string)
    DEFAULT CURRENT_TIMESTAMP  CURRENT_TIMESTAMP          current_timestamp()
       extra                   DEFAULT_GENERATED          (empty)

A reader written to MySQL 8's conventions, pointed at MariaDB, therefore: emits string defaults with literal embedded quotes; gives every defaultless nullable column the literal word NULL as its default (silent on a text target, which happily stores the string &ldquo;NULL&rdquo;); and turns the timestamp expression into the string 'current_timestamp()' — loud 1067 Invalid default value on a datetime column, silent on a varchar. That is a silent default-corruption class hiding entirely behind the &ldquo;basically MySQL&rdquo; assumption.

## The tables your BASE-TABLE filter can't see

The second silent class is enumeration. MariaDB reports SYSTEM VERSIONED (temporal) tables and SEQUENCE objects as distinct table_type values, so the near-universal table_type = 'BASE TABLE' filter — the one every &ldquo;list the tables to copy&rdquo; query uses — silently skips data-bearing objects. It is the same class as an unguarded enumerate-and-copy missing old-style inheritance parents or foreign tables on Postgres: the filter that looks like a safe way to exclude views quietly excludes real data. And MariaDB's JSON is a longtext alias whose type identity survives only in an auto-generated json_valid(<col>) CHECK constraint — so even &ldquo;is this column JSON?&rdquo; has a MariaDB-specific answer.

## The wall that was accidentally protective

Here is the ironic part. Before the flavor shipped, every one of those corruptions was unreachable — because one MySQL-8.0-only catalog column that sluice's reader selected (columns.srs_id, absent on MariaDB) made every MariaDB-source operation fail loudly, up front, before any default or table-type could be mis-read. The error wall was accidentally protecting users from the dialect gap behind it. Which is exactly why &ldquo;just fix the failing query&rdquo; was the dangerous patch: removing the wall without simultaneously handling the defaults dialect and the invisible objects would have converted a loud failure into the silent corruptions above.

## What sluice does about it

The v0.99.268 mariadb flavor landed the catalog-query fix and the compensating shim atomically — the discipline the scoping work flagged as mandatory. translateMariaDBDefault normalizes every default shape (quoted string literals with '' doubling and the \0 \n \r \\ schema-metadata escape set, including NUL-bearing binary defaults re-encoded to MySQL's 0x… hex; the bare keyword NULL for defaultless-nullable; current_timestamp()-with-empty-extra canonicalized) to a byte-identical IR read. The invisible-object census now refuses loudly, naming every SYSTEM VERSIONED table and SEQUENCE rather than skipping it. The two MySQL-8-only columns select constants on the MariaDB variant. A server-fingerprint guard closes the last hole in both directions: the mariadb flavor refuses a non-MariaDB server (the shim would actively mis-read MySQL's bare abc defaults as expressions — coded SLUICE-E-DRIVER-HOST-MISMATCH), while a plain mysql connection whose VERSION() carries -MariaDB WARNs toward the mariadb driver.

## The transferable lesson

&ldquo;Compatible&rdquo; databases diverge exactly where you stop looking — not in the wire protocol you tested, but in how information_schema renders a default or classifies a table. When you port a catalog reader to a claimed-compatible engine, diff the metadata output on identical DDL rather than trusting the compatibility label. And when a query is failing loudly on the new engine, treat that failure as possibly load-bearing: it may be the only thing standing between your users and a silent-corruption class behind it, so the fix that removes the wall and the shim that handles what the wall was hiding must ship in the same change, never one without the other.

## Primary sources

- sluice ADR-0168 (MariaDB flavor Phase 1) and CHANGELOG 0.99.268; the scoping probe on mariadb:11.4, mariadb:10.11, and mysql:8.4.

- MariaDB Knowledge Base — information_schema.COLUMNS (COLUMN_DEFAULT quoting and the NULL-string convention), system-versioned tables and sequences (TABLE_TYPE), and the implicit json_valid() CHECK on JSON columns.

- MySQL 8.0 Reference Manual — information_schema.COLUMNS (bare default rendering, DEFAULT_GENERATED extra) and SRS_ID.

- Related field notes — the parent table that returns rows it doesn't own (the BASE-TABLE-filter miss on Postgres) and the join that's 1:1 on MySQL 8 and fans out on MariaDB (more MariaDB catalog divergence).

---
Canonical page: https://sluicesync.com/field-notes/mariadb-catalog-default-dialect/ · Full docs index: https://sluicesync.com/llms.txt
