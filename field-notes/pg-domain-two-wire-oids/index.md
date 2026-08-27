# A Postgres domain has a different type OID on each of the two wires

> On a regular query's wire, a domain column reports its base type's OID, so a driver decodes it with zero special handling. On the logical-replication wire, pgoutput reports the domain's own dynamic OID — with typmod -1, so even a varchar(10) base loses its length. The same driver round-trips the entire cold copy and then halts on the first CDC row.

Observed &mdash; sluice's Postgres CDC reader against domain-typed source columns (Bug 254 and the Bug 233 class), fixed across v0.128.0&ndash;v0.128.1. The regular-query half is pinned in-tree against real PostgreSQL over a base-type matrix; the replication half is pinned by a real-PG CDC round-trip test.

## The cliff

A PostgreSQL domain is a named constraint wrapper over a base type &mdash; CREATE DOMAIN usd_money AS money &mdash; ordinary, standard SQL. Sync a table that uses one and you get a clean operational cliff: the bulk cold copy of every row succeeds byte-for-byte, and the very first change that arrives over CDC kills the stream:

    postgres: cdc: unsupported column type OID <n> (typmod -1)

Same database, same column, same tool. The difference is which wire the value traveled on.

## Wire one: a regular query erases the domain

On the ordinary query protocol, PostgreSQL reports the base type's OID in the RowDescription for a domain column &mdash; a domain over int comes across as OID 23, the builtin int4, never the domain's own OID. A driver like pgx picks its codec by that reported OID, so it decodes and encodes the column as its base type with zero special handling: on this wire the domain is erased before any codec is chosen, and the cold copy is byte-identical to a bare base-type column. (sluice pins this fact against real PostgreSQL across a matrix of base types &mdash; including a domain over a domain &mdash; asserting the reported OID is the base's and is a builtin, because the entire value-safety argument of the copy path rests on it.)

## Wire two: logical replication keeps the domain

pgoutput does the opposite. A RelationMessage carries the domain column's own OID &mdash; the dynamic one Postgres assigned at CREATE DOMAIN time, typtype='d' in pg_type, unique per database &mdash; and reports the column's typmod as -1. So the replication wire strips the two things a decoder needs at once: the OID matches no built-in codec, and even a DOMAIN &hellip; AS varchar(10) has lost its length &mdash; the (10) lives only in pg_type.typtypmod, recoverable from the catalog and never off the wire. That dynamic OID is what the decoder hit, and why the halt names an OID your driver has never heard of.

The fix is the wire-side analogue of what schema readers already do: resolve the domain OID to its base through pg_type.typbasetype, carry the base's modifier from the catalog since the wire discarded it, flatten a domain-over-domain chain, and route a domain over an enum or array through those existing arms. Mutation-testing the fix &mdash; disabling the resolve arm &mdash; reproduces the exact halt.

## The third answer: your own schema model

Underneath both wires sits a third representation: the catalog's declared type, which a tool's schema reader surfaces as the domain wrapper itself. sluice found roughly a dozen internal sites that dispatched on that declared wrapper &mdash; a wrapper neither wire path ever sends &mdash; with consequences spanning the whole severity spectrum from one root cause: an over-refusal (--where filters rejected on domain columns), a mis-render (a domain over cidr shown as inet), and genuinely silent corruption (a domain over int skipping an integer-overflow redaction preflight; a domain over geometry wrongly eligible for a raw byte-pipe, its parquet export dropping the CRS so projected meters read back as degrees). Every such site now unwraps to the storage type, and a build-failing gate walks for the next dispatch site that forgets.

## The transferable lesson

One logical type wears three different clothes: its base OID on the query wire, its own dynamic OID on the replication wire, its wrapper in the catalog. Code that keys on any one of them silently disagrees with code that keys on another &mdash; and the disagreement surfaces at the worst seam, where the cold copy (one wire) has already succeeded and the ongoing stream (the other wire) is what dies. If you build against logical replication, test a domain-typed column explicitly: it is standard SQL, it is invisible on every query-path test you will ever write, and the replication wire is the one place Postgres refuses to flatten it for you.

## Primary sources

- PostgreSQL reference &mdash; CREATE DOMAIN.

- PostgreSQL reference &mdash; logical replication protocol &mdash; the RelationMessage carries the column's type OID as stored, domains included.

- PostgreSQL reference &mdash; pg_type &mdash; typtype='d', typbasetype, typtypmod: the only place the base and its modifier can be recovered.

- sluice v0.128.0 / v0.128.1 changelogs &mdash; the schema-dispatch unwrap and gate; the CDC wire-OID resolve (Bug 254).

- Related field note: pgoutput won't tell you a column's DEFAULT &mdash; another thing the replication wire withholds that the catalog knows.

---
Canonical page: https://sluicesync.com/field-notes/pg-domain-two-wire-oids/ · Full docs index: https://sluicesync.com/llms.txt
