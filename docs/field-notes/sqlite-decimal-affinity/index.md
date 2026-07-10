# SQLite's DECIMAL is a suggestion: 19.99, stored as 19.989999999999998

> SQLite doesn't have column types; it has affinities. Declare DECIMAL(10,2) and you get NUMERIC affinity, which stores any non-integer as a float64 — so 19.99 lands as 19.989999999999998 on disk. Not a rounding bug: an engine storage property.

Observed — SQLite as a migrate target (writer) and as a source (reader). Internally Bug 162 (CRITICAL silent corruption, target side, fixed v0.99.147) and Bug 163 (loud COPY abort, source side, fixed v0.99.150).

## What happened

Migrating an ordinary money column into a SQLite target, a decimal 19.99 landed on disk as 19.989999999999998 — exit 0, no warning. The produced .db is the whole deliverable of that path (the documented flow is X → SQLite → Cloudflare D1 via wrangler d1 import), so the corrupted value is exactly what the next consumer reads. This wasn't a sluice rounding bug; it was SQLite storing the value as a binary float because of how its type system works.

## Why (the mechanism)

SQLite doesn't have column types — it has affinities. A column declared DECIMAL(10,2) (or NUMERIC) carries NUMERIC affinity, and SQLite coerces any non-integer inserted value to REAL — a float64 — on store. The first guard against this checked the wrong predicate: it refused values "beyond ~15 significant digits," on the theory that precision loss is about digit count. But float64 inexactness is not about significant digits; it is about dyadic representability — whether the value is a finite base-2 fraction. 19.99 = 1999/100 has a denominator that isn't a power of two, so it is not exactly representable in float64 despite having only four significant digits, and it slipped straight past the >15-digit guard. Essentially every real-world money value (19.99, 5.10, 0.10) is non-dyadic, so essentially every money value was silently floated. Integer-valued decimals (100.00 → INTEGER 100) and the rare dyadic value stored exactly, which is why spot checks missed it.

The reader direction has its own trap. SQLite renders a stored REAL back with Go's strconv.FormatFloat(v, 'g', -1, 64), and the 'g' verb flips to exponent notation at magnitude &ge; 106 (or < 10-4). So a perfectly ordinary 1000000.00 renders as "1e+06" — and pgx's binary numeric (OID 1700) COPY encoder cannot find an encode plan for an exponent-notation string, so the migration aborts:

    ERROR: unable to encode "1e-10" into binary format for numeric (OID 1700):
           cannot find encode plan (SQLSTATE 57014)

An entirely ordinary $1,000,000.00 in a SQLite DECIMAL column was enough to abort a SQLite → Postgres migrate.

## The repro

    -- WRITER side: what a "DECIMAL" SQLite target actually stores
    CREATE TABLE m (id INTEGER PRIMARY KEY, price DECIMAL(10,2));
    INSERT INTO m VALUES (1, 19.99), (2, 5.10), (3, 100.00);
    SELECT id, typeof(price), price FROM m;
    --  1 | real    | 19.989999999999998   <- non-dyadic, silently floated
    --  2 | real    | 5.0999999999999996
    --  3 | integer | 100                  <- integer-valued: exact

    -- READER side: 'g'-verb exponent rendering aborts a binary numeric COPY
    INSERT INTO m VALUES (4, 1000000.00);   -- typeof -> real
    --  Go's FormatFloat(..., 'g', ...) renders 1e+06 -> pgx numeric COPY: SQLSTATE 57014

## What sluice does about it

Two fixes for one engine property. The writer now stores decimal/numeric columns as TEXT affinity by default, so the value is preserved byte-exact (19.99 stays '19.99') and sluice's own reader decodes TEXT → decimal cleanly — this also keeps the value wrangler d1 import-safe. The reader now renders floats with the 'f' verb instead of 'g', so 1000000 renders as plain digits that pgx's numeric encoder accepts. The change of predicate is the real lesson: the guard moved from "significant-digit count" to "not exactly representable in float64."

## The transferable lesson

If you produce .db files for anyone — or consume them — a declared column type in SQLite tells you almost nothing; check typeof() on the actual stored value. And when you reason about float precision, the predicate is dyadic representability, not significant-digit count: 19.99 at four digits is lossy while some 17-digit values are exact, because base-2 can only finitely represent fractions whose denominator is a power of two. A guard written against "big numbers" will wave through every ordinary price.

## Primary sources

- SQLite type affinity — datatypes in SQLite (§3, type affinity).

- sluice type mapping for SQLite / D1 — type mapping.

- Go strconv.FormatFloat — the 'f' vs 'g' verbs (exponent switch-over).

- The dyadic-rational boundary — IEEE-754 double-precision format.

---
Canonical page: https://sluicesync.com/docs/field-notes/sqlite-decimal-affinity/ · Full docs index: https://sluicesync.com/llms.txt
