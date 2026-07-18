# You can't filter a parent table without orphaning its children

> Row-level filtering — copy only the rows matching --where — reads like a per-table setting: give each table a predicate, keep the rows that match. But a relational schema couples those filters through its foreign keys. Filter a parent table down to a subset and the child rows you copied still point at parent rows the filter excluded, so the deferred ADD CONSTRAINT FOREIGN KEY fails with SQLSTATE 23503 on the target. A tool that filtered the parent quietly would hand you a database that looks complete and violates its own declared keys. sluice refuses loudly instead, names the constraint, and makes you choose how to reconcile.

Observed — building row-level filtering (sluice migrate --where, v0.99.276, ADR-0173 Phase 1). A shipped, loud refusal — the trap sluice won't walk into — not a bug. Grounded in ADR-0173's referential-integrity section, the SLUICE-E-WHERE-FK-ORPHAN refusal, and the --allow-degraded-fks degrade path in the migrate pipeline.

## Subsetting is not a per-table operation

The --where surface invites you to think table by table: --where users=country IN ('US','CA'), --where orders=created_at >= '2026-01-01'. Each predicate scopes one table's rows, independently. That mental model is exactly right for the copy — each table's read pushes its own predicate down to the source — and exactly wrong for the result, because the tables are not independent. A foreign key is a promise that every value in a child column exists in a parent column. Filter the parent's rows and you can silently break that promise for child rows you kept.

Concretely: orders has a user_id FK into users. You filter users to the US/CA subset but copy orders whole. Half your orders now reference users that were never copied. On the source those orders were fine — the parents existed. On the target, when sluice adds the deferred foreign key after the bulk copy (constraints are created last, so the copy isn't fighting them row by row), the constraint validation scans the child table, finds rows whose user_id has no matching parent, and fails with SQLSTATE 23503. The migration stops with a foreign-key violation that originated three steps earlier, in a filter on a different table.

## The failure you don't want is the silent one

The 23503 is loud and it stops the run — that is the good outcome. The outcome to fear is the one where a subsetting tool "helpfully" copies the child rows anyway and leaves the foreign key off, or degrades it without telling you. Now you have a target that looks like a faithful subset: all the tables are there, the row counts look plausible, nothing errored. And it quietly violates its own schema — orphaned children pointing at absent parents, a referential guarantee the application still assumes holds. Every query that joins through that key silently returns less than it should, and no checksum on the copied bytes will ever flag it, because every copied row is byte-perfect. The corruption is in what wasn't copied, and in the constraint that was silently dropped to tolerate it.

## sluice refuses, names the constraint, and offers two honest paths

sluice never leaves a silent orphan. When a --where run hits 23503 on the deferred FK add, it refuses with SLUICE-E-WHERE-FK-ORPHAN, naming the exact constraint, and points at the two ways forward:

Filter consistently. The clean answer when the schema allows it: filter the child so it only admits rows whose parent survives the parent filter — scope orders by the same country the users filter uses, so no kept order references a dropped user. The subset stays referentially closed and the foreign key validates.

--allow-degraded-fks (Postgres target). When you genuinely want the orphans — a partial extract where the missing parents are acceptable — this degrades that constraint to NOT VALID: the foreign key is still attached to the target catalog and still rejects any new write that would orphan a row, but the existing orphans from the copy are tolerated. Crucially, the degrade is explicit and surfaced at the end of the run, not silent, and you finish the reconciliation yourself with ALTER TABLE … VALIDATE CONSTRAINT <name> once you've backfilled or accepted the gaps. MySQL has no per-constraint NOT VALID semantic, so the flag refuses loudly against a MySQL target rather than pretend it can degrade a constraint it can't.

The distinction that matters: the constraint is never quietly dropped. Either it validates (you filtered consistently), or it's explicitly degraded with your opt-in and a remedy you run, or the run refuses. There is no path where a foreign key silently disappears to make a subset "work."

## The proper answer is genuinely hard, and it's deferred honestly

The eventual right answer to "I filtered a parent and want my children" is referential-aware subsetting: given a filtered child set, automatically pull in the parent rows those children reference — the transitive closure over the foreign-key graph, the same problem pg_dump's --table and Jailer-style extractors solve. sluice files this as a deferred follow-on rather than half-implementing it, because it is hard in the ways that matter: cyclic foreign keys, self-references, and the performance of computing the closure over a large graph. A partial version that handled the easy cases and silently mishandled the cycles would be worse than an honest refusal. So Phase 1 ships the simple, predictable predicate plus a loud refusal and an explicit degrade, and names the closure as the thing still to build.

## The transferable lesson

When you add a filter to one table in a relational database, you have not made a local change — you have potentially invalidated every foreign key that points into it. "Filter each table independently" is a UI convenience, not a data model; the data model couples the tables through their keys, and a subset is only correct if it's referentially closed. Before you let a tool carve out a subset, ask what happens to the constraints that span the cut: does it validate them, degrade them silently, or refuse? The only safe answers are validate or refuse-with-an-explicit-opt-out. A subset that silently drops a foreign key to fit isn't a smaller copy of the database — it's a different database that happens to share its rows.

## Primary sources

- sluice ADR-0173 (row-level --where filter), §Decision Phase 1 "Referential integrity is the load-bearing gotcha" and §Consequences; CHANGELOG 0.99.276. The refusal SLUICE-E-WHERE-FK-ORPHAN and the --allow-degraded-fks degrade-to-NOT VALID path (Postgres target; refused on MySQL).

- Operator guide — filtered / subset migration (the full --where walkthrough, including the FK-orphan section and both reconciliation paths).

- Companion field notes — the optimization that trimmed away the column a later feature needed and the predicate you evaluate twice has to agree, or refuse (the two continuous-sync halves of the same row-level-filtering feature).

---
Canonical page: https://sluicesync.com/field-notes/filter-a-parent-orphans-the-child/ · Full docs index: https://sluicesync.com/llms.txt
