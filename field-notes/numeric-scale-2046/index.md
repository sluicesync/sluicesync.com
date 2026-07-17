# information_schema reports a numeric scale of 2046

> Ask information_schema.columns for the scale of a numeric(5,-2) column and it answers 2046. The real scale is -2. The standards-blessed, portable way to read numeric precision and scale is quietly wrong for every negative-scale column — because the catalog view forgot to sign-extend a field the rest of Postgres sign-extends.

Observed — while fixing sluice's Postgres schema reader for array-element type modifiers (Bug 195, fixed v0.99.265); the 2046 reading was ground-truthed on PostgreSQL 17. The sluice-side loss it caused — negative-scale and array-element numeric columns mis-sized on read — is fixed; the information_schema behavior it exposed is PostgreSQL's own and reproducible in seconds.

## What happened

Since PostgreSQL 15, numeric accepts a negative scale: numeric(5,-2) is a five-digit number rounded to the nearest hundred, so 12345 stores as 12300. It is a real, occasionally useful feature. It also introduced a corner the standards view never learned about.

Inside the catalog, a column's precision and scale live packed into pg_attribute.atttypmod — a single integer. For numeric, the scale is an 11-bit two's-complement field. Postgres's own macro, NUMERIC_TYPMOD_SCALE, sign-extends that field when it decodes it, so a stored scale of &minus;2 comes back as &minus;2. information_schema.columns does not sign-extend. It masks the raw 11 bits and returns them as-is, so the &minus;2 comes back as its raw two's-complement encoding: 2046 (that is 2048 &minus; 2).

The arithmetic is checkable by hand: numeric(5,-2) has typmod 329730; the low 16 bits are 2046, the next bits are the precision 5. Decode the typmod the way the server does and you get scale &minus;2; decode it the way the catalog view does — or with a naive typmod reader that masks without sign-extending — and you get 2046, a scale that exceeds the precision cap and is on its face impossible.

## Why it matters

Reading precision/scale from information_schema is the portable, engine-agnostic move — it is what you reach for precisely to avoid poking at pg_attribute and version-specific typmod encodings. That is what makes this quiet: the &ldquo;correct,&rdquo; standards-first path mis-sizes every negative-scale numeric column, and a tool that then recreates the column downstream carries the 2046 forward as if it were a real scale. The same 2046 also falls out of any hand-rolled typmod decoder that masks the scale bits without sign-extending them — the mistake is the catalog view's, and it is easy to reproduce in your own code.

## Is the catalog "wrong"?

Worth stating carefully. Negative numeric scale landed in PG 15; information_schema.columns predates it by decades and reports numeric_scale as an int derived from the typmod without the sign extension the type system now needs. Whether that is a documented limitation or an oversight worth an upstream report is a fair question we have not resolved — the fact itself is reproducible in seconds, so nothing downstream depends on the answer. The pragmatic reading: the standards view is a rendering of the catalog, and renderings go stale when the type system grows new corners.

## Reproducing it

Any PostgreSQL 15 or later:

    CREATE TABLE t (n numeric(5,-2));

    SELECT numeric_precision, numeric_scale
      FROM information_schema.columns
     WHERE table_name = 't' AND column_name = 'n';
    -- numeric_precision | numeric_scale
    --                 5 |          2046   <- the raw 11-bit encoding of -2

    -- the ground truth, decoded the way the server does:
    SELECT atttypmod FROM pg_attribute
     WHERE attrelid = 't'::regclass AND attname = 'n';   -- 329730
    -- scale     = sign-extend( (atttypmod - 4) & 0x7FF )  = -2
    -- precision = ((atttypmod - 4) >> 16) & 0xFFFF        =  5

## What sluice does about it

sluice's Postgres reader now decodes the numeric typmod directly and sign-extends it the way NUMERIC_TYPMOD_SCALE does, preferring the typmod over information_schema for the numeric family — scalar columns and array elements alike. It keeps information_schema only as a fallback for the case where the typmod genuinely isn't available (a DOMAIN-unwrapped column carries atttypmod = -1).

## The transferable lesson

When a number out of information_schema looks impossible — a scale larger than its own precision, a length that can't be right — don't paper over it; go read the typmod, and decode it the way the server does, sign extension included. The standards view is a convenience projection of the catalog, and every time the type system grows a new corner (negative scale here, and there will be others), the projection can lag it. 2046 is the tell that you have crossed one of those corners.

## Primary sources

- PostgreSQL documentation — arbitrary-precision numbers (negative scale for numeric, PG 15+) and information_schema.columns.

- PostgreSQL source — the NUMERIC_TYPMOD_SCALE / NUMERIC_TYPMOD_PRECISION typmod macros (the sign-extended decode the catalog view omits).

- sluice Bug 195 and CHANGELOG v0.99.265 — the negative-scale/array-element typmod fix and the 2046 ground-truth on PG 17.

---
Canonical page: https://sluicesync.com/field-notes/numeric-scale-2046/ · Full docs index: https://sluicesync.com/llms.txt
