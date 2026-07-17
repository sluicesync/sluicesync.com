# Your floats are fine; your diff tool is comparing two renderings

> One server sets extra_float_digits=0, another runs the modern default of 1, and every text-level float comparison between them reports differences that do not exist. The stored bits are identical; only the rendering moved. The reassuring direction of this bug — data exact, report wrong — is exactly what makes it waste hours: everything you inspect by hand re-renders through the same setting that skewed the report.

Observed — validating a Supabase-sourced migration (2026-07-15), where ::text comparisons disagreed while float8send proved the copy bit-exact. Internally part of roadmap item 69's Supabase leg. This is the reader-facing cut of the fact; the engineering story of pinning the setting across every session sluice renders in is its own note — the one-line fix that unpinned itself through the pooler (Bug 194, fixed v0.99.265).

## What happened

A float8 value has one binary identity and, historically, more than one text rendering. Since PostgreSQL 12 the default extra_float_digits is 1, which selects shortest-round-trip formatting: the fewest digits that parse back to exactly the same double. Before that the default was 0 — roughly 15 significant digits, a rendering that can round away the low bits of the printed form even though the stored value is untouched.

Supabase ships extra_float_digits=0 as a server default. So a pipeline that copies floats between a stock-default source and a Supabase target — or the reverse — and then verifies with any text-level comparison (::text, a CSV export diff, a checksum over rendered rows) sees phantom mismatches on values whose double-precision bits are identical. The data is right. The report is wrong.

## Why (the mechanism)

Text formatting is a session/server GUC, not a property of the value. The same stored double renders differently under extra_float_digits 0 and 1, and any comparison performed at the text layer inherits whichever setting each session happened to have. The failure is doubly treacherous because it points in the reassuring direction: an operator who sees float diffs after a migration assumes the copy corrupted the data, when here the copy is provably exact and only the two renderings diverge.

The proof, when you need it, is to compare at the layer where the value actually lives:

    -- the binary identity of the stored value, rendering-independent:
    SELECT md5(string_agg(float8send(f)::text, ',' ORDER BY id)) FROM t;

    -- or pin the rendering before comparing through it:
    SET extra_float_digits = 1;

float8send returns the raw 8 bytes of the double; if those agree on both sides, the values agree, whatever the text says.

## The part that isn't just cosmetic

It is tempting to file this as a pure display concern — the bits are safe, so any binary copy is fine. That is true only for a pipeline that never renders a float as text. sluice does, in several places: a raw-copy lane that can move floats as server-rendered text, CDC paths that render tuple text server-side, and — the sharp edge — a verifier that hashes server-rendered ::text samples. In each of those, extra_float_digits governs the actual bytes crossing the boundary, so a source at 0 could round a value in transit, and the verifier could both report a false mismatch on identical data and, worse, a false clean: a source at 0 renders a true value byte-for-byte the same as a target holding that value's rounded corruption. A checker that reads through the setting under test cannot adjudicate it. sluice closed all of this in v0.99.265 by pinning extra_float_digits=3 in every session it renders a float in — the four-pin fix arc is the companion note. The point for anyone else: &ldquo;the bits are safe, text is cosmetic&rdquo; holds only until some layer of your pipeline moves the value as text.

## Reproducing it

Any Postgres 12+; no provider account needed (Supabase just ships the non-default as a server default):

    SET extra_float_digits = 0;
    SELECT pi()::float8::text;        -- 3.14159265358979    (15 digits, lossy text)

    SET extra_float_digits = 1;
    SELECT pi()::float8::text;        -- 3.141592653589793   (shortest round-trip)

    -- same stored value both times; only the rendering moved:
    SELECT float8send(pi());          -- \x400921fb54442d18  (identical under both)

Run the first SELECT on a Supabase session and the second on stock Postgres and you have the cross-server &ldquo;mismatch&rdquo; in miniature: two texts, one value, and float8send as the tiebreaker.

## The transferable lesson

A float's text form is a session setting wearing a value's clothes. Never let a text-level comparison adjudicate float fidelity across two servers unless you have pinned the rendering GUC on both sides — and when a float &ldquo;mismatch&rdquo; appears after a migration, check the formatting layer before the data layer. The reassuring direction of this bug is exactly why it wastes hours: everything you inspect by hand re-renders through the same setting that skewed the report. And if any stage of your own pipeline moves floats as text, the setting stops being cosmetic and becomes a corruption surface — pin it, on every session that renders.

## Primary sources

- PostgreSQL documentation — extra_float_digits: shortest-round-trip output at the default of 1 (PG 12+); smaller values round the rendering.

- PostgreSQL release notes (12) — the change of the default from 0 to 1.

- sluice managed-services notes — the Supabase section (server default extra_float_digits=0); and the field note on pinning the setting across every session sluice renders in.

---
Canonical page: https://sluicesync.com/field-notes/extra-float-digits/ · Full docs index: https://sluicesync.com/llms.txt
