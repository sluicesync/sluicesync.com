# Postgres writes +00; your parser expects +00:00 — and every date ends in the shape of the shortest legal offset

> ISO 8601 admits at least four spellings of a UTC offset, and Postgres COPY picks the shortest: 2026-07-15 08:09:10.123456+00. A layout list that stops at ±hh:mm refuses Postgres's own default text output. And the fix has its own trap — a bare date like 2026-07-02 ends in -02, exactly the naive two-digit offset shape.

Observed — sluice's SQLite/D1 type-inference path meeting a real Postgres-COPY-produced timestamptz column (found by the flat-file integration corpus; fixed v0.99.250). The bug was a loud wrong-refusal — a promoted column aborting mid-copy — affecting v0.99.166 through v0.99.249; never silent loss, and completed runs were always correct.

## What happened

An ISO 8601 UTC offset can be spelled Z, +00:00, +0000, or bare +00 — all conformant. Postgres COPY &hellip; CSV renders timestamptz in the shortest legal form: space-separated, colon-less, two-digit offset. A parser whose layout list covers -07:00 and -0700 but not -07 refuses Postgres's own default text output — arguably the single most common zoned-timestamp rendering a data tool will ever meet in a file.

sluice hit both halves of the class at once, because it had two independent implementations of the same predicate. The type-inference validator (GLOB-based, deciding whether a TEXT column's values all conform to a timestamp shape and can be promoted) accepted the value; the decoder (time.Parse layout-based, executing that promotion at copy time) refused it. Validator promises, decoder reneges: a promoted column aborted loudly mid-copy with a raw decode error. Two implementations of &ldquo;is this a zoned timestamp?&rdquo; had drifted apart, and every value in the gap between them became a wrong refusal.

## The widening has its own trap

The obvious fix — teach both sides the bare &plusmn;hh spelling — contains a false-positive generator. A two-digit offset is a two-character numeric suffix after a sign, and a plain DATE ends in one: 2026-07-02 terminates in -02, which is byte-identical to the naive &plusmn;hh shape. An unanchored acceptor reads an offset into every date whose day-of-month resembles one — inventing a time zone, and with it an instant shift, on values that were naive dates all along.

The accepted spelling has to be anchored: bare &plusmn;hh counts as an offset only when it follows seconds or a fractional-seconds field. A date can't get there; a real COPY-rendered timestamptz always does.

## What sluice does about it

The decoder gained the missing layouts (T-separated naive datetimes, space-separated zoned forms, &plusmn;hhmm, anchored &plusmn;hh); the validator gained the matching spellings with the anchoring; and — the part that fixes the class rather than the instance — both sides are now pinned cell-by-cell against the same separator &times; zone &times; fraction matrix, with a real Postgres-COPY-produced timestamptz column instant-checked end to end on both Postgres and MySQL targets. The bare-date rows in the validator matrix assert the value stays naive. When two components implement one predicate, either make them literally one function or pin them against one shared truth table; anything looser drifts.

## Reproducing it

Any Postgres, one psql session:

    CREATE TABLE t (ts timestamptz);
    INSERT INTO t VALUES ('2026-07-15 08:09:10.123456+00');
    \copy t TO 'out.csv' CSV

    $ cat out.csv
    2026-07-15 08:09:10.123456+00     <- space separator, bare two-digit offset

Feed out.csv to any parser whose zoned layouts stop at &plusmn;hh:mm/&plusmn;hhmm and watch it refuse Postgres's own default output. The false-positive half is just as quick: hand an unanchored &plusmn;hh acceptor the bare date 2026-07-02 and it reads a UTC-2 offset out of the day-of-month — which is why the accepted spelling must be anchored after seconds or a fraction.

## The transferable lesson

Two lessons. First, a validator and a decoder that answer the same question are one predicate wearing two implementations, and the gap between them is a bug class of its own — here it surfaced as a loud wrong-refusal, but the same drift in the permissive direction would promise conformance the executor silently mangles. Second, the shortest legal ISO offset is a substring of every date: any temporal grammar that accepts bare &plusmn;hh without anchoring it to the time portion will hallucinate time zones out of day-of-month digits. Postgres will send you the short spelling — its COPY output is the conformance test your parser actually has to pass.

## Primary sources

- ISO 8601 — time zone designators: Z, &plusmn;hh:mm, &plusmn;hhmm, and &plusmn;hh are all conformant spellings.

- PostgreSQL documentation — datetime output styles: the ISO style renders the offset without a colon when minutes are zero (the +00 shape COPY emits).

- sluice v0.99.250 changelog — the validator/decoder temporal-matrix fix and the affected-version range.

---
Canonical page: https://sluicesync.com/field-notes/shortest-legal-offset/ · Full docs index: https://sluicesync.com/llms.txt
