# You can't reimplement MySQL's =, so link its comparator in

> A filtered change stream evaluates the same predicate in two places — pushed down to the source, and client-side per event — and they have to agree exactly or the stream silently leaks or drops rows. String equality is where they diverge, because MySQL's default collation is case- and accent-insensitive: 'EU' equals 'eu' equals 'Eu'. sluice first refused such filters rather than approximate them. The resolution wasn't a better approximation — it was to stop reimplementing the comparison and link in the source engine's own comparator, so the two evaluations are the same code by construction.

Observed — this is the sequel to the predicate you evaluate twice has to agree, or refuse. That note explained why sluice refused case-insensitive string filters on a continuous stream; v0.99.278 (ADR-0174 Piece 1) makes them work — faithfully. Grounded in internal/rowpredicate/collation.go.

## The same predicate, evaluated twice

A filtered migration runs one --where in two very different evaluators: the source pushes it down as native SQL (the source's engine matches the rows), and the continuous change stream evaluates it client-side, per event, over decoded row values — because no source delivers a filtered stream. The whole design depends on those two producing the identical answer for every row. Where they disagree, a row the source considered in-scope gets dropped by the client (or vice versa): silent, count-invisible scope drift.

## String equality is defined by collation, not bytes

They agree trivially on numbers and IS NULL. Strings are the trap, because equality itself is a collation operation. MySQL's default utf8mb4_0900_ai_ci is case- and accent-insensitive: region = 'EU' matches the stored values eu, Eu, and Éu. A client-side byte comparison matches none of them — so the source says "in scope," the client says "out," and the stream drops a row it should have kept. The obvious fixes are all wrong in the tail: strings.ToLower ignores accents and the Turkish dotless-i; a hand-rolled Unicode case-fold still isn't MySQL's specific per-collation implementation; &szlig; vs ss, locale tailoring, and version differences all lurk. Any reimplementation is a model of the source's =, and it diverges exactly where you didn't test.

## The fix: link the source's own comparator

So sluice doesn't reimplement the comparison — it reuses the source engine's own. The client-side evaluator imports Vitess's collations and evalengine packages (already in the module graph) and, for a string column under a case/accent-insensitive collation, compares via evalengine.NullsafeCompare under the column's declared collation ID — the identical code path MySQL and Vitess fold case and accents with. That closes the case/accent axis.

But "reuse the library" turned out to be necessary, not sufficient — and a later audit proved it. The library's comparator reproduces a collation's weights (case, accent, expansion like ß→ss) but not two other axes of MySQL's =: its PAD_ATTRIBUTE — NullsafeCompare compares NO-PAD regardless of the collation's real attribute, yet every legacy collation (utf8mb4_general_ci, _bin, latin1_*) is PAD SPACE, so region = 'EU' matches a stored 'EU ' on the source but not through the library — and its charset (it reads the value bytes under the collation's charset, so a non-UTF-8 column would be mis-decoded). Reusing the comparator silently dropped/leaked trailing-space rows on the default legacy collation until the gap was caught. The fix was not a cleverer reuse — it was to ground-truth the client-side classification against a real server's own WHERE (a collation family×shape matrix run against an actual MySQL and Postgres), which surfaced the pad/charset divergence the library-verifies-library test could never see. A collation the library can't resolve, a non-UTF-8 charset, or a Postgres non-deterministic ICU collation refuses loudly rather than guess.

## The transferable lesson

When your code must reproduce another system's semantics — a collation's equality, a database's timezone math, a driver's numeric coercion, a hash's canonicalization — reimplementing it is a standing invitation to divergence, and the divergence hides on the inputs your tests didn't imagine. If the real implementation is linkable, link it: call the source system's actual comparator, not your model of it. But linking is necessary, not sufficient — a library can reproduce some axes of an operation and quietly not others (a collation's weights but not its pad attribute or charset, as here). So the ground truth is not the library; it is the real system. Verify the reuse against the actual server's own answer, on the hard shapes — never against the library, which could share the same blind spot (a library-verifies-library test is exactly how this shipped green). And when the semantics genuinely aren't linkable, the honest move is the first note's move — refuse, don't approximate.

## Primary sources

- sluice internal/rowpredicate/collation.go — collations.NewEnvironment + evalengine.NullsafeCompare; ADR-0174 Piece 1; CHANGELOG 0.99.278.

- Prequel — the predicate you evaluate twice has to agree, or refuse (why sluice refused these filters before this landed).

- Companion — the change stream that won't drop your row (why the client-side re-classification is mandatory even when the filter is pushed server-side).

---
Canonical page: https://sluicesync.com/field-notes/reuse-the-source-comparator/ · Full docs index: https://sluicesync.com/llms.txt

---
Canonical page: https://sluicesync.com/field-notes/reuse-the-source-comparator/ · Full docs index: https://sluicesync.com/llms.txt
