# 2^53 is a database boundary now

> JSON has one number type, and it's a double. That single fact produced two independent silent-corruption incidents in one week — one in third-party tooling, one in our own decoder.

Observed — a D1-to-Postgres head-to-head (2026-06-30) and sluice's incremental-backup decoder. Internally Bug 172 (fixed v0.99.159).

## What happened

JSON's only numeric type is an IEEE-754 double, which represents integers exactly only up to 253 (9,007,199,254,740,992). Any integer path that passes through a JSON number above that boundary can round silently. In one week that bit us twice, from two completely different directions.

- Third-party tooling. In a ~5 GB Cloudflare D1 → Postgres head-to-head, a competing importer that consumes wrangler d1 export silently corrupted 50% (625,000 of 1,250,000) of the >253 integer test values — every odd value above the boundary landed off by one — because wrangler d1 export serializes integers as JSON numbers and rounds them through float64 before any database sees them. sluice's D1 reader was exact on the same corpus (0 corrupted) because it projects each integer through a lossless (typeof, CAST(... AS TEXT)) path instead of a JSON number.

- Our own code. sluice's incremental-backup change-chunk decoder stored int64s exactly on disk in a typed envelope, then decoded them back through Go's interface{} — which encoding/json unmarshals every number into a float64 by default. Values near int64 max failed loudly; values merely above 253 decoded off-by-one with no error. Downstream that was worse than a bad value: a DELETE whose before-image carried a corrupted big-int matched zero rows and silently no-op'd, leaving 2,043 deleted rows alive on the target.

## Why (the mechanism)

A double has a 52-bit mantissa, so it can represent every integer up to 253 and only even integers immediately above it — odd values above the boundary are rounded to the nearest representable even. The corruption is invisible to the usual sanity checks: it doesn't overflow, doesn't error, and an aggregate checksum can hide it entirely (in our head-to-head a SUM matched despite 50% per-row corruption, because round-half-to-even makes the +1/&minus;1 errors cancel). You only see it per row.

In Go specifically, the trap is json.Unmarshal into an interface{} (or map[string]any): every JSON number becomes a float64, so an int64 that was written exactly comes back rounded even though the bytes on disk were correct.

## The repro

The whole class is visible in a two-line round-trip of a single big integer through a default JSON decode:

    // Go: exact on disk, rounded on the way back
    var v any
    _ = json.Unmarshal([]byte(`9007199254740993`), &v)   // 2^53 + 1
    fmt.Printf("%.0f\n", v)   // 9007199254740992   <- off by one, no error

    // The fix: decode through json.RawMessage / json.Number (UseNumber),
    // never through interface{}:
    d := json.NewDecoder(bytes.NewReader([]byte(`9007199254740993`)))
    d.UseNumber()
    var n json.Number
    _ = d.Decode(&n)
    fmt.Println(n.String())   // 9007199254740993   <- exact

The same boundary is why wrangler d1 export corrupts big integers before the data ever reaches a database, and why sluice's live-D1 reader deliberately avoids JSON numbers for integer columns.

## What sluice does about it

The fix was a single doctrine, applied wherever an int64 can ride a JSON hop: decode with json.RawMessage / UseNumber (json.Number), never through interface{}. sluice's change-chunk decoder moved from map[string]any to map[string]json.RawMessage so big-ints survive the round-trip byte-exact; the live-D1 reader projects integers through typeof() + CAST(... AS TEXT) (and BLOBs through hex()) so no value above 253 is ever rendered as a JavaScript number. Both are documented on the type-mapping page and in the SQLite / D1 import guide.

## The transferable lesson

If your IDs are Snowflakes, or your rows count past 9,007,199,254,740,992, treat every JSON hop in your pipeline as a potential rounding event. Audit each one for how it decodes numbers — in Go that means never interface{} for a field that can hold an int64 — and don't let an aggregate checksum reassure you, because symmetric rounding can make a SUM match while half the individual rows are wrong. Verify big-int fidelity per row, on the actual values, against an oracle.

## Primary sources

- sluice type-mapping — the >253 lossless-integer projection for SQLite / D1.

- sluice import guide — Import SQLite or Cloudflare D1 (the live-D1 reader path).

- Go encoding/json — Decoder.UseNumber and json.Number.

- The double-precision boundary — IEEE-754 double-precision format (exact integers up to 253).

---
Canonical page: https://sluicesync.com/field-notes/int64-json-boundary/ · Full docs index: https://sluicesync.com/llms.txt
