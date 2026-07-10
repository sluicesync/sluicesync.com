# Cloudflare D1 is not your local SQLite

> Our type-inference validated candidate columns with SQLite GLOB patterns — a UUID check is a 356-character char-class pattern — and passed every test we had, including a multi-GB head-to-head. Then it hit live D1 and died instantly: code 7500, LIKE or GLOB pattern too complex, on a 1,750-row table with pristine data.

Observed — live Cloudflare D1 source (--source-driver d1) with --infer-types. Addressed by ADR-0145 (migrate --stage-local), shipped v0.99.167.

## What happened

sluice's --infer-types feature validates candidate columns with SQLite GLOB patterns — the UUID-conformance check is a ~356-character character-class pattern (32 repetitions of [0-9a-fA-F]), the ISO-datetime check ~79 characters. It passed every test we had, including a multi-GB head-to-head. Then it ran against a live D1 database and died instantly:

    HTTP 400  code 7500: "LIKE or GLOB pattern too complex"

Not on a huge table — on a 1,750-row table with pristine data, on the first *_at / *_uuid candidate column. The failure was size-independent, and no local test could ever have produced it.

## Why (the mechanism)

D1's SQLite build ships a low SQLITE_MAX_LIKE_PATTERN_LENGTH, well below the ~356-character UUID pattern. Every stock local SQLite — and modernc.org/sqlite, the pure-Go build sluice uses locally — accepts the default cap of 50,000, so the long pattern compiles fine everywhere except on the real service. The dialect is identical; the limit is a hidden configuration surface you can't see from the SQL. So the whole failure class was invisible until the query ran on D1 itself: "SQLite-compatible" local testing told us nothing about it.

One layer deeper sat a second cliff: even where the pattern is accepted (boolean/JSON checks), an unbounded full-column validation scan over a multi-GB table trips D1's per-query CPU ceiling and aborts with HTTP 429 / code 7429. Two independent hidden limits, both absent from every local engine.

## The repro

Run a long-enough GLOB against a live D1 database — the row count and data quality are irrelevant:

    -- against live Cloudflare D1 (e.g. via wrangler d1 execute):
    -- a ~356-char character-class pattern like the UUID-conformance check
    SELECT count(*) FROM customers
     WHERE org_uuid GLOB '[0-9a-fA-F][0-9a-fA-F]... (32x) ...';
    --  D1: HTTP 400 code 7500 "LIKE or GLOB pattern too complex"

    -- the identical query on any local SQLite (incl. modernc) with the
    -- default SQLITE_MAX_LIKE_PATTERN_LENGTH = 50000 runs fine.

## What sluice does about it

The fix stops fighting the caps one query shape at a time. migrate --stage-local (D1 source only) first replicates the live D1 database into a byte-faithful local SQLite file, then runs the entire migrate — schema read, --infer-types validation, and bulk copy — against that local file via the existing sqlite engine, where neither the pattern-complexity limit nor the CPU ceiling exists. Staging closes the whole class of D1 HTTP-query limits (the GLOB cap, the CPU ceiling, ad-hoc COUNT/MAX 429s) in one move, and because the staged file carries D1's original conservative SQLite types, inference makes identical decisions. It auto-engages when --infer-types is set against a D1 source (the direct path is structurally broken there) unless you pass --no-stage-local. Crucially the staging is lossless, unlike wrangler d1 export, which rounds integers above 253 through a JavaScript double (see 253 is a database boundary now). A prototyped rowid-windowed "chunked validation" alternative was parked: it addresses only the CPU ceiling, not the GLOB-complexity limit — the same long patterns still abort at code 7500 before any CPU budget is reached.

## The transferable lesson

When you target a hosted build of an embedded engine, the SQL dialect is the same but the limits are a config surface you can't see and can't test against locally: pattern-length caps, per-query CPU/time ceilings, statement-size and result-size bounds. "SQLite-compatible" (or "Postgres-wire-compatible") tells you about syntax, not about the operational envelope. Validate against the real service early, and when the hosted limits are a moving target, the robust move is often to get the data onto an unconstrained local copy and do the heavy work there rather than negotiating with each cap individually.

## Primary sources

- sluice import guide — Import SQLite or Cloudflare D1 (the --stage-local path).

- Cloudflare D1 limits — D1 platform limits.

- SQLite's SQLITE_MAX_LIKE_PATTERN_LENGTH — SQLite implementation limits.

---
Canonical page: https://sluicesync.com/docs/field-notes/d1-not-local-sqlite/ · Full docs index: https://sluicesync.com/llms.txt
