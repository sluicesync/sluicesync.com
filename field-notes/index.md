# Field Notes

> War stories from building a correctness-first migration tool — the engine behaviors, wire-protocol edges, and silent-corruption classes we hit, and what we changed because of them.

sluice's first tenet is that a migration must never silently corrupt or lose data — a loud failure you can act on beats an exit 0 that quietly dropped four thousand rows. Living up to that means chasing down a lot of surprising database behavior: drivers that pick a different binary codec per column type, managed services with hidden query limits, replication phases that disagree with each other, precision edges that only bite above a specific integer. This section is where we write those up.

Field notes are evergreen engine-behavior documentation, not release announcements. Each one is a real thing we hit — most of them silent-corruption classes caught by fuzzing, battle-testing, or differential runs — with the mechanism explained, a repro you can run yourself, what sluice does about it, and the transferable lesson for anyone building on the same engines. Where the root cause is upstream (an open MySQL bug, a Vitess design choice), we say so and cite the public source; where it was our bug, we name it and link the fix.

None of these require sluice to reproduce — they are properties of Postgres, MySQL, Vitess, SQLite, and the wire protocols and drivers around them. If you move data between databases for a living, several of them will eventually be your problem too.

They're listed newest first, each dated to roughly when the work landed in sluice. The engine tag is just a signpost — the primary ordering is chronological, not by engine.

- 2026-07-09MySQL & Vitess When the row's own identity gets rounded — The VStream FLOAT repair re-reads exactly and matches by primary key &mdash; but when the FLOAT is in the key, the target's identity is itself rounded, so the match never lands, the repair silently no-ops, and --strict-float exits 0 with a rounded archive.

- 2026-07-09Cross-cutting A signature that verified green while restoring the wrong table's rows — A signed backup flattened every table's row chunks into one file-sorted list with no parent-table token, so swapping two same-column-set tables' chunk lists produced byte-identical signed bytes &mdash; every guard green, and table B's rows restored into table A.

- 2026-07-09Cross-cutting Three clouds, three ways to return an ECDSA signature — AWS and GCP hand back an ECDSA signature as ASN.1 DER; Azure returns raw r&#8214;s. Only GCP signs Ed25519, and only GCP wants a CRC32C integrity handshake in both directions. &ldquo;KMS signing&rdquo; is not one API.

- 2026-07-09MySQL & Vitess Vitess copy phase rounds your FLOATs — A 17-year-old MySQL display-rounding bug with a fresh consequence: the same FLOAT arrives exact or rounded depending on which VStream phase delivered it.

- 2026-07-08Postgres Comparing 32-bit transaction ids breaks after four billion of them — A trigger-CDC hold-back compared a change row's 32-bit xmin against a 64-bit xid8 snapshot bound. At XID epoch 0 they agree; past 232 lifetime transactions the predicate goes always-true and silently skips an in-flight transaction's rows.

- 2026-06-30SQLite & D1 Cloudflare D1 is not your local SQLite — A UUID-conformance GLOB passed every local test, then died on live D1 with code 7500: LIKE or GLOB pattern too complex. The dialect is the same; the hidden limits are a config surface you can't test against locally.

- 2026-06-29MySQL & Vitess When PlanetScale un-acked our rows — Committed, client-acknowledged rows that simply weren't on the new primary after a volume-grow reparent. Exit 0, ~4,000 rows short.

- 2026-06-29Cross-cutting 2^53 is a database boundary now — JSON has one number type and it's a double, so every JSON hop in a pipeline is a potential rounding event for Snowflake IDs and any integer past 9,007,199,254,740,992.

- 2026-06-28MySQL & Vitess The 20-second guillotine over a WAN — With no statement pipelining, an N-row apply costs N round-trips; every batch big enough to be efficient overran Vitess's 20 s timeout and every batch small enough to commit crawled. A self-tuning system converged to a stall.

- 2026-06-28SQLite & D1 One long-lived reader, 75 GB of WAL — A continuous-CDC run watched the -wal file grow to 75 GB in 52 minutes while the table it tracked stayed bounded; one idle reader's snapshot pinned every superseded page. Kill the process and it collapsed to ~0.6 GB.

- 2026-06-27SQLite & D1 SQLite's DECIMAL is a suggestion — Declare a column DECIMAL(10,2) and you get NUMERIC affinity, which stores 19.99 as 19.989999999999998. Not a rounding bug — an engine storage property, and the real predicate is dyadic representability.

- 2026-06-15Cross-cutting The zero value is a loaded gun — A config field that &ldquo;defaults on&rdquo; silently defaults off for every caller that didn't go through the CLI, because in Go every unset field gets the zero value. Twice, with real database consequences.

- 2026-06-13MySQL & Vitess vtgate erases the throttle signal — The one in-band flag that says &ldquo;this stream is throttled, wait&rdquo; is deleted before any gRPC client can see it, so a throttled stream is indistinguishable from a hung one.

- 2026-06-13MySQL & Vitess A comment hid a TRUNCATE from CDC — A leading -- comment on a TRUNCATE made a CDC reader miss it entirely; the source emptied, the target kept every row, forever.

- 2026-06-11Postgres Replication slots don't die with your process — A slot is a promise the server keeps until you drop it; a crashed backup, a refused cold-start, and a week-one leak each pinned WAL on the source until the disk filled.

- 2026-06-07MySQL & Vitess Setting workload=olap silently truncated our chunked reads — A one-line fix to lift vtgate's 100k-row cap set workload=olap session-wide; the parallel chunked reader inherited it and each chunk streamed only a prefix, so a 1.5M-row migrate copied 7,536 rows and exited 0 with migration complete.

- 2026-05-30MySQL & Vitess MySQL turned our emoji into '?' — MySQL substitutes ? for 4-byte UTF-8 in ENUM/SET labels at CREATE TABLE time regardless of column charset; the label is gone from the catalog before any client sees it.

- 2026-05-30Cross-cutting One redaction flag, two engines, two behaviors — --redact randomize:int:100000,200000 into a SMALLINT column loud-refused on a Postgres target and silently clamped every row to 32767 on a MySQL one &mdash; turning an anonymization rule into a constant, and a compliance guarantee into a compliance failure.

- 2026-05-28Postgres REPLICA IDENTITY FULL ate our UPDATEs — Building an UPDATE's WHERE over every old column works forever on int/varchar, then a jsonb value fails the equality round-trip, the UPDATE matches zero rows, and idempotency tolerance swallows the miss.

- 2026-05-17Postgres The pgx codec that flattened numeric[][] — A driver that selects its binary codec per target OID turned a 2&times;2 matrix into a flat four-element array, on byte-identical code that round-tripped int[][] perfectly.

- 2026-05-10Cross-cutting {}: two characters, two types — {} is an empty array in Postgres and an empty object in JSON; []byte("{}") is genuinely ambiguous, and for nine releases the MySQL writer resolved it the wrong way.

- 2026-05-07Postgres Every HA knob on, and the slot still vanished at failover — Patroni slot-sync on, sync_replication_slots on, hot_standby_feedback on &mdash; and a logical slot that hadn't advanced during the sync window was still lost on promotion. The idle slot is the fragile one.

- 2026-05-05MySQL & Vitess One LOAD DATA can't load a BLOB and a JSON column — A BLOB needs CHARACTER SET binary or the server rejects its first non-ASCII byte; a JSON column rejects its input under CHARACTER SET binary. One statement-level clause, two columns that demand opposite answers.

- 2026-05-04MySQL & Vitess MySQL won't match a JSON column by bind parameter — WHERE json_col = ? matches zero rows whether you bind the value as a string or as bytes &mdash; MySQL won't cast the parameter to JSON. On a CDC UPDATE, replay-idempotency tolerance turns the zero-row match into silent divergence.

These notes are also swept into llms.txt / llms-full.txt, so an AI assistant pointed at sluice's docs inherits this engine lore too.

---
Canonical page: https://sluicesync.com/field-notes/ · Full docs index: https://sluicesync.com/llms.txt
