<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# Type mapping

> What your MySQL TINYINT(1) / ENUM / DECIMAL / JSON / temporal types become on Postgres (and vice versa), and on SQLite / D1 — the cross-engine translation policies.

sluice never translates one dialect straight to another. Every column type maps source-dialect → typed IR → target-dialect: source-specific knowledge lives in readers, target-specific knowledge in writers, and the IR is the only shared contract. That's why the four-direction matrix needs four readers and four writers, not twelve pairwise tables. This page is the operator-facing summary of those policies; the canonical, always-current source is docs/type-mapping.md and the runtime value contract in docs/value-types.md.

## Core vs extension types

The IR type system is a two-tier hierarchy, and the tier decides what happens on an engine that lacks a type:

- Core types — integers, decimal, float, boolean, char/varchar/text, binary/blob, date/time/datetime/timestamp, JSON — are the types every relational engine has in some form. Every engine reads and writes them; they are the lingua franca.

- Extension types — ENUM, SET, UUID, arrays, PostGIS geometry, and the Postgres network types (inet/cidr/macaddr) — are types only some engines support natively. Each engine's own reader/writer type dispatch decides what it handles; an engine that lacks one either applies a documented degradation (e.g. Postgres array → MySQL JSON) or refuses loudly. Postgres extension types (hstore, citext, pgvector, PostGIS) are opt-in via --enable-pg-extension EXT and refuse loudly at schema-read if the flag is absent (SLUICE-E-SCHEMA-EXTENSION-NOT-ENABLED) — never silently dropped.

Adding a new engine never amends the core; it provides the reader/writer code, and its own type dispatch IS the declaration — a missing arm refuses loudly rather than degrading silently. The orchestrator's capability questions are strategy questions (which bulk-load method, which CDC transport, which schema scope). And since v0.119.0 the target engine is asked to dry-run its own column-type emit before any data moves, so an unrenderable column is refused up front — naming the table, column and type — instead of surfacing mid-run from the target's CREATE TABLE.

## MySQL ↔ Postgres

The most-travelled direction. Notable rows below; the full table is in the canonical doc.

MariaDB reads and writes through this same MySQL mapping. As a MySQL-family flavor it uses the mysql rows here in both directions; the divergences are all on the catalog side, not the type table — MariaDB's native uuid / inet6 / inet4 types, its per-table (not per-schema) CHECK-constraint names, a geometry SRID it stores but won't echo in SHOW CREATE, and a different COLUMN_DEFAULT dialect. The MariaDB field notes cover each.

MySQL · Postgres · Notes ·

TINYINT(1) · boolean · The MySQL boolean convention. A value outside {0,1} would collapse to true, so sluice REFUSES loudly (SLUICE-E-VALUE-TINYINT1-RANGE) at the first such value — a fail-fast preflight catches it before the copy — rather than silently carrying it. Remedy: change the source column type away from TINYINT(1) (e.g. MODIFY … SMALLINT), which works on every source; or, for a non-Vitess MySQL bulk migrate, --type-override col=smallint to keep the integer (smallint is the safe floor — a tinyint override could round-trip back to a boolean). The override does not apply on a PlanetScale/Vitess source, whose type comes from the replication wire. ·

TINYINT / SMALLINT / MEDIUMINT / INT / BIGINT · smallint / smallint / integer / integer / bigint · MEDIUMINT widens to integer on PG (no 3-byte int). Signed ranks map straight across. ·

… UNSIGNED · widens one rank · tinyint→smallint, smallint→integer, mediumint/int→bigint. bigint unsigned → bigint (uniform): PG has no unsigned 64-bit, so values in (2^63-1, 2^64-1] aren't representable — but this is the only mapping that keeps an AUTO_INCREMENT PK and its FK children type-consistent (the default Rails/Laravel/Django schema). Surfaced by a loud range-narrowing notice at schema preview / migrate preflight; override to numeric to keep the full range (then the column can't be an identity key). ·

DECIMAL(p,s) / NUMERIC · numeric(p,s) · Carried as a string end-to-end; precision is lossless. A bare Postgres numeric (no p/s) is arbitrary-precision — PG→PG round-trips it bare; PG→MySQL widens to DECIMAL(65,30) (MySQL's max) with a loud widening notice. ·

FLOAT / DOUBLE · real / double precision · Finite values ride through exactly. NaN/±Inf are Postgres-only, so PG→MySQL refuses them loudly with SLUICE-E-VALUE-UNREPRESENTABLE (MySQL has no non-finite floats) rather than coerce them; MySQL→PG never produces one. ·

CHAR(n) / VARCHAR(n) / TINY..LONGTEXT · char(n) / varchar(n) / text · A PG varchar(N) above MySQL's representable cap down-maps to the smallest MySQL TEXT-family type, with a loud advisory. Charset/collation are carried same-engine, dropped-with-WARN cross-engine (collation names aren't portable). ·

DATE / TIME(p) / DATETIME(p) / TIMESTAMP(p) · date / time(p) / timestamp(p) / timestamptz(p) · MySQL TIMESTAMP always stores UTC → PG timestamptz. A bare PG time/timestamp (no precision) round-trips bare PG→PG but materializes (6) on a MySQL target. A PG timetz → MySQL drops the zone (MySQL has no tz-aware time). Zero/partial MySQL dates (0000-00-00) are refused unless --zero-date=null|epoch (SLUICE-E-VALUE-ZERO-DATE). ·

ENUM('a','b') · enum type (default) or text + CHECK · Default emits a PG CREATE TYPE … AS ENUM; per-column override for text + a CHECK constraint. A PG enum → MySQL becomes a column-level ENUM(...) (no shared type; each column gets its own). ·

SET('a','b') · text[] + CHECK · Membership preserved via a CHECK; override to a comma-delimited text. ·

JSON · jsonb (default) / json · MySQL JSON and PG jsonb both validate + normalise; PG json (no b) preserves whitespace/key order. Carried as raw bytes. ·

(no MySQL type) · uuid · PG uuid → MySQL CHAR(36) / BINARY(16). ·

JSON (degraded) · T[] (array) · MySQL has no array type: a PG array → MySQL JSON (empty {}→[], NULL element→JSON null, nested preserved). No array-specific override exists: to land a column as parseable text instead, force it with --type-override TABLE.COL=text. Multi-dimensional arrays are pinned per element family — see the field note on the pgx codec that silently flattened numeric[][]. ·

VARCHAR(45/30) · inet / cidr / macaddr · PG network types have no MySQL native form: inet/cidr→VARCHAR(45), macaddr→VARCHAR(30) (auto-shaped since v0.7.0; overridable). ·

spatial types · geometry (PostGIS) · Requires PostGIS on the target via --enable-pg-extension; carried as WKB. Every subtype/SRID preserved. Toward MySQL: a Z/M-dimensional column refuses at preflight since v0.124.0 (MySQL 8 has no Z/M geometry — previously the copy aborted mid-run on the server's raw 1416), a 2D geography lands as planar geometry (bytes + SRID exact) with the geodesic→planar flatten surfaced as a schema preview note, and a value with NaN/Inf coordinates (incl. POINT EMPTY) refuses with SLUICE-E-VALUE-UNREPRESENTABLE. ·

### Non-ASCII text in MySQL-family DEFAULTs and expressions

Row values never pass through the catalog, so they were never affected by what follows. Schema text does: sluice builds the target's DEFAULTs, generated columns, CHECK constraints and functional indexes from the source catalog, and both MySQL's and MariaDB's information_schema render some non-ASCII text unfaithfully. sluice recovers it; where it cannot recover it faithfully, it refuses the schema read, naming the object, rather than guessing.

- A literal DEFAULT beyond the Basic Multilingual Plane (v0.156.1). Both servers store COLUMN_DEFAULT in utf8mb3, so VARCHAR(20) DEFAULT '😀x' reads back as ?x. A character default that reads back with a ? is re-read — through a DEFAULT() probe on MySQL and MariaDB, from SHOW CREATE TABLE on PlanetScale and Vitess — and must agree with the catalog text, or the read refuses; a genuine ? default stays ?. Refused rather than guessed: such a default on a non-UTF-8 column charset on PlanetScale/Vitess, and an ENUM/SET default whose label holds such a character.

- Expressions — an expression DEFAULT (…), a generated column, a CHECK, a functional index (v0.156.2, Bug 288). MySQL (and PlanetScale, Vitess) stores each string literal of an expression in the encoding its charset introducer names and renders every stored byte as a separate character, so DEFAULT ('é') read back as _utf8mb4'Ã©' and, through v0.156.1, é landed on the target as Ã© and 中 as ä¸­ — on migrate, sync cold start, restore and a forwarded ADD COLUMN, to MySQL and Postgres targets alike. sluice now undoes the widening and decodes each literal by its introducer: utf8mb4, utf8mb3 and binary bytes as UTF-8, latin1 bytes as their latin1 characters. It refuses a latin1 byte in 0x80–0x9F (MySQL's latin1 is cp1252 there — 0x80 is €), a literal in any other charset (gbk, …), and a non-ASCII literal with no introducer. The decoded expression must also agree with that object's own SHOW CREATE TABLE line, or the read refuses. MariaDB's information_schema is faithful for the BMP but writes one ? per byte for a character beyond it (an emoji became ????, on every LTS line from 10.11 to 12.3); sluice takes the SHOW CREATE TABLE text the ?s match, searched only within the object's own clause, and refuses on no match or an ambiguous one.

If you migrated or synced such a schema before v0.156.2, a non-ASCII expression DEFAULT, generated column, CHECK or functional index may be garbled on the target — and a garbled generated-column expression makes the target compute wrong values for every row. Compare each against the source's SHOW CREATE TABLE, re-declare those that differ, and recompute a generated column whose expression was wrong (a STORED column keeps its wrong values until re-declared). v0.156.1's notes said a character DEFAULT beyond the BMP reaches the target intact; that was true of literal defaults only. A mydumper dump of a MySQL source carries each expression as SHOW CREATE TABLE printed it, so a character beyond the BMP in one is already ???? in the dump and cannot be recovered from it.

## SQLite & Cloudflare D1

SQLite (and D1, which is SQLite over HTTP) is the one engine whose value storage isn't pinned by its column declaration — a column has a type affinity, and each stored value carries its own storage class. sluice resolves an IR type from the declared type in a load-bearing order: declared temporal / bool spellings win first, affinity second.

SQLite declared / affinity · IR → typical target · Notes ·

DATE / DATETIME·TIMESTAMP / TIME · date / timestamp (no tz) / time · Declared spelling overrides affinity (they'd otherwise read as NUMERIC decimals). The value encoding is an operator choice — --sqlite-date-encoding (iso default / unixepoch / unixmillis / julian); a storage-class mismatch is refused loudly, naming the row. ·

BOOL / BOOLEAN · boolean · Decodes 0/1 and truthy text; anything else is refused. ·

INTEGER affinity · bigint · SQLite integers are 64-bit signed. Integers above 253 round-trip exactly via the (typeof, text/hex) projection (the lossless live-D1 reader path). ·

TEXT affinity · text · Unbounded — declared VARCHAR(n) lengths aren't enforced by SQLite, so no misleading bound is carried. ·

REAL affinity · double precision · 8-byte IEEE-754. ·

NUMERIC affinity · unconstrained numeric · Arbitrary precision. ·

As a migrate target, SQLite emits the declared type its reader reads back to the same IR type. The one load-bearing wrinkle: an ir.Decimal is stored with TEXT affinity (the exact decimal string), not NUMERIC — NUMERIC affinity would coerce 19.99 to the binary float 19.989999999999998 and silently corrupt money (Bug 162); it reads back as text (a documented downgrade). Anything SQLite has no faithful storage for — geometry, inet/cidr/macaddr, bit, interval, array, domain — is refused loudly at emit time, never coerced to a silently-wrong column. D1 is not a write target: emit a SQLite .db (--target-driver sqlite) and wrangler d1 import it.

## Column-fidelity markers you will see in the log

Some schema facts have no spelling on the target, or have one that only some paths can use. sluice never drops one silently: each carries a grep-stable marker on a WARN line — or, where carrying on would land a wrong value, on the refusal that stops the run — so you can search a run's logs for it.

Marker · What it means ·

IDENTITY-ALWAYS-DOWNGRADED · A Postgres GENERATED ALWAYS AS IDENTITY column was created on the target as GENERATED BY DEFAULT AS IDENTITY, so the bulk copy can land the source's ids (an ALWAYS column refuses an explicit value with SQLSTATE 428C9). One WARN per run, naming every affected table.column. sync cold start, restore and chain restore keep BY DEFAULT deliberately — each hands the target to a change applier that writes explicit ids, which ALWAYS would refuse — as do a shard-consolidation and a --force-cold-start migrate, which are not the last bulk load into the table. On those paths the target accepts application-supplied ids the source rejected; the remedy after the last explicit-id write is ALTER TABLE … ALTER COLUMN … SET GENERATED ALWAYS per named column. ·

IDENTITY-ALWAYS-RESTORED · migrate restored ALWAYS after the copy and the constraints phase, on the tables it created itself this run. A table that already existed on the target (the schema preview → apply-yourself flow) is never altered and stays BY DEFAULT. ·

IDENTITY-OPTIONS-NOT-CARRIED · Toward MySQL or SQLite, neither the ALWAYS/BY DEFAULT mode nor the identity sequence's options exist; one WARN per column, and the column lands as a plain AUTO_INCREMENT / rowid alias that accepts explicit values and steps by one (MySQL: by the server's auto_increment_increment). Toward a Postgres target the options — START, INCREMENT, MINVALUE, MAXVALUE, CACHE, CYCLE — are carried exactly on every path. ·

GENERATED-VIRTUAL-PROMOTED-TO-STORED · A VIRTUAL generated column (a PostgreSQL 18 source, or a MySQL VIRTUAL column) landed STORED on the target: the invariant survives, the storage tradeoff changes. It stays VIRTUAL on a Postgres target at 18 or newer; it is promoted on an older target, and on PG 18+ for a column the source indexes (MySQL allows that; PostgreSQL 18 refuses CREATE INDEX on a virtual generated column) so the index can build. ·

INDEX-COLLATION-DROPPED · A SQLite/D1 index column's non-BINARY collation (NOCASE, RTRIM) was dropped on a Postgres or MySQL target, naming the columns. Only ever on a non-unique index, where the collation changes ordering and cost rather than which rows are legal — on a PRIMARY KEY, a UNIQUE or a constraint-backed unique the migration is refused at preflight instead, before any data moves. See Keys, indexes, and index collation. ·

INERT-FLAG · You passed a tuning flag the resolved engine pair never reads — --bulk-parallelism on a Vitess-source sync start, --max-target-connections on a SQLite/D1 target. Before ADR-0118 such a flag parsed, nothing consumed it, and you got the unchanged behaviour with no signal. One WARN naming the flag, the command, the engine it is inert on and why — with the knob that applies instead where one exists. Nothing is refused. ·

LOB-DEFAULT-NOT-CARRIED · A DEFAULT on a TEXT, BLOB, JSON or GEOMETRY column that a MySQL-family target cannot hold. Since v0.156.1 sluice carries such a DEFAULT to a MySQL 8.0.13+ (PlanetScale and Vitess included) or MariaDB target in the parenthesised form both accept — DEFAULT ('txt'), DEFAULT (X'00AB00'), DEFAULT ('{"a": 1}') — translated per value family; through v0.156.0 every such DEFAULT was dropped. What still cannot be carried — any such DEFAULT on a MySQL older than 8.0.13 or whose version could not be read, a geometry literal, an array of an unsupported element type, a bytes literal whose encoding is ambiguous — is handled by where it appears. On CREATE TABLE (migrate, a sync cold start, restore) the column is created without it and this WARN names the table, column and reason; the copied rows carry their own values, so only later inserts that omit the column are affected. A forwarded ADD COLUMN is instead refused before the target ALTER with SLUICE-E-VALUE-UNREPRESENTABLE naming this marker, because the target would fill every row it already holds with NULL where the source holds the default: add the column on the target yourself with the right value for the existing rows, then resume. ·

ENUM-LABEL-NOT-RECOVERABLE (refusal) · A MySQL, MariaDB or PlanetScale/Vitess ENUM/SET label holding a character outside the Basic Multilingual Plane (an emoji). The server keeps the label intact in the table, but every catalog surface — information_schema, SHOW CREATE TABLE, mysqldump — writes that character as ?, so the target's type is created with '?b' (a schema-read WARN says so). The copy fails loudly at the row's INSERT. CDC (sync, backup stream) names ENUM positions and SET bits through the catalog, so since v0.156.1 a row using such a label stops the stream with this marker, naming the table, column and label — through v0.156.0 it landed as '?b', silently. On a binlog source running binlog_row_metadata=FULL the true labels are read from each row event and the stream carries on; VStream always refuses. A label that genuinely is '?' on a utf8mb4/utf16/utf32 column is refused the same way. Recovery: SET PERSIST binlog_row_metadata = 'FULL' (and widen the target column or rename the labels, since the target's type still holds '?b'), rename the source labels to BMP characters, or --type-override=TABLE.COL=text. If you streamed such a column on an earlier release, compare it against the source. ·

## Per-column overrides

The default policies cover the common case; override per column in YAML (mappings:) or on the CLI. Overrides are typed against the IR, not dialect syntax:

- --type-override TABLE.COLUMN=TYPE — force a target column type (repeatable). The override rewrites the IR type the reader decodes with, so e.g. =smallint on a TINYINT(1) reads the cell as an integer end-to-end.

- --enable-pg-extension EXT — opt into a Postgres extension type (hstore, citext, vector, PostGIS) so its columns pass through instead of refusing.

- YAML mappings: entries take table:, column:, target_type:, and free-form target_type_options: (e.g. binary: true) — the file form of --type-override. Zero-date policy is the process-global --zero-date error|null|epoch flag (per-sync via the sync run fleet config's zero-date key), not a per-column mapping.

Run sluice schema preview first to see the exact target DDL sluice would emit, including every widening/narrowing advisory and any untranslatable-expression refusal — before touching the target.

---
Canonical page: https://sluicesync.com/docs/type-mapping/ · Full docs index: https://sluicesync.com/llms.txt
