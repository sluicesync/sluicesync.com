# Pushing NOT through a quantifier is the wrong De Morgan

> Two catalogs store the same negated CHECK in different spellings, so a cross-engine diff has to canonicalize. But a canonicalizer that simplifies NOT by negating the comparison operator — exact for scalars — is invalid the moment a quantifier appears: NOT (x = ANY S) is x <> ALL S, not the x <> ANY S operator-negation produces. A correct NOT IN and a hand-gutted <> ANY canonicalized to the same string, and schema diff certified a hollowed-out constraint as in sync.

Observed &mdash; sluice's schema diff CHECK-expression canonicalizer, measured on real MySQL 8.0 and PostgreSQL 16. The unsound fold shipped in v0.126.0 and was fixed in v0.127.0, so the false-clean window is v0.126.0&ndash;v0.126.2.

## Two catalogs, two spellings

Ask MySQL 8.0 and PostgreSQL 16 to store the same logical constraint and read both back. PG rewrites CHECK (x NOT IN (1,2)) into a negation over a quantified comparison and hands it back built from ANY/ALL over ARRAY[&hellip;]; MySQL's catalog keeps not in. PG expands x NOT BETWEEN a AND b to (x < a) OR (x > b); MySQL keeps not between. That divergence is why a cross-engine schema diff needs a canonicalizer at all: compare the stored strings raw and every negated CHECK reports phantom drift forever.

## The algebra that quietly stops being sound

The canonicalizer's NOT-pushdown simplified NOT (v = 5) to v <> 5 by negating the operator. For a scalar comparison that is exact &mdash; even under SQL's three-valued logic, since a NULL-involving comparison evaluates UNKNOWN identically on both sides of the rewrite, and a CHECK treats UNKNOWN as pass. Across a quantifier it is a different theorem, and the operator-negation answer is wrong: NOT (x = ANY S) is x <> ALL S. Negating just the operator produces x <> ANY S &mdash; a predicate that accepts the very rows the original rejects (for S = (1,2), the value 1 satisfies <> ANY because it differs from 2). De Morgan for quantifiers flips the quantifier, not just the operator.

The consequence was the worst report a diff tool can make. A correct NOT IN constraint on one side and a hand-gutted <> ANY on the other both canonicalized to the same string, so schema diff reported no drift on a CHECK that had been hollowed out &mdash; a false all-clear that could authorize dropping the source constraint. Phantom drift wastes an afternoon; a false clean authorizes the destructive act.

## Bail, don't be clever

The fix is deliberately unclever: when either operand of the negated comparison leads with a quantifier keyword &mdash; ANY, ALL, SOME &mdash; the pushdown bails and leaves the NOT verbatim, so the two constraints compare as the different things they are. The failure direction flips from silent-false-match to spurious-difference, which is loud. The match is word-boundary-checked, so a column merely named anything or awesome still gets the ordinary scalar fold. And the genuinely-equivalent renderings are folded by dedicated, semantics-checked rules instead: PG's canonical <> ALL (ARRAY[&hellip;]) folds back to not in(&hellip;) &mdash; exact for the NULL-free literal list a CHECK carries &mdash; and NOT BETWEEN is expanded to match PG's stored form. Those two, plus exposing the MySQL-direction expression translator to diff, were only ever over-reports (phantom drift on a target the tool itself created) &mdash; the quantifier fold was the one member of the family that failed silent.

## The transferable lesson

A canonicalizer is a proof engine that somebody built under deadline: every fold is a claimed theorem, and the claim's scope is the part nobody writes down. &ldquo;Simplify NOT by negating the operator&rdquo; is true right up until the operand grammar grows a quantifier, and an over-eager fold in a comparison tool converts real difference into &ldquo;no drift&rdquo; &mdash; the exact inversion of the tool's job. When a rewrite's soundness depends on the operand's shape, gate the rewrite on the shape and default to bailing verbatim: in a diff, a spurious difference is an annoyance, and a spurious equality is a data-loss authorization. The companion note is the same catalog-rewrite seam failing loud instead: an expression the catalog rewrote into a form the target cannot even execute.

## Primary sources

- PostgreSQL reference &mdash; row and array comparisons &mdash; ANY/ALL semantics; NOT IN's relationship to <> ALL.

- MySQL reference &mdash; CHECK constraints &mdash; the catalog stores a normalized rendering of the expression.

- sluice v0.127.0 changelog &mdash; the quantifier bail, the negation-sibling folds, and the false-clean window (v0.126.0&ndash;v0.126.2).

- Related field notes: The catalog rewrote round(x) &mdash; the loud member of the same family; One predicate, two engines &mdash; a different two-evaluator seam: the filter predicate rather than the stored constraint.

---
Canonical page: https://sluicesync.com/field-notes/not-across-a-quantifier/ · Full docs index: https://sluicesync.com/llms.txt
