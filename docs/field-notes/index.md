# Field Notes

> War stories from building a correctness-first migration tool — the engine behaviors, wire-protocol edges, and silent-corruption classes we hit, and what we changed because of them.

sluice's first tenet is that a migration must never silently corrupt or lose data — a loud failure you can act on beats an exit 0 that quietly dropped four thousand rows. Living up to that means chasing down a lot of surprising database behavior: drivers that pick a different binary codec per column type, managed services with hidden query limits, replication phases that disagree with each other, precision edges that only bite above a specific integer. This section is where we write those up.

Field notes are evergreen engine-behavior documentation, not release announcements. Each one is a real thing we hit — most of them silent-corruption classes caught by fuzzing, battle-testing, or differential runs — with the mechanism explained, a repro you can run yourself, what sluice does about it, and the transferable lesson for anyone building on the same engines. Where the root cause is upstream (an open MySQL bug, a Vitess design choice), we say so and cite the public source; where it was our bug, we name it and link the fix.

None of these require sluice to reproduce — they are properties of Postgres, MySQL, Vitess, SQLite, and the wire protocols and drivers around them. If you move data between databases for a living, several of them will eventually be your problem too.

## Postgres

- The same bytes, a different codec: how numeric[][] silently flattened — a driver that selects its binary codec per target OID turned a 2&times;2 matrix into a flat four-element array, on byte-identical code that round-tripped int[][] perfectly.

## MySQL & Vitess

- PlanetScale acked our rows, then a storage-grow reparent un-acked them — committed, client-acknowledged rows that simply weren't on the new primary after a volume-grow reparent. Exit 0, ~4,000 rows short.

- Vitess's copy phase rounds your FLOATs; its binlog phase doesn't — a 17-year-old MySQL display-rounding bug with a fresh consequence: the same FLOAT arrives exact or rounded depending on which VStream phase delivered it.

- vtgate erases the throttle signal: every VStream consumer is throttle-blind — the one in-band flag that says &ldquo;this stream is throttled, wait&rdquo; is deleted before any gRPC client can see it, so a throttled stream is indistinguishable from a hung one.

- The binlog keeps your SQL comments — and our TRUNCATE parser didn't know — a leading -- comment on a TRUNCATE made a CDC reader miss it entirely; the source emptied, the target kept every row, forever.

## Cross-cutting

- 253 is a database boundary now — JSON has one number type and it's a double, so every JSON hop in a pipeline is a potential rounding event for Snowflake IDs and any integer past 9,007,199,254,740,992.

These notes are also swept into llms.txt / llms-full.txt, so an AI assistant pointed at sluice's docs inherits this engine lore too.

---
Canonical page: https://sluicesync.com/docs/field-notes/ · Full docs index: https://sluicesync.com/llms.txt
