# Type mapping

> What your MySQL TINYINT(1) / ENUM / DECIMAL / JSON / temporal types become on Postgres (and vice versa), and on SQLite / D1 — the cross-engine translation policies.

sluice never translates one dialect straight to another. Every column type maps source-dialect → typed IR → target-dialect: source-specific knowledge lives in readers, target-specific knowledge in writers, and the IR is the only shared contract. That's why the four-direction matrix needs four readers and four writers, not twelve pairwise tables. This page is the operator-facing summary of those policies; the canonical, always-current source is docs/type-mapping.md and the runtime value contract in docs/value-types.md.

## Core vs extension types

The IR type system is a two-tier hierarchy, and the tier decides what happens on an engine that lacks a type:

- Core types — integers, decimal, float, boolean, char/varchar/text, binary/blob, date/time/datetime/timestamp, JSON — are the types every relational engine has in some form. Every engine reads and writes them; they are the lingua franca.

- Extension types — ENUM, SET, UUID, arrays, PostGIS geometry, and the Postgres network types (inet/cidr/macaddr) — are types only some engines support natively. Each engine declares which it handles; an engine that lacks one either applies a documented degradation (e.g. Postgres array → MySQL JSON) or refuses loudly. Postgres extension types (hstore, citext, pgvector, PostGIS) are opt-in via --enable-pg-extension EXT and refuse loudly at schema-read if the flag is absent (SLUICE-E-SCHEMA-EXTENSION-NOT-ENABLED) — never silently dropped.

Adding a new engine never amends the core; it declares which extension types it supports and provides the reader/writer code. The orchestrator never asks "are you MySQL?" — it asks "do you support arrays?"

## MySQL ↔ Postgres

The most-travelled direction. Notable rows below; the full table is in the canonical doc.

MySQL · Postgres · Notes ·

TINYINT(1) · boolean · The MySQL boolean convention. A value outside {0,1} collapses to true; sluice WARNs loudly once per column and names the row. Override with --type-override col=smallint to keep the integer (smallint is the safe floor — a tinyint override could round-trip back to a boolean). ·

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

JSON (degraded) · T[] (array) · MySQL has no array type: a PG array → MySQL JSON (empty {}→[], NULL element→JSON null, nested preserved). Override array_strategy: concat for simple scalar arrays. Multi-dimensional arrays are pinned per element family — see the field note on the pgx codec that silently flattened numeric[][]. ·

VARCHAR(45/30) · inet / cidr / macaddr · PG network types have no MySQL native form: inet/cidr→VARCHAR(45), macaddr→VARCHAR(30) (auto-shaped since v0.7.0; overridable). ·

spatial types · geometry (PostGIS) · Requires PostGIS on the target via --enable-pg-extension; carried as WKB. Every subtype/SRID preserved. ·

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

## Per-column overrides

The default policies cover the common case; override per column in YAML (mappings:) or on the CLI. Overrides are typed against the IR, not dialect syntax:

- --type-override TABLE.COLUMN=TYPE — force a target column type (repeatable). The override rewrites the IR type the reader decodes with, so e.g. =smallint on a TINYINT(1) reads the cell as an integer end-to-end.

- --enable-pg-extension EXT — opt into a Postgres extension type (hstore, citext, vector, PostGIS) so its columns pass through instead of refusing.

- YAML mappings: entries also carry enum_strategy, array_strategy, on_zero_date, and per-column target_type options.

Run sluice schema preview first to see the exact target DDL sluice would emit, including every widening/narrowing advisory and any untranslatable-expression refusal — before touching the target.

---
Canonical page: https://sluicesync.com/docs/type-mapping/ · Full docs index: https://sluicesync.com/llms.txt
