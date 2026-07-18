# The optimization that trimmed away the column a later feature needed

> Continuous filtered sync — replicate only the rows matching --where — has one genuinely hard case: an UPDATE can move a row out of the filter's scope, and that has to become a target DELETE or the now-out-of-scope row silently leaks. sluice designed exactly that, a before×after row-move truth table. Then end-to-end testing over a real change stream caught it leaking anyway, because both CDC readers already narrow the UPDATE before-image down to the primary key — an earlier correctness fix — so by the time the filter evaluated the OLD row, the filtered column was no longer in it. A data-narrowing optimization can silently defeat a feature added later that needs the trimmed-away data, and neither piece's own unit test can see it.

Observed — building continuous filtered sync (sluice sync --where, v0.99.276, ADR-0173 Phase 2). The leak was caught by end-to-end testing over a real change stream during development and fixed before the feature shipped — an in-development near-miss caught by the process, not a released regression. Ground-truthed against ADR-0173 and the MySQL/Postgres CDC readers' before-image narrowing.

## The one genuinely hard case in filtering a change stream

Filtering a one-shot copy is easy: push the WHERE down into the source read and only matching rows ever cross the wire. Filtering a continuous change stream is the classic partial-replication problem, because no source delivers a filtered stream — the binlog, the logical-replication slot, and VStream all hand you every change — so sluice evaluates the predicate itself, per event. And a single UPDATE can change a row so it newly matches the filter, or no longer matches it. Evaluating each event in isolation silently corrupts the target both ways: a row that moves out of scope (its old image matched, its new image doesn't) has to become a target DELETE — drop the event and the stale, now-out-of-scope row is left behind forever; a row that moves in has to become an INSERT, because the target has no base row for the UPDATE to land on.

So sluice pinned the semantics as a truth table — the predicate evaluated on both the before- and after-image, translated to the correct target op:

    before matches?   after matches?   target op
    -----------------------------------------------------------
         no                yes          INSERT the after-image   (moved IN)
         yes               no           DELETE by key            (moved OUT)
         yes               yes          UPDATE as-is
         no                no           drop (never in scope)

The move-OUT → DELETE row is the whole point of the table: it is the one guard standing between the operator and a silent leak of a row that no longer belongs in the filtered destination.

## The table was right, and it leaked anyway

End-to-end testing over a real change stream caught a move-OUT leaking despite the table. The reason is the sharp part, and it had nothing to do with the row-move logic — it was a pre-existing optimization from an unrelated fix, sitting one layer down. Both CDC readers already narrow an UPDATE's before-image down to just the primary-key (identity) columns before handing it up. That narrowing is not laziness; it is itself a correctness fix. Building an UPDATE's WHERE over every old column is exactly what silently ate our UPDATEs once a jsonb value failed its equality round-trip — so the readers deliberately reduce the before-image to the key, which is all the applier's WHERE needs.

But the filter's row-move check needs something the applier never did: the value of the filtered column in the OLD row. And by the time the intercept ran, the reader had already trimmed that column away. The predicate evaluated the OLD image, found the country column simply absent, read it as non-matching, and classified a genuine move-OUT as (before = false, after = false) — "never in scope" — and dropped it. The exact silent leak the truth table existed to prevent, produced by an optimization that predated the feature by many releases.

## The fix: full before-image only where it's needed, zero-value-safe

The narrowing is correct and worth keeping everywhere it's still safe — which is every table that isn't filtered. So the fix is a per-table opt-out on the reader (SetFullBeforeImageTables): the filtered tables emit the full before-image so the predicate can read every old column, every other table keeps the key-only narrowing, and the intercept re-narrows the before-image back to the primary key before the applier builds its key-only WHERE. The optimization survives; the feature gets the column it needs; the applier is unchanged.

The shape of the opt-out matters as much as its existence. The reader defaults to narrowing — the safe, common behavior — and full before-images are the opt-in for the handful of filtered tables. That is the zero-value-safe direction: every caller that never sets the field (every unfiltered sync, every test, every future construction path) gets the Go zero value, which is exactly the safe default. A field named for the rare behavior, defaulting on, would have silently inverted for everyone who didn't go through the filtered path. And a filtered stream still requires full before-images to exist at the source — REPLICA IDENTITY FULL on Postgres, binlog_row_image=FULL on MySQL — refused loudly at sync-start (SLUICE-E-WHERE-CDC-BEFORE-IMAGE) rather than allowed to run on a partial image the predicate can't read.

## Why only end-to-end testing could see it

Both halves passed their own unit tests, and both were right. The narrowing test is green: the applier still gets its key, the UPDATE still matches. The filter test is green: hand it a full before-image and it classifies every row-move correctly. The bug lived only in the composition — the narrowed image flowing into the filter's evaluator — and that composition exists only in the real, end-to-end change stream. No unit test of either piece could witness it, because each piece, tested against the input its own author imagined, does exactly what it should. This is the same discipline as sluice's rule that anything round-tripping through a store is a codec that needs the full family matrix, and that a verifier must not ride the same reader it verifies: correctness at each boundary does not compose into correctness across them, and only exercising the real path proves the seam.

## The transferable lesson

An optimization that narrows data — a before-image trimmed to the key, a projection that drops unused columns, a covering-index-only read, a payload slimmed to what today's consumer needs — is never a local change. It silently changes what every future consumer of that data is able to see. Add a feature later that needs one of the trimmed-away columns and it won't fail loudly; it will read the missing column as absent and quietly do the wrong thing, while both the optimization's tests and the feature's tests stay green. Before you narrow data on a shared path, write down what the narrowing assumes about who reads it downstream — and when you add a consumer, check what the path upstream already threw away. The only test that reliably catches the gap is the one that runs the whole path end to end.

## Primary sources

- sluice ADR-0173 (row-level --where filter), §Status implementation note and the Phase-2 row-move table; CHANGELOG 0.99.276. The reader opt-out SetFullBeforeImageTables (MySQL and Postgres CDC readers) and the sync-start refusal SLUICE-E-WHERE-CDC-BEFORE-IMAGE.

- Companion field note — the predicate you evaluate twice has to agree, or refuse (the other half of the same filtered-CDC design: why the client-side evaluator restricts its grammar).

- Related field notes — REPLICA IDENTITY FULL ate our UPDATEs (why the before-image is narrowed to the key in the first place), the row image you can't preflight and the platform default that eats every UPDATE (the row-image family — why REPLICA IDENTITY FULL / binlog_row_image=FULL become required here), and the zero value is a loaded gun (why the opt-out defaults to the safe behavior).

---
Canonical page: https://sluicesync.com/field-notes/optimization-trimmed-the-column/ · Full docs index: https://sluicesync.com/llms.txt
