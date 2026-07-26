# Your UNIQUE constraint survived the migration; its semantics didn't

> NULLS NOT DISTINCT, DEFERRABLE, and WITHOUT OVERLAPS all land on the target as a plain UNIQUE — including Postgres→Postgres. The constraint has the right name and the right columns, and quietly accepts rows the source would have rejected.

Observed &mdash; Postgres source, every sluice target including same-engine Postgres. A read-time WARN shipped in sluice v0.100.0; the weakening itself is real, and faithful carry remains an open follow-up.

## What happened

A UNIQUE constraint is not one thing. Postgres lets it carry three attributes that change what it actually rejects: NULLS NOT DISTINCT (PG 15+), DEFERRABLE, and WITHOUT OVERLAPS (PG 18+). Every migration target was landing all three as a plain UNIQUE &mdash; and the surprising part is that this includes Postgres → Postgres, the direction people reasonably assume is lossless.

Nothing errors. The constraint exists on the target, with the same name and the same columns. It simply admits data the source would have refused.

## What the target now accepts

- NULLS NOT DISTINCT &mdash; the default UNIQUE treats every NULL as distinct from every other, so a nullable unique column accepts unlimited NULL rows. A source declared NULLS NOT DISTINCT rejects the second row with a NULL in the key. Drop the attribute and the target happily stores both &mdash; the uniqueness invariant now has a hole exactly where the data is missing.

- DEFERRABLE &mdash; a deferred constraint is checked at COMMIT, which is what makes &ldquo;swap two rows' unique values in one transaction&rdquo; legal: the intermediate state violates uniqueness and is repaired before commit. Land it as immediate and those transactions start failing at the statement. This one fails loudly rather than silently &mdash; but it fails in the application, after cutover, on a workload that worked yesterday.

- WITHOUT OVERLAPS &mdash; a temporal key whose last column is a range, rejecting rows whose periods overlap rather than merely rows that are equal. Drop it and equality checking is all that is left: two reservations for the same room with overlapping (but not identical) date ranges both land.

All three share the shape that makes constraint differences dangerous: the target is strictly more permissive than the source, so nothing breaks at migration time. It breaks later, when data the source's schema made impossible finally arrives.

## Two catalog surprises worth the detour

NULLS NOT DISTINCT is not on pg_constraint. Its two siblings are &mdash; condeferrable and conperiod &mdash; so the natural assumption is a connullsnotdistinct column beside them. There isn't one. The flag lives on the index, as pg_index.indnullsnotdistinct, because that is where the null-handling behavior is implemented. Assuming the symmetry produces a 42703 column does not exist against a real PG 16 &mdash; which is the good outcome; the bad one is a version gate that silently never fires.

    -- the two that ARE on pg_constraint
    SELECT conname, condeferrable, conperiod FROM pg_constraint WHERE contype = 'u';

    -- the one that is NOT — it lives on the index
    SELECT c.conname, i.indnullsnotdistinct
    FROM   pg_constraint c
    JOIN   pg_index i ON i.indexrelid = c.conindid
    WHERE  c.contype = 'u';

WITHOUT OVERLAPS is PG 18, not PG 17. Temporal constraints landed in the PG 17 development tree and were reverted before GA. Plenty of secondary material still describes them as a 17 feature. Version-gate conperiod at 17 and you read a column that isn't there on every real PG 17 server.

## What sluice does about it

The Postgres schema reader now reads all three attributes &mdash; version-gated so pre-15 and pre-18 servers never hit a 42703 &mdash; carries them as metadata on its internal index representation, and emits one WARN per affected constraint at schema-read time, naming the attribute, the weaker landing, and a recreate-on-target hint. It is a WARN, not a refusal: the migration completes and the operator decides.

One residual is worth stating plainly, because a note that only advertises the fix is not much use: the WARN is gated on the attribute being constraint-backed. A plain CREATE UNIQUE INDEX &hellip; NULLS NOT DISTINCT &mdash; an index, not a constraint &mdash; is still weakened silently. If you use that form, check it by hand.

## The transferable lesson

When you copy a schema, ask not &ldquo;does the constraint exist on the target&rdquo; but &ldquo;does it reject the same rows.&rdquo; Name and column list are the easy part, and the part every tool gets right; the modifiers that change the predicate live in catalog columns you have to go looking for &mdash; sometimes on a different catalog than the constraint itself. And the direction you trust most deserves the check most: same-engine migrations are where nobody thinks to look, precisely because both sides speak the same dialect.

## Primary sources

- Postgres CREATE TABLE &mdash; UNIQUE NULLS NOT DISTINCT, DEFERRABLE, and the temporal WITHOUT OVERLAPS form.

- Postgres pg_index (indnullsnotdistinct) and pg_constraint (condeferrable, conperiod) &mdash; the asymmetry above.

- Related field note &mdash; the replication stream never tells you the column default, the same class one layer down: schema metadata a transport declines to carry.

---
Canonical page: https://sluicesync.com/field-notes/unique-semantics-dropped/ · Full docs index: https://sluicesync.com/llms.txt
