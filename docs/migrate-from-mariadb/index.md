# Migrating from MariaDB with sluice

> MariaDB is a first-class MySQL-family source engine — use the mariadb driver, not mysql. Bulk migrate to vanilla MySQL or PlanetScale round-trips cleanly (validated live); the divergences are all on the catalog and CDC side — a different COLUMN_DEFAULT dialect, per-table CHECK-constraint names, a geometry SRID it stores but won't echo, native uuid/inet types, domain-based GTIDs for continuous sync, and MariaDB 11.4's new default collation that remaps on a MySQL target.

MariaDB works with sluice's mariadb engine — a MySQL-family flavor that shares vanilla MySQL's reader, decoder, type mapping, and binlog/loader path. A one-time sluice migrate from MariaDB into a MySQL-family target was validated live (2026-07-17): MariaDB 11.4 → vanilla MySQL 8.4 and MariaDB 11.4 → PlanetScale (MySQL), both completing all seven tables with a clean verify --depth count and byte-identical values on the representative rows. Everything that makes MariaDB not vanilla MySQL is on the catalog and CDC side — this guide is that list.

Use the mariadb driver name, not mysql. sluice fingerprints the server and steers you if the two are mismatched. The mariadb flavor exists precisely so the catalog-reading and CDC divergences below are handled correctly; pointing the vanilla mysql reader at a MariaDB server would misread its defaults and constraint catalog. Its migrate behavior matches the mysql engine cell-for-cell — see Supported directions.

## Source DSN + driver

MariaDB uses the same Go MySQL DSN grammar as vanilla MySQL — user:pass@tcp(host:3306)/db, with ?tls=true (or --source-tls-ca <pem>) for an encrypted connection. Pick the target driver by where you're landing the data: mysql for self-hosted or managed vanilla MySQL, planetscale for PlanetScale MySQL. A dry run confirms the plan and the connection before anything writes:

    # MariaDB → vanilla MySQL
    sluice migrate \
        --source-driver mariadb --source 'app:pass@tcp(mariadb-host:3306)/app' \
        --target-driver mysql   --target 'root:pass@tcp(mysql-host:3306)/app' \
        --dry-run

    # MariaDB → PlanetScale (MySQL)
    sluice migrate \
        --source-driver mariadb     --source 'app:pass@tcp(mariadb-host:3306)/app' \
        --target-driver planetscale --target 'USER:PASS@tcp(aws.connect.psdb.cloud:3306)/mydb?tls=true'

Everything below is target-agnostic unless a heading says otherwise — the vanilla-MySQL and PlanetScale runs produced identical target schemas and values.

## MariaDB 11.4's default collation remaps (the most visible WARN)

MariaDB 11.4 changed its default collation to utf8mb4_uca1400_ai_ci (UCA 14.0.0). That collation does not exist on a MySQL 8 server family, so on a MySQL or PlanetScale target sluice maps each affected string column to the closest equivalent — utf8mb4_0900_ai_ci — and emits a per-column WARN naming the remap. This fires on essentially every VARCHAR/TEXT column of an 11.4 source, so expect a run of them; it is the single most common MariaDB-specific line in the log:

    WARN mysql: column data is preserved; some source collations do not exist on this
         target's server family, so the closest equivalent is used (edge-case sort/comparison
         order may differ — UCA version and PAD semantics)
         table=customers columns="email (utf8mb4_uca1400_ai_ci → utf8mb4_0900_ai_ci)"

Column data is preserved — the WARN is about sort/comparison semantics, not bytes. UCA 14.0.0 and UCA 9.0.0 order a handful of scripts differently and have different PAD semantics, so a rarely-material edge case is index/ORDER-BY ordering of exotic strings. If exact collation ordering matters to your application, review the affected columns; for the common case the closest-equivalent mapping is correct and lossless. Why this fires on nearly every column, and when it actually matters: MariaDB 11.4's default collation doesn't exist on MySQL 8.

## JSON columns and the CHECK-constraint fan-out

MariaDB has no distinct JSON storage type: a JSON column is stored as LONGTEXT plus an auto-generated CHECK (json_valid(<col>)) constraint named after the column. MariaDB's constraint names are unique per table, not per schema — so two tables that each have a meta JSON column both carry a CHECK named meta. A catalog join that is provably 1:1 on MySQL 8 fans out to a cartesian product on MariaDB, which historically could emit a duplicate CHECK and fail CREATE TABLE.

The validation exercised exactly this shape — two tables (orders, customers) each with a meta JSON column, both source CHECKs named meta — and it migrated cleanly: on the MySQL-family target each JSON column lands as a native json type (the json_valid check is subsumed by the native type), no duplicate CHECK is emitted, and there is no fan-out. The mechanics of why the fix can't be symmetric (MySQL 8's CHECK_CONSTRAINTS has no TABLE_NAME column to join on) are in the field note: the join that's 1:1 on MySQL 8 and fans out on MariaDB.

## Geometry: the SRID it stores but won't show you

Declare POINT REF_SYSTEM_ID=4326 and MariaDB stores the SRID — but SHOW CREATE TABLE echoes the column as a bare point DEFAULT NULL, and unlike MySQL 8 there is no srs_id catalog column. The declared value lives only in the OGC-standard information_schema.GEOMETRY_COLUMNS view, which is where sluice reads it. In the validation the target places.geom came back as point /*!80003 SRID 4326 */ with SRS_ID = 4326 — the SRID is carried, not silently reset to 0. Background: MariaDB accepts a geometry SRID it won't show you.

Verify geometry with ST_Latitude/ST_Longitude, not a raw ST_AsText diff. MariaDB stores an SRID-4326 point in long-lat order and its ST_AsText prints long-lat; MySQL 8 honors the EPSG:4326 lat-long axis order and prints lat-long by default. So a point that reads POINT(-122.4194 37.7749) on the MariaDB source reads POINT(37.7749 -122.4194) on the MySQL target — the coordinates look swapped, but the geographic location is identical: ST_Latitude/ST_Longitude on the target match the source exactly, and ST_AsText(geom, 'axis-order=long-lat') reproduces the source string. This is an engine axis-order convention difference, not data loss — but a naive text comparison will flag a false mismatch. The full mechanism (sluice moves the WKB byte-faithful; only the engines' output rendering defaults differ): MariaDB and MySQL 8 disagree on which coordinate comes first.

## Native uuid / inet types

MariaDB has native uuid, inet6, and inet4 column types. Under a bulk migrate they round-trip cleanly — the driver hands them back as formatted text, so uuid lands as char(36) and inet6/inet4 as varchar(45) on the target, with byte-identical values (verified in the run: every UUID and IP string matched source to target). &ldquo;It migrated fine&rdquo; is a statement about the bulk path only — under continuous CDC these same columns travel as their raw storage bytes, a different code path. sluice decodes them faithfully through CDC as of v0.99.272 (canonical big-endian UUID, length-prefixed with trailing 0x00 stripped, BSD inet_ntop6 text); the history of why this is a separate hazard from migrate is in the type that migrates clean and corrupts under CDC.

## The COLUMN_DEFAULT dialect

MariaDB's information_schema reports column defaults in a different dialect than MySQL 8: string defaults keep their quotes, a defaultless nullable column's default is the literal word NULL, and DEFAULT CURRENT_TIMESTAMP reads as current_timestamp() with an empty extra. A reader written to MySQL conventions would silently corrupt every default; the mariadb flavor reads them correctly (in the run, DEFAULT CURRENT_TIMESTAMP, DEFAULT 'unnamed', and defaultless-nullable columns all reproduced on the target). The same dialect note also covers why SYSTEM VERSIONED tables and SEQUENCEs hide from the BASE TABLE filter: MariaDB reports its defaults in a different dialect.

## Landing on PlanetScale

Nothing about the MariaDB source changes when the target is PlanetScale — the target-side behavior is the standard PlanetScale copy path, which differs from vanilla MySQL in a few ways worth expecting:

- Batched / interpolated INSERT, not LOAD DATA — PlanetScale (a Vitess flavor) uses client-side parameter interpolation for the copy; sluice logs the write path at start.

- Connection-budget capping — copy parallelism is auto-capped to the tier's connection budget (in the run, effective copy budget of 2 against a PS-10), and sluice notes that a PlanetScale target is tier-CPU-bound, not connection-bound (ADR-0116): a larger tier or Metal is the real throughput lever, not more parallelism.

- Foreign keys — if your MariaDB schema has FK constraints, enable &ldquo;Allow foreign key constraints&rdquo; on the PlanetScale database before migrating (the test schema had none, so no toggle was needed). See Foreign keys on Vitess.

- A plain migrate applies DDL directly — no deploy-request / safe-migrations interaction on the branch you point at.

## Verifying the migration

sluice treats mariadb and mysql/planetscale as distinct engines, so cross-engine content-hash verification (--depth sample) is not yet available for MariaDB → MySQL-family — it refuses loudly and steers you to count mode rather than half-checking:

    sluice verify \
        --source-driver mariadb --source 'app:pass@tcp(mariadb-host:3306)/app' \
        --target-driver mysql   --target 'root:pass@tcp(mysql-host:3306)/app' \
        --depth count
    # → 7 table(s) checked, 7 clean, 0 mismatched, 0 could not be verified

--depth count is the cross-engine verification path and passed clean in both runs. For content-level confirmation of the MariaDB-specific columns, spot-check them directly on the target — the geometry note above is the one place a naive comparison misleads.

## Continuous sync: domain-based GTIDs

For a zero-downtime cutover (snapshot → CDC → cutover) rather than a one-time copy, a MariaDB source streams its native binlog, but MariaDB's GTIDs are domain-based (e.g. 0-100-38) — a distinct format from MySQL's GTIDs, and sluice parses and resumes off them (since v0.99.271). Two MariaDB CDC realities to plan around, both covered in MariaDB has no BEGIN, and won't tell you if your position survived: a MariaDB transaction opens with a MariadbGTIDEvent and no BEGIN event, and you cannot pre-check whether a stored position is still reachable — @@gtid_binlog_state is unchanged across PURGE BINARY LOGS, so a dead position looks live and the stream throwing error 1236 is the only honest signal. The native uuid/inet columns decode faithfully through this path (v0.99.272).

## What sluice checks for you

- Engine fingerprint steering — pointing the mysql driver at a MariaDB server (or vice-versa) is caught and steered, so the catalog-reading divergences are always handled by the right flavor.

- The collation-remap WARN — every string column whose source collation has no target-family equivalent is announced with the exact from → to mapping, never silently changed.

- No CHECK fan-out — MariaDB's per-table CHECK-constraint names are read per-table, so same-named auto-CHECKs on JSON columns across tables don't collide into a duplicate-constraint CREATE TABLE failure.

- Geometry SRID carried from GEOMETRY_COLUMNS — the SRID that SHOW CREATE omits is read from the OGC catalog view, so it isn't silently reset to 0.

- Faithful native-type CDC decode — uuid/inet6/inet4 decode from their raw binlog bytes rather than being stringified into a wrong value a MySQL-family target would silently accept.

- Cross-engine sample refusal — verify --depth sample refuses across the MariaDB/MySQL engine boundary instead of returning a misleading partial result; --depth count is the supported path.

## Next steps

- Zero-downtime migration — the full snapshot → CDC → verify → cutover flow, once the domain-GTID stream is running.

- Self-hosted MySQL → PlanetScale — the PlanetScale target path in depth (the MariaDB source slots into the same recipe).

- MariaDB field notes — the five catalog/CDC divergences, each with the ground truth behind it.

- Verify & reconcile — count-mode verification and what to do when it flags a delta.

---
Canonical page: https://sluicesync.com/docs/migrate-from-mariadb/ · Full docs index: https://sluicesync.com/llms.txt
