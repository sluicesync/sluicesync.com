# MariaDB accepts a geometry SRID it won't show you

> Declare POINT REF_SYSTEM_ID=4326 and MariaDB really stores the SRID — but SHOW CREATE TABLE drops the attribute and echoes a bare `point DEFAULT NULL`, and unlike MySQL 8 there is no srs_id column in information_schema.COLUMNS. Parse the SRID the documented way and every geometry column silently reads back as SRID 0. The declared value lives only in the OGC-standard GEOMETRY_COLUMNS view.

Observed — adding geometry support to sluice's MariaDB reader (v0.99.270, ADR-0169), on the mandatory live read-back the discipline requires. A geometry(POINT, 4326) column written and read straight back came out as SRID 0.

## The attribute SHOW CREATE TABLE drops

You declare a column p POINT REF_SYSTEM_ID=4326 on a MariaDB table, and the SRID is genuinely stored. But MariaDB will not hand it back the way you would expect. SHOW CREATE TABLE echoes the column as a bare &#96;p&#96; point DEFAULT NULL — the REF_SYSTEM_ID attribute is simply gone from the round-trip. The intuitive, documented plan — parse the SRID out of SHOW CREATE TABLE — therefore reads back SRID 0 on every geometry column, silently.

And unlike MySQL 8, there is no fallback in the column catalog: MariaDB has no srs_id column in information_schema.COLUMNS. The place MySQL 8 stores the per-column SRID does not exist here.

## Why the loss is quiet

The drop inserts and queries without complaint, because MariaDB does not enforce a declared column SRID anyway — a value with a different SRID inserts fine, and ST_SRID is a property of each value, not of the column. So nothing downstream objects to a column that reads back as SRID 0. A spatial-reference identifier that silently degrades to 0 is exactly the kind of value-fidelity loss that never trips an error and never shows up in a row count.

## Where the SRID actually lives

The declared column SRID is recorded — just in the OGC-standard information_schema.GEOMETRY_COLUMNS view, keyed by schema, table, and column, in its SRID field (present and correct on both 11.4 and 10.11). Read it from there and write it back as MariaDB's REF_SYSTEM_ID=<n> type attribute (the grammar requires that attribute before NOT NULL), and a geometry(POINT, 4326) column round-trips its SRID in both directions.

## The transferable lesson

On MariaDB, the catalog surface that echoes a spatial reference and the one that stores it are different objects, and the intuitive one omits it. The only reason this did not ship as a silent SRID-to-0 loss is that the mandatory live read-back — write a known SRID, read it straight back, assert it survived — caught it exactly where a self-consistent fixture would have been blind. When a catalog attribute round-trips through SHOW CREATE, verify it against an independent view before trusting it; a value that inserts without complaint is not the same as a value that was preserved.

## Primary sources

- sluice ADR-0169 (MariaDB flavor Phase 2 — geometry SRID recovery) and CHANGELOG 0.99.270; live read-back on mariadb:11.4 and mariadb:10.11.

- MariaDB Knowledge Base — geometry column definitions (REF_SYSTEM_ID) and the OGC GEOMETRY_COLUMNS table; SRID is per-value (ST_SRID), not enforced per column.

- MySQL 8.0 Reference Manual — information_schema.COLUMNS.SRS_ID (the per-column SRID column MariaDB lacks).

---
Canonical page: https://sluicesync.com/field-notes/mariadb-geometry-srid-hidden/ · Full docs index: https://sluicesync.com/llms.txt
