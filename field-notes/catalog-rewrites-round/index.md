# The catalog rewrote round(x), and the target lacks the overload it wrote

> MySQL doesn't store your CHECK (round(d) >= -100000) — it materializes the function's default scale into the text, round(d,0). PostgreSQL's overload set has round(double precision) and round(numeric, integer) but no round(double precision, integer), so the faithfully-carried constraint dies at CREATE TABLE with 42883. The identical CHECK on a DECIMAL column migrates fine — which is exactly why the test corpus missed it.

Observed &mdash; a MySQL → Postgres migrate carrying a CHECK on a DOUBLE column, caught by sluice's post-release regression cycle (Bug 252) and fixed in v0.126.1. Measured on real MySQL 8.0 and PostgreSQL 16.

## Two invisible hands collide

Write CHECK (round(d) >= -100000) on a MySQL DOUBLE column and read it back from information_schema: the catalog does not store your spelling. MySQL materializes the function's default scale into the stored text &mdash; round(d,0). Carry that stored form faithfully to PostgreSQL and it hits the second invisible hand: PG resolves functions by overload set, and its two-argument round exists only for numeric. There is no round(double precision, integer), so CREATE TABLE fails:

    ERROR: function round(double precision, integer) does not exist (SQLSTATE 42883)

Neither engine did anything wrong. MySQL stored an equivalent expression; PostgreSQL enforced its type system. The migration died in the seam between two behaviors that are each fine alone &mdash; and schema preview had rendered the doomed DDL at exit 0 with &ldquo;advisory hints: 0&rdquo;.

## Why the corpus missed it

The identical constraint on a DECIMAL column migrates cleanly &mdash; round(numeric, integer) exists. So the migrate-then-diff test corpus, whose pinned representative for CHECK expressions happened to be a DECIMAL column, stayed green through the whole failure class. The family axis here is not the expression text at all &mdash; it is the column type's overload set on the target: identical tool code path, different per-type surface, the same shape as a driver whose per-OID codecs diverge under one dispatch. Pin the class, not the representative.

## The fix is author-intent restoration, not translation

sluice's fix (v0.126.1) strips only the zero scale the catalog added: round(x,0) → round(x), which is semantics-exact on both engines for every argument type &mdash; it merely restores the author's own spelling. A human-written non-zero scale is meaning, and passes through untouched: a CHECK (round(d, 2) > 0) on a DOUBLE column still fails loudly at CREATE with the same 42883, deliberately &mdash; silently rewriting it (say, by inserting a cast) would change the predicate's type arithmetic. The wider overload-gap surface is filed for measurement, not papered over.

One more measured fact from the same read-back: PostgreSQL spells some casts in two words &mdash; ::double precision &mdash; so an expression canonicalizer that skips a single cast token leaves precision behind as a phantom identifier. SQL-standard multi-word type names are their own parsing class.

## The transferable lesson

The expression you wrote is not the expression the catalog stores, and the expression the catalog stores is a claim about one engine's function-resolution rules. Any tool that carries stored expression text across engines is carrying rewrites it never saw &mdash; and the safe move splits by provenance: undo the rewrites the catalog demonstrably added, and let everything the author wrote fail loudly where the target genuinely lacks it. The companion note shows the same catalog-rewrite mechanism one step worse: not a failed CREATE, but a schema diff that certified a gutted constraint as in sync.

## Primary sources

- PostgreSQL reference &mdash; mathematical functions &mdash; round(numeric, integer) is the only two-argument form.

- MySQL reference &mdash; ROUND() &mdash; the default-scale semantics the catalog materializes.

- sluice v0.126.1 changelog &mdash; the default-scale strip, and the deliberate loud passthrough for non-zero scales.

- Related field notes: Pushing NOT through a quantifier is the wrong De Morgan &mdash; the same &ldquo;the catalog rewrote your expression&rdquo; mechanism, escalated to a silent false-clean.

---
Canonical page: https://sluicesync.com/field-notes/catalog-rewrites-round/ · Full docs index: https://sluicesync.com/llms.txt
