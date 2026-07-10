# {}: two characters, two types, one silent corruption

> In Postgres, {} is an empty array literal. In JSON, it's an empty object. Funnel both through one value-preparation path and []byte("{}") is genuinely ambiguous — and for nine releases our MySQL writer resolved it the wrong way.

Observed — MySQL writer, empty JSON object on bulk copy. Internally Bug 47 (fixed v0.29.1; reproduced identically on every binary from v0.20.0 through v0.29.0).

## What happened

A MySQL source value attrs = '{}' (an empty JSON object, JSON_TYPE = OBJECT) round-tripped through sluice and landed on a MySQL target as attrs = '[]' — an empty array, JSON_TYPE = ARRAY. Every other JSON shape was perfect: populated objects, empty arrays, populated arrays, JSON null, JSON scalars. Only the empty object flipped type, and it did so silently, on every release for nine versions.

## Why (the mechanism)

The two literals collide on their bytes. In Postgres, {} is the empty array literal; in JSON, {} is the empty object. When a migration pipeline funnels both worlds through one value-preparation path, []byte("{}") arriving at the encoder is genuinely ambiguous — the bytes alone cannot say whether they mean "empty PG array, which for a MySQL JSON column should become []" or "empty MySQL JSON object, which should stay {}." The MySQL writer guessed array, so empty objects became [].

The instructive part is the first fix attempt, which was rolled back within a day. Simply preserving {} as an object broke the opposite case — a Postgres empty array overridden onto a MySQL JSON column should land as [] — because no local heuristic can disambiguate two bytes that carry two legitimate meanings. The writer didn't need a cleverer guess; it needed information it didn't have: the source column's type, threaded down to the encoder.

## The repro

    -- MySQL source: six canonical JSON shapes
    INSERT INTO t (id, attrs) VALUES
      (1, '{"role":"admin"}'),  -- populated object: preserved
      (2, '{}'),                -- empty object:     CORRUPTED -> []
      (3, '[]'),                -- empty array:      preserved
      (4, '[1,2,3]'),           -- populated array:  preserved
      (5, 'null'),              -- JSON null:        preserved
      (6, '"hello"');           -- scalar:           preserved

    -- migrate MySQL -> MySQL, then on the target:
    SELECT id, JSON_TYPE(attrs) FROM t WHERE id = 2;
    --  before the fix: ARRAY   (source was OBJECT)

## What sluice does about it

The fix threads the missing context through the IR: ir.Column gained an optional SourceColumnType field that the translation layer populates, and the MySQL writer consults it to disambiguate — source type is an array → [], otherwise → {}. The disambiguation is column-scoped, proven by a single-row test with two columns: an empty text[] overridden to a MySQL JSON column lands as [], while an empty JSON object in the sibling column lands as {} — same row, opposite resolutions, because each carries its own source type.

## The transferable lesson

Value translation is only sound when type information travels with the value, all the way to the last encoder. The moment two distinct source types can serialize to identical bytes — {} the empty array and {} the empty object, or an empty string versus SQL NULL, or 0 the number versus 0 the boolean — a downstream stage that sees only the bytes cannot recover the intent, and any local heuristic it applies will be right for one meaning and wrong for the other. Don't make the encoder guess; carry the type.

## Primary sources

- Postgres array input syntax ({} as the empty array) — arrays.

- MySQL JSON type and JSON_TYPE() — the JSON data type.

- sluice type mapping (how source type is carried across the translate boundary) — type mapping.

---
Canonical page: https://sluicesync.com/field-notes/empty-object-vs-array/ · Full docs index: https://sluicesync.com/llms.txt
