# BIGINT UNSIGNED overflows both bigint and int64

> A MySQL BIGINT UNSIGNED reaches 2⁶⁴−1, past Postgres bigint's 2⁶³−1 — and past Go's int64, so above that boundary the driver hands the value back as a uint64 a []byte/string-only decoder can't route. The type mismatch is known; the driver-representation switch is the sharp edge.

Observed — migrating a MySQL BIGINT UNSIGNED column holding values above 263&minus;1 to Postgres. A value-fidelity finding from the test rig.

## What happened

A MySQL BIGINT UNSIGNED column carrying values above 2^63-1 had no working migration path to Postgres — and, worse, the loud error's recommended recovery didn't function either. This never silently lost data (it failed loudly), but it blocked a common migration and then lied about how to unblock it.

## Why (the mechanism)

Three boundaries stack up at the same value:

- The target type. BIGINT UNSIGNED reaches 2^64-1 (18,446,744,073,709,551,615); Postgres bigint tops out at 2^63-1. So above the signed max it can't be a bigint at all — it needs numeric or text.

- The driver representation (the sharp edge). Above int64's max, go-sql-driver/mysql stops returning a []byte/string and returns a uint64. The value decoder's decodeDecimal/decodeString only handled []byte/string, so even the explicit escape hatch --type-override COL=decimal|text failed with cannot decode uint64 as {Decimal|string}.

- The broken remediation. The unsigned-bigint notice told operators to use --type-override TABLE.COL=numeric — but numeric wasn't a recognized override token (only decimal is), and bare decimal defaulted to numeric(10,0), far too few digits for a 20-digit value. The documented fix pointed at a flag that didn't parse and a type too small to hold the number.

## What sluice does about it

Add uint64/int64 cases to the decimal and string decoders that carry the exact decimal text via strconv.FormatUint/FormatInt, so a BIGINT UNSIGNED migrates as an exact Postgres numeric or text value — no precision lost. And correct the remediation hint at every site it's surfaced (the notice, the schema-preview output, the doc comments) to the token that actually parses, with enough digits for the value.

## The transferable lesson

An unsigned 64-bit integer is a triple boundary: it overflows the target's signed bigint, it overflows the language's int64, and at that second overflow the driver quietly changes the Go type it hands you (uint64, not the []byte/string your decoder was built for). A migration that maps the type but never sees the over-int64max representation fails on exactly the values that justified making the column unsigned. And the meta-lesson: a loud-failure remedy is code too. If the error names a flag token that doesn't exist or a type too narrow for the value, "we refuse loudly and tell you the fix" degrades into "we refuse loudly and mislead you" — so test your remediation strings through the real parser, the same way you'd test a feature. (This is one of a family of integer-boundary hazards where the number outgrows the pipe carrying it.)

## Primary sources

- MySQL integer ranges — integer types (BIGINT UNSIGNED = 0 … 2⁶⁴&minus;1).

- Postgres numeric ranges — bigint vs numeric.

- go-sql-driver returns uint64 above int64 max — go-sql-driver/mysql.

---
Canonical page: https://sluicesync.com/field-notes/bigint-unsigned-uint64/ · Full docs index: https://sluicesync.com/llms.txt
