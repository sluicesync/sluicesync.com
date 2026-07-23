# The healthiest-looking way to lose rows on Postgres: two syncs, one publication

> Postgres logical replication splits the cursor from the filter: the slot records your position and pins WAL; the publication tells pgoutput which tables to emit — and nothing binds one to the other. Cold-start a second sync with a different table scope against a shared publication and its ALTER PUBLICATION … SET TABLE atomically replaces the member set, silently de-scoping the first stream: its slot stays healthy and keeps advancing while zero rows arrive, and every health surface stays green.

Observed &mdash; designing sluice's staged-&ldquo;wave&rdquo; migration support (move a database a few tables at a time, each wave its own sync). The failure was empirically reproduced against real Postgres before fixing: an integration gate run against deliberately-disabled fix code fails at exactly &ldquo;wave A stopped receiving changes after wave B cold-started.&rdquo; Fixed in sluice v0.99.287 (ADR-0175).

## The cursor and the filter are different objects

Postgres logical replication is built from two catalog objects that look like one system but share no binding. The replication slot is the cursor: it records how far a consumer has read and pins WAL until that point is confirmed. The publication is the filter: the object pgoutput consults &mdash; per START_REPLICATION, by name &mdash; to decide which tables' changes to emit. Nothing in the catalog ties a slot to a publication; slots reference WAL by LSN, not by publication membership. Two consumers can read two slots through one publication, and the publication can only ever express one filter.

## SET TABLE is an atomic replace

sluice's slot was always per-stream and operator-nameable. Its publication was a hardcoded sluice_pub &mdash; and every cold start ran:

    ALTER PUBLICATION sluice_pub SET TABLE sales.orders, sales.customers;
    -- SET TABLE does not add to the member set. It REPLACES it, atomically.

So cold-starting wave B (billing.*) against the same source as running wave A (sales.*) rewrote the shared filter to billing-only. From that instant, wave A's slot kept advancing &mdash; WAL still consumed, confirmed_flush_lsn still moving, because pgoutput reads and discards out-of-scope changes &mdash; while emitting nothing for wave A's tables. From Postgres's side, &ldquo;no in-scope changes happened&rdquo; and &ldquo;your tables were yanked from the publication&rdquo; are indistinguishable: same slot state, same advancing LSNs, same green health. And restarting the starved stream repaired nothing, because a warm resume never re-asserts scope &mdash; the publication is only written at cold start.

That is what makes this the healthiest-looking way to lose rows: every monitoring surface pointed at the cursor reports a current, advancing, active stream. The filter died, and health checks are structurally blind to filter clobbers.

## What sluice does about it

Two changes (v0.99.287). The load-bearing one: a cold start that would remove tables from a publication another active sluice\_% slot is reading refuses with SLUICE-E-CDC-PUBLICATION-SCOPE-CONFLICT &mdash; naming the at-risk tables and the conflicting slot &mdash; before mutating anything, so a refused attempt leaves every running stream untouched. Widening and equal-scope rescopes remove nothing and never trip it. Second, sync start gained --publication-name, the sibling of --slot-name, which is how you legitimately run several differently-scoped streams off one source: one publication per wave, nothing shared, nothing to clobber. (Update, v0.99.289: as first shipped the guard's conflict signal was slot activity &mdash; a proxy that missed a conflicting stream whose slot was momentarily inactive, e.g. stopped mid-migration. The guard now keys on slot existence: a slot, active or not, is the durable claim that a stream holds a scope and intends to resume, so that window is closed. The deliberate cost: sequential different-scope runs against one source now refuse until the finished stream's slot is dropped &mdash; or each run uses its own publication, which remains the airtight shape.)

## The transferable lesson

Any shared, mutable, source-side filter object is a multi-writer hazard, and health checks pointed at the cursor cannot see it break. Either guard the filter object itself &mdash; refuse scope-narrowing writes while another reader exists &mdash; or stop sharing it. And the ceiling on sharing is lower than it looks: PG 15+ hangs row filters and column lists off publication membership, so two streams with an identical table set can still clobber each other's per-table attributes. A shared publication can only ever express one stream's intent per table.

## Primary sources

- sluice ADR-0175 (publication scope isolation) and the two-concurrent-streamers integration gate publication_scope_conflict_pg_integration_test.go &mdash; verified non-vacuous by failing at the starvation assertion against disabled fix code; shipped v0.99.287.

- PostgreSQL documentation &mdash; ALTER PUBLICATION &hellip; SET TABLE (member-set replace), pg_publication_rel, and logical replication slots (position by LSN, no publication binding).

- Related field notes &mdash; the alert that cleared when the slot died and &ldquo;active&rdquo; is not liveness (the opposite failures: the slot itself is the problem &mdash; here the slot is fine and the filter died).

---
Canonical page: https://sluicesync.com/field-notes/two-syncs-one-publication/ · Full docs index: https://sluicesync.com/llms.txt
