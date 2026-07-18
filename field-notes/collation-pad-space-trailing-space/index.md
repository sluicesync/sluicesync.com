# The = that ignores your trailing spaces

> MySQL's WHERE region = 'EU' matches a stored 'EU ' — on a legacy collation. Every collation except the 8.0 utf8mb4_0900_* family is PAD SPACE, which ignores trailing spaces in comparison; the modern default is NO PAD and doesn't. That single per-collation attribute is easy to miss, and a client-side comparator that reproduces a collation's case and accent folding but not its pad attribute silently disagrees with the source on the most common legacy collation. This one shipped as a real silent row-loss — and it shipped green because the test compared the comparator to itself instead of to a real server.

Observed — a post-release audit of continuous filtered sync (sluice sync --where). Ground-truthed against real MySQL 8.0 and Postgres 16; the divergence was a CONFIRMED Critical in a shipped, published build, fixed in the next patch. This is the companion to you can't reimplement MySQL's =, so link its comparator in — the specific axis that made "link the comparator" necessary but not sufficient.

## Two collations, two answers, one stored value

Create the same column under two collations and store the same four values:

    CREATE TABLE g (region VARCHAR(16) COLLATE utf8mb4_general_ci);   -- legacy
    CREATE TABLE n (region VARCHAR(16) COLLATE utf8mb4_0900_ai_ci);   -- MySQL 8 default
    INSERT INTO g VALUES ('EU'),('EU '),('EU  '),('eu');
    INSERT INTO n VALUES ('EU'),('EU '),('EU  '),('eu');

    SELECT region FROM g WHERE region = 'EU';   -- EU, EU_, EU__, eu   (all four)
    SELECT region FROM n WHERE region = 'EU';   -- EU, eu               (no trailing-space rows)

Same query, same data, different result — because the two collations have a different PAD_ATTRIBUTE. utf8mb4_general_ci is PAD SPACE: it ignores trailing spaces in a comparison, so 'EU' equals 'EU ' equals 'EU  '. utf8mb4_0900_ai_ci — the MySQL-8 default — is NO PAD: trailing spaces are significant, so 'EU ' is a different value. You can read the attribute straight from the catalog:

    SELECT collation_name, pad_attribute FROM information_schema.collations
    WHERE collation_name IN ('utf8mb4_general_ci','utf8mb4_0900_ai_ci','utf8mb4_bin');
    -- utf8mb4_general_ci  PAD SPACE
    -- utf8mb4_bin         PAD SPACE   (case-sensitive, but STILL pad-space)
    -- utf8mb4_0900_ai_ci  NO PAD

The trap is that every collation is PAD SPACE except the UCA-9.0.0 _0900_ family introduced in MySQL 8. So the pre-8.0 default, the MariaDB default, utf8mb4_bin, latin1_swedish_ci — the collations most legacy data actually lives under — all ignore trailing spaces, and the one collation a modern developer tests against is the one that doesn't. It is precisely the kind of per-object attribute you forget exists until it bites.

## Where it bites: a comparator that folds case but not pad

Continuous filtered replication has to evaluate region = 'EU' client-side, per change event, and get the same answer the source's WHERE would (the evaluate-in-two-engines problem). The right move is not to reimplement collation — it's to link the engine's own comparator and call it under the column's collation. That reproduces the collation's weights — case-insensitivity, accent-insensitivity, ß→ss expansion — exactly.

But the comparator reproduces the weights, not the whole of =. The library's compare is NO-PAD regardless of the collation's real pad attribute. So on a PAD SPACE column, the source keeps a stored 'EU ' in scope (its = ignores the trailing space) while the client-side reuse reads 'EU ' ≠ 'EU' and calls it out of scope. In a filtered change stream that means an INSERT of 'EU ' is silently dropped and a row updated to 'EU ' is silently deleted from the target — exit 0, no warning, on the default legacy collation, gated only on a trailing space (common from CSV, fixed-width, form, and legacy sources). Reusing the real comparator was necessary; it was not sufficient, because it faithfully reproduces one axis of the operation and silently not another.

The fix, once the axis is named, is small: right-trim trailing spaces before comparing on a PAD SPACE collation (reproducing exactly what PAD SPACE = does), skip the trim on NO PAD, and refuse the axes that genuinely can't be reproduced — a non-UTF-8 charset the comparator would mis-decode, a Postgres non-deterministic ICU collation.

## Why it shipped green: the test compared the comparator to itself

The sharpest part isn't the pad attribute — it's that a full test suite passed over this the whole time. The tests asserted the client-side comparator's output against hand-written expected booleans that were themselves reasoned from the same library. Library verifying library: the test and the code shared the exact blind spot, so a comparator that disagreed with a real MySQL on trailing spaces was green on every run, and stayed green through the release. The only thing that surfaced it was an audit that wrote a different kind of test — a family matrix that, for each collation × each shape (trailing space, leading space, case, accent, expansion), runs the literal SELECT … WHERE col = 'lit' on a real server and asserts the client-side classification equals that. It fails loudly on the shipped code and passes only on the fix, and it now stands as the gate.

## The transferable lesson

Two lessons braid here. The narrow one: a collation is not just its case/accent rules — PAD_ATTRIBUTE (and charset, and determinism) are part of what = means, and the split is per-collation and counterintuitive (legacy = PAD SPACE, modern default = NO PAD). The broad one is the reusable discipline: when you stand in for another system's operation — even by linking its own library — you must prove the reproduction against the real system, on the shapes that distinguish the axes, not against a test that shares your model. A green suite that only ever asked the library what the library thinks is not evidence; it's the same guess, twice. Verify a codec, a comparator, a canonicalizer against the ground truth it's imitating — a real server, a real reader — because the divergence you didn't reproduce is exactly the one your look-alike test can't see.

## Primary sources

- information_schema.collations.PAD_ATTRIBUTE; MySQL's PAD SPACE vs NO PAD comparison semantics (the _0900_ UCA-9.0.0 collations are the NO-PAD exception). sluice ADR-0174; the collation family-matrix gate (real MySQL + real Postgres).

- Companion field notes — you can't reimplement MySQL's =, so link its comparator in (the technique this is the caveat to) and the predicate you evaluate twice has to agree, or refuse (why the client-side evaluation must match the source at all).

---
Canonical page: https://sluicesync.com/field-notes/collation-pad-space-trailing-space/ · Full docs index: https://sluicesync.com/llms.txt

---
Canonical page: https://sluicesync.com/field-notes/collation-pad-space-trailing-space/ · Full docs index: https://sluicesync.com/llms.txt
