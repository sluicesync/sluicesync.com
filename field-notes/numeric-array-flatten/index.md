# The same bytes, a different codec: how numeric[][] silently flattened

> We pinned multi-dimensional array support green on int[][] and text[][] and shipped. numeric[][] — running through byte-identical code — flattened a 2×2 matrix into a 1-D four-element array. Exit 0, no warning.

Observed — Postgres target via the pgx driver. Regression introduced in sluice v0.69.3, fixed in v0.69.4 (internally, Bug 74).

## What happened

We fixed multi-dimensional array support in our Postgres COPY writer. We pinned it green on int[][] and text[][], it passed independent review, and it shipped. Three days later a battle-test found that numeric[][] — running through byte-identical sluice code — was silently flattening a 2&times;2 matrix into a 1-D four-element array on the target. Exit 0, no warning, array_dims quietly wrong. A migration that reported complete had reshaped the data.

## Why (the mechanism)

The bug wasn't in our code path at all. sluice built the same nested [][] value for every element type and handed it to pgx to encode. But pgx selects its binary codec per target OID: the codec for a numeric array element is a different object from the codec for an int4 or text element. The int and text codecs recursed into the nested slice and preserved the dimensions; the numeric-element codec consumed the nested slice as a flat element list. Same input value, same sluice code, different driver branch underneath — chosen by the very dimension our tests didn't vary.

This is the general hazard of any encoder that dispatches on a type family: a green test on one representative type proves nothing about its siblings, because the layer beneath you may branch on the type you held constant.

## The repro

One row, no scale needed. Copy a source 2&times;2 numeric matrix into a Postgres numeric[][] column and ask the server for its dimensions:

    CREATE TABLE m (id int PRIMARY KEY, grid numeric[][]);
    -- the value sluice encodes for a source 2x2 matrix:
    INSERT INTO m VALUES (1, '{{1.1,2.2},{3.3,4.4}}');

    SELECT array_dims(grid) FROM m WHERE id = 1;
    -- correct:                 [1:2][1:2]
    -- before the fix (numeric codec): [1:4]   <- silently flattened to 1-D

    -- int[][] and text[][], identical sluice code, were always correct:
    --   [1:2][1:2]

Ground-truth the shape on the real server (array_dims plus each element's ::text), not in a unit test that asserts against sluice's own in-memory value — the flattening happens in the driver's wire encoding, which an in-memory assertion never exercises.

## What sluice does about it

The fix corrected the numeric-element encoding path, but the durable change was to the test doctrine. sluice now pins array support across the full matrix: every element family — native (int/float/bool), string-leaf (text/varchar/char/uuid/inet/cidr/macaddr/decimal), temporal (time/timestamp/timestamptz/date) — &times; {scalar/1-D, multi-dim ≥2-D, NULL-element}, with src == dst ground-truthed on the real target via array_dims and element ::text. A representative type is no longer allowed to stand in for its family.

## The transferable lesson

When a change touches an encoder, decoder, or codec that dispatches on a type family, the test pin must exercise every family and every shape variant, not one representative. The driver or wire path beneath you can differ by the target type even when your own code is byte-identical, so &ldquo;the integration test is green&rdquo; is insufficient if the test exercises one family of a family-dispatched path. Pin the class, not the representative — and if you are reviewing such a change, re-derive the family matrix yourself rather than trusting the one green case.

## Primary sources

- sluice type-mapping — array handling and the degradation policy.

- The value contract sluice pins against: docs/value-types.md.

- pgx's per-OID codec registry (the underlying behavior): github.com/jackc/pgx.

---
Canonical page: https://sluicesync.com/field-notes/numeric-array-flatten/ · Full docs index: https://sluicesync.com/llms.txt
