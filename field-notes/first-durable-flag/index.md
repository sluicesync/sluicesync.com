# The first durable flag

> Pushing a sync predicate into a Postgres publication row filter quietly changes the flag's lifetime: --where stops being per-process configuration and becomes durable source-side catalog state that outlives every restart. Warm resume deliberately never re-ensures the publication — so restarting with a widened, changed, or removed --where would leave the SERVER filtering on the stale predicate, unobservable client-side by construction. The honest options for a durable filter: re-assert idempotently, or record-and-compare.

Observed &mdash; designing sluice's PG 15+ publication row-filter push-down (ADR-0176). The gap was the arc's release blocker, flagged by a blind audit with the pass's strongest convergence signal (four independent reviewers) and closed before the feature shipped in v0.99.290 &mdash; never released broken.

## A flag that outlives its process

Every flag a long-running tool takes is implicitly scoped to the process: restart with different flags, get different behavior. Pushing --where into a publication row filter breaks that contract without changing a single visible surface &mdash; the predicate now lives in the source's catalog, applied by the server to every change it decodes, and it stays there when the process exits. sluice's warm resume deliberately never touches the publication (re-asserting scope on resume is exactly the multi-writer hazard the scope guard exists for). So restarting a sync with a widened, changed, or entirely removed --where would have quietly kept the SERVER filtering on the old predicate &mdash; and the suppression is unobservable from the client by construction: no belt, no verifier, no log can see rows the server never decodes or sends. The removed-flag variant is the purest form &mdash; no filter in the config, no filter mentioned anywhere, rows silently withheld, green forever.

## Record-and-compare

The shipped pattern:

    cold start:   push the filter -> record row_filter_hash (a canonical fnv64a
                  over the sorted table -> predicate pairs) in the stream's
                  control row, beside slot_name and publication_name
    warm resume:  recompute the hash from the CURRENT --where flags
                  compare to the record
                  mismatch -> refuse loudly: SLUICE-E-WHERE-PUSHDOWN-DRIFT

The refusal names the two escapes: re-pass the original predicate (you didn't mean to change it), or --restart-from-scratch (you did &mdash; and a widened filter needs the re-snapshot for correctness anyway, since rows newly in scope were never bulk-copied). Both escapes are exempt from the comparison, so the refusal can never block its own remedies. Pinned end to end on real PG: widened and removed --where both refuse &mdash; both silently resumed before the fix.

## Why not just re-push? The VStream contrast

sluice's Vitess sibling never needed any of this: the VStream filter rides the session &mdash; it's re-pushed from the current flags on every resume, so the server state and the process flags cannot drift; stateless reconciliation is free. A publication is the opposite kind of object: durable, shared, catalog-resident. For durable server-side state there are exactly two honest shapes &mdash; re-assert idempotently on every resume (ruled out here by the multi-writer guard), or record what you pushed and compare on every resume, refusing drift. What is not honest is the accidental third shape the gap embodied: write once, never look again, and let the process's flags and the server's behavior diverge unobservably.

## The transferable lesson

Audit your flags for the ones that materialize as server-side state &mdash; publication row filters, MySQL replication filters, Debezium snapshot predicates, anything a &ldquo;setup&rdquo; step writes into the source. Each such flag has silently changed its lifetime from per-process to durable, and your resume path inherits a consistency obligation nobody wrote down: either the server state is reconciled from current config on every start, or the pushed state is recorded and drift refuses loudly. If neither, the flag's documentation is lying about what a restart does.

## Primary sources

- sluice ADR-0176 and v0.99.290: the row_filter_hash ratchet (internal/pipeline/streamer_publication_ratchet.go; the column is publication_name's sibling on both engines' control stores), SLUICE-E-WHERE-PUSHDOWN-DRIFT, and the end-to-end drift pin publication_pushdown_drift_pg_integration_test.go.

- The 2026-07-23 audit's D0-2 finding (confirmed independently by four reviewers, incl. the zero-signal removed-flag variant and the VStream contrast).

- Related field notes &mdash; two syncs, one publication (why warm resume must not re-assert scope) and the change stream that won't drop your row (the session-scoped sibling).

---
Canonical page: https://sluicesync.com/field-notes/first-durable-flag/ · Full docs index: https://sluicesync.com/llms.txt
