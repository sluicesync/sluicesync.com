# The crash was the good outcome

> sluice's trigger-based Postgres CDC captures change images with to_jsonb(), and JSON has no token for a non-finite float — so ±Infinity and NaN travel as the strings "Infinity"/"NaN". The decoder normalized scalar leaves but skipped array elements, so the first UPDATE touching a float8[] column crashed the apply loop loudly and re-crashed on every restart. That loud crash was the value contract working: the fix not taken — blindly coercing every array leaf to float64 — would have truncated a numeric[] element and turned a text[] holding the literal word "Infinity" into a number.

Observed — a live crash-loop on AWS RDS PostgreSQL 16.14 during the v0.99.263 validation cycle (2026-07-16), nothing RDS-specific about it; fixed in v0.99.263. It affected every prior release of the postgres-trigger engine that carried array columns through UPDATE/DELETE payloads. Zero silent loss: the failure was loud and position-safe. This is a story about a crash being the right outcome, and the two silent corruptions the obvious fix would have shipped instead.

## How the capture format meets a non-finite float

The trigger-CDC engine records each change image by calling to_jsonb() on the row inside the capture trigger. JSON has exactly one numeric type and no spelling for Infinity, -Infinity, or NaN — so PostgreSQL renders those as the JSON strings "Infinity"/"-Infinity"/"NaN", while every finite number arrives, under a UseNumber decode, as a json.Number. The decoder already knew this: it normalized scalar leaves, mapping the non-finite spellings back to their float values and json.Number to the target type. It simply never applied that normalization to array elements.

So the first UPDATE that touched a float8[] column arrived with elements the apply layer had never normalized, and the apply failed loudly: column "floats": expected float64, got json.Number. Because the failure happened before the position advanced, the stream was position-safe — and deterministically re-crashed on the same change-log row at every restart. A wedged stream, not a data loss. Observed live on RDS PG 16.14; the same code path wedges on any Postgres.

## The fix not taken

The tempting one-liner is to coerce every array leaf to float64 and move on. That would have converted one loud crash into two silent corruptions:

- A numeric(p,s) array element carries arbitrary precision. Route it through float64 and it loses digits — silently, because the result is still a valid number.

- A text[] element can legitimately hold the literal word "Infinity". Map every non-finite spelling to a float upstream and that string becomes the number ∞ — a text value silently turned into a float.

The value that looked like a float was not always a float, and the payload spelling could not tell you which. So the coercion had to move down, into a type-aware layer that dispatches on the destination column family rather than on what the payload happens to look like: the float branch parses json.Number/int64/the non-finite spellings, the numeric branch takes json.Number.String() digit-lossless, the temporal branch parses ISO-8601 strings, and every branch refuses anything outside its own shapes loudly. It was pinned per the project's family-matrix discipline — every element family × shape × operation, not just the float8[] that crashed.

## The coda: -0 dies inside the database

One more thing surfaced en route, and it is not fixable downstream at all. to_jsonb('-0'::float8) returns 0 on PostgreSQL 16, while the SQL read path's float8out faithfully says -0. The reason is that jsonb numbers are numeric, and numeric has no signed zero. So any capture format that routes a value through the database's own JSON type destroys a float's zero sign inside the source database, before the pipeline ever sees the payload — there is nothing a decoder or applier can do about information the capture already threw away. Bulk copy and slot-based CDC of the same value carry the sign fine; only the JSON-mediated trigger capture loses it. It ships as a documented, pinned capture-fidelity limitation.

## The transferable lesson

A capture format that routes values through the database's own JSON type inherits that type's number semantics — no non-finite tokens, no signed zero, one lossy numeric. And a payload decoder must dispatch on the destination type family, never on what the payload value happens to look like: the same three characters, "Infinity", are a float in one column and a string in the next. When a strict decode crashes loudly on a value it can't place, that is the type contract doing its job — the dangerous fix is the one that makes the crash go away by guessing.

## Primary sources

- PostgreSQL documentation — JSON types (jsonb numbers are numeric; no non-finite values, no signed zero) and to_jsonb().

- sluice v0.99.263 changelog and the RDS-Postgres validation report (F3) — the live crash-loop, the type-aware array-element decoder, the family-matrix pins, and the to_jsonb('-0'::float8) → 0 capture-fidelity wart.

- Related field notes — Vitess copy phase rounds your FLOATs (another &ldquo;the loss is in the capture format&rdquo; story) and the pgx codec that flattened numeric[][] (the array-family-matrix discipline).

---
Canonical page: https://sluicesync.com/field-notes/crash-was-the-good-outcome/ · Full docs index: https://sluicesync.com/llms.txt
