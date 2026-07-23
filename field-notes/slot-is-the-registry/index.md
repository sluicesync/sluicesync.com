# The slot is the registry you already have

> sluice needed to answer 'is another stream still claiming a table scope on this Postgres source?'. The airtight-looking answer — a purpose-built stream→scope binding table — was rejected for a reason that generalizes: a source-side registry table is CREATE TABLE-permission-gated on exactly the restricted managed services where the guard matters most. The replication slot turned out to be the registry that was wanted all along: durable, source-side, per-stream, unconditionally present, and held for precisely as long as a stream intends to resume.

Observed &mdash; closing the documented residual window of sluice's publication scope-conflict guard (the two-syncs-one-publication starvation). Shipped in sluice v0.99.289; this note is that story's ending.

## The proxy and its window

As first shipped, the guard's conflict signal was slot activity: refuse a narrowing publication rescope while another sluice\_% slot is actively being read. Activity is a proxy, and its blind spot was precisely the operationally common state &mdash; a stream stopped mid-migration holds an INACTIVE slot and a resumable position that still expects its scope. A cold start timed inside that window could silently de-scope the stopped stream: it resumes later, advances normally, and receives nothing for its tables.

## Why the "airtight" registry table loses

The obvious closure is an explicit registry: persist a stream→scope binding in a control table and check that. It has to live on the source (concurrent streams may target entirely different databases, so no single target's control table is authoritative) &mdash; and a source-side table is where the design collapses. It needs CREATE TABLE privilege, which restricted managed services often withhold &mdash; so the guard would be strongest on permissive self-hosted sources and silently weakest exactly where operators most need it. It adds a persisted codec surface. And it needs lease/staleness semantics so a crashed stream's stale binding doesn't wedge every future cold start. Three costs, all avoidable.

## The registry you already have

A replication slot IS a stream→claim binding, maintained by Postgres itself: created per stream, durable across restarts, visible to every client of the source in pg_replication_slots, requiring no privilege beyond what CDC already needs, and dropped exactly when a stream is truly finished. So the guard's signal changed from activity to existence: any other sluice\_% slot &mdash; active or not &mdash; is a claim, because a slot's owner intends to resume. A stream with no slot must cold-start, and cold start re-asserts scope under this same guard; the window is closed for every stream that can still be starved.

## The honest cost, designed in

Postgres cannot tell &ldquo;finished forever&rdquo; from &ldquo;stopped and about to resume&rdquo; &mdash; so sequential different-scope runs against one source now refuse until the finished stream's slot is dropped, or each run names its own publication. That trade is deliberate, and sluice's own test suite paid it first (a pre-existing integration test ran two sequential legs with disjoint scopes and became the first &ldquo;operator&rdquo; the refusal stopped). A leftover slot pins WAL on the source anyway; a refusal that points at it, labels it inactive, and names the three escapes is a feature wearing the costume of friction.

## The transferable lesson

Before building a coordination registry, inventory the durable per-participant objects the system already maintains &mdash; and check your candidate registry's privilege profile against the environments where the guarantee matters most. A guard that silently degrades on restricted platforms is worse than a cruder signal that works unconditionally; and existence of a resource the participant must hold anyway is often the most honest liveness-independent claim available.

## Primary sources

- sluice ADR-0175 &mdash; the Alternatives entry recording the registry-table rejection (permission-gating decisive) and the "Residual risk &mdash; CLOSED (existence semantics)" section; the inactive-slot refusal pin asserting refuse-before-mutate on pg_publication_rel.

- PostgreSQL documentation &mdash; pg_replication_slots, slot durability and WAL retention.

- Related field note &mdash; two syncs, one publication (the starvation this guard exists to prevent).

---
Canonical page: https://sluicesync.com/field-notes/slot-is-the-registry/ · Full docs index: https://sluicesync.com/llms.txt
