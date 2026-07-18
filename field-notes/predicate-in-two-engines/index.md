# The predicate you evaluate twice has to agree, or refuse

> Continuous filtered sync applies one --where predicate in two places: pushed down to the source for the initial snapshot, and evaluated client-side per event for the change stream, because no source delivers a filtered stream. If the two evaluations can disagree, the stream silently leaks or drops rows — and string equality is the canonical trap, because equality itself is collation-defined, not byte-defined. A byte-exact client-side compare of name = 'ANA' diverges from a case- or accent-insensitive source collation. So sluice restricts the client-side grammar to what it can reproduce faithfully and refuses everything else loudly at sync-start, rather than approximate a comparison the source would answer differently.

Observed — designing the client-side evaluator for continuous filtered sync (sluice sync --where, v0.99.276, ADR-0173 Phase 2). This is the companion to the row-move note: same feature, the other correctness boundary. A deliberate loud-refusal design, not a bug — grounded in ADR-0173 and the rowpredicate grammar.

## One predicate, evaluated in two engines

A filtered migration runs the same --where predicate in two very different places. For the initial bulk copy (and the snapshot leg of a sync), sluice pushes the predicate down to the source as native SQL — SELECT … WHERE (<predicate>) — and the source's own engine evaluates it, indexes and collations and all. But a continuous change stream has no such option: the binlog, the logical-replication slot, and VStream all deliver every change with no server-side filter, so sluice must evaluate the predicate client-side, per event, over the decoded row values. The same filter, computed by two different evaluators — and the whole design depends on them producing the identical answer for every row. If they can diverge, a row the snapshot included can be dropped by the stream (or vice versa): silent, count-invisible scope drift.

## Where they diverge: equality is collation-defined

For most comparisons the two agree trivially — a numeric =, an IN over integers, an IS NULL. The trap is strings, because equality itself is defined by the column's collation, not by the bytes. A source column under a case- or accent-insensitive collation — MySQL's default utf8mb4_0900_ai_ci, a Postgres CITEXT or non-deterministic ICU collation — matches name = 'ANA' against the stored values Ana, ANA, and Àna. A naive client-side comparator does a byte compare and matches none of them. So the source says a row is in scope and the client says it isn't: the row is silently dropped from the stream (or, symmetrically, leaked). The same divergence hides in string ordering under a linguistic collation, in a timezone-aware temporal comparison (the source interprets a bare literal in its session zone; the client holds a UTC instant), and in any function or subquery whose semantics the client can't reproduce.

## What sluice does: refuse, don't approximate

sluice's answer is a hard boundary drawn at sync-start. The client-side evaluator accepts only a restricted grammar it can reproduce faithfully: a column compared to a literal with =, !=/<>, or (on numeric and tz-naive temporal columns) the ordering operators; IN / NOT IN; IS [NOT] NULL; combined with AND / OR / NOT and parentheses — on numeric, boolean, case-sensitive-string, and tz-naive-temporal columns. Anything it cannot evaluate without risking divergence from the source — a function, a subquery, arithmetic, LIKE, string ordering, a string comparison on a collation that isn't provably case- and accent-sensitive, a tz-aware temporal comparison — is refused loudly, up front, with SLUICE-E-WHERE-CDC-UNSUPPORTED-PREDICATE, naming the construct. The motivating case — country IN ('US','CA') — works; a case-insensitive match is refused with a hint to normalize on the source (a generated lower-cased column) and filter on that, or to use migrate --where if only the one-shot subset is needed. The evaluator also uses SQL three-valued logic and treats UNKNOWN as not-matching, so a NULL-involving comparison can never accidentally widen scope.

## The transferable lesson

When the same predicate is evaluated by two engines — here the source's collation-aware SQL and a client-side comparator — correctness requires that they provably agree, not that they usually do. And string equality is the place that intuition fails, because a database's = is a collation operation, not a byte comparison: two engines can legitimately disagree on whether 'ANA' equals 'Àna'. Where you can't guarantee agreement, the safe move is to refuse the predicate at the boundary, loudly, before any data moves — not to ship an approximation that is right on the ASCII rows in your test fixture and silently wrong on the first accented one in production.

## Primary sources

- sluice ADR-0173 (row-level --where filter), §Status grammar-restriction note and Phase-2 decision; CHANGELOG 0.99.276. The rowpredicate grammar and its compile-time fidelity gates; the coded refusal SLUICE-E-WHERE-CDC-UNSUPPORTED-PREDICATE.

- Companion field note — the optimization that trimmed away the column a later feature needed (the row-move half of the same filtered-CDC design).

- Related field notes — MySQL won't match a JSON column by bind parameter and REPLICA IDENTITY FULL ate our UPDATEs (other places a comparison that reads correctly silently stops matching).

---
Canonical page: https://sluicesync.com/field-notes/predicate-in-two-engines/ · Full docs index: https://sluicesync.com/llms.txt
