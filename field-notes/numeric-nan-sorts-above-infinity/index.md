# Postgres NUMERIC stores NaN — and NaN sorts above Infinity

> SQL comparison is three-valued, so mapping a NaN operand to UNKNOWN feels principled — but Postgres doesn't do that: for sorting and range comparisons it defines a total order in which NaN is greater than every other value. The surprise stacks twice more: NUMERIC, the exact type, also stores NaN (plus ±Infinity in unconstrained columns since PG 14), and NaN sorts above Infinity. A client evaluator that mapped non-finite values to UNKNOWN→drop destroyed changes the server had faithfully delivered.

Observed &mdash; the 2026-07-23 blind audit of sluice's client-side --where evaluator (PG 16.14: 'NaN'::float8 > 0.1 is true), plus a value-fidelity review finding the worse sibling. Float leg affected sluice v0.99.282&ndash;v0.99.290, numeric leg v0.99.276&ndash;v0.99.290; both fixed in v0.99.291. The engine behavior is documented and by design.

## The total order you didn't expect from an exact type

Three stacked surprises. First: while ordinary comparisons involving SQL NULL are three-valued, Postgres's non-null NaN is not UNKNOWN-like at all &mdash; for sorting, indexing, and range comparisons PG defines a total order in which NaN is greater than every other value. Second: this isn't quarantined in the float types &mdash; NUMERIC, the type you reach for precisely because it's exact, stores NaN too, and since PG 14 stores &plusmn;Infinity in unconstrained columns. Third, the detail that makes the order memorable: NaN sorts above Infinity.

    SELECT 'NaN'::float8 > 0.1;                     -- true   (observed, PG 16.14)
    SELECT 'NaN'::numeric > 'Infinity'::numeric;    -- true   (NaN sorts above Infinity)
    SELECT '-Infinity'::numeric < -1e300;           -- true

So a predicate like --where "score > 0.1" has a server-defined verdict on a NaN row: it matches. Any second evaluator of the same predicate that treats NaN as &ldquo;unknowable&rdquo; has just disagreed with the server on a row the server will happily deliver.

## UNKNOWN→drop, and the two legs of one sync disagree

sluice's client evaluator did the principled-looking thing: non-finite operand → UNKNOWN → the change doesn't match the filter → drop. The snapshot leg, evaluated by the server, had already copied the NaN row. The CDC leg then dropped its every UPDATE (a stale target row) and swallowed its DELETE (a permanent orphan) &mdash; at exit 0, the same one-predicate-two-verdicts shape as the temporal split, on the value axis. The numeric sibling was the worse half, with a genuinely ironic geometry: numeric sits inside sluice's publication push-down envelope, so the server was evaluating the pushed filter correctly and faithfully delivering the NaN row's changes &mdash; and the client-side equivalence belt, kept on as a safety net, was the thing destroying them, under a DEBUG log whose wording assumed the drop direction was benign.

## Special values belong in the family matrix

The meta-finding is the audit's own flag: this was the third time in one comparator family that a fix pinned the representative and missed a sibling cell &mdash; the float-ordering fix pinned finite coercion and missed NaN; the float-NaN fix missed the NUMERIC type that can also carry one. Non-finite specials are a column of the test matrix (every family that can transport them &times; NaN/&plusmn;Inf), not a footnote on the float row. And in decimal transports they are string spellings: sluice's ir.Decimal travels as text, so the client had to recognize the literals "NaN", "Infinity", "-Infinity" &mdash; the same lesson as the trigger-CDC Infinity string, arriving through a different door. The shipped pins stream real NaN/&plusmn;Inf rows through actual logical decoding and assert server-verdict == client-verdict per operator, rather than trusting any layer's model of what the wire carries.

## The transferable lesson

Before you map a special value to UNKNOWN, check whether the engine already gave it a defined order &mdash; Postgres did, and it's total: NaN above everything, Infinity included, and the exact NUMERIC type participates fully. A client-side re-evaluation that is more &ldquo;principled&rdquo; than the server is just wrong in a quieter voice; and if your safety belt can override a correct server delivery, its disagreement direction is not benign and must not log at DEBUG.

## Primary sources

- sluice v0.99.291: the total-order arms in compareFloat / compareNumeric (internal/rowpredicate/predicate.go, incl. the &ldquo;NaN sorts last, above Infinity&rdquo; numeric arm and the string-spelling recognition), pinned by real-PG integration gates streaming NaN/&plusmn;Inf through live logical decoding, RED pre-fix.

- PostgreSQL documentation &mdash; floating-point and NUMERIC NaN ordering (&ldquo;NaN is treated as greater than all non-NaN values&rdquo;), &plusmn;Infinity in NUMERIC since PG 14.

- Related field notes &mdash; the crash was the good outcome (non-finite specials as strings, trigger-CDC door) and the predicate you evaluate twice (the general two-evaluator contract).

---
Canonical page: https://sluicesync.com/field-notes/numeric-nan-sorts-above-infinity/ · Full docs index: https://sluicesync.com/llms.txt
