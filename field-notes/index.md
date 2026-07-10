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

- 2026-06-22Cross-cutting A poller that re-reads all of history every tick — A backup broker rebuilt its entire lineage chain on every 30-second tick &mdash; ~2,000 object-store GETs per tick on a week-old stream, even when nothing had changed, with a tick that could outlast its own interval. Cost that grows with accumulated history, forever.

- 2026-06-20MySQL & Vitess ENUM is an ordinal and SET is a bitmask on the wire — In a raw binlog row event a MySQL ENUM is its 1-based ordinal and a SET is a numeric bitmask; the member-name list lives only in the table definition. Decode without the schema and SET('a','c') becomes "5". Snapshot and VStream hand you text, so it hides until raw CDC.

- 2026-06-18MySQL & Vitess Your primary key is only unique per shard — vtgate merges every Vitess/PlanetScale shard into one logical stream, but per-shard id ranges mean the same primary-key value legitimately exists on several shards. Copy them into one target table and the collisions silently overwrite &mdash; exit 0, rows short.

- 2026-06-17MySQL & Vitess A whole transaction in one zstd binlog event — MySQL 8.0.20+ can pack an entire transaction into a single compressed TRANSACTION_PAYLOAD_EVENT. A reader without a handler applies nothing and freezes its position with no error &mdash; and the server zeroes the inner events' end_log_pos, so a naive resume restarts mid-payload and dies.

- 2026-06-15Cross-cutting The zero value is a loaded gun — A config field that &ldquo;defaults on&rdquo; silently defaults off for every caller that didn't go through the CLI, because in Go every unset field gets the zero value. Twice, with real database consequences.

- 2026-06-13MySQL & Vitess vtgate erases the throttle signal — The one in-band flag that says &ldquo;this stream is throttled, wait&rdquo; is deleted before any gRPC client can see it, so a throttled stream is indistinguishable from a hung one.

- 2026-06-13MySQL & Vitess A comment hid a TRUNCATE from CDC — A leading -- comment on a TRUNCATE made a CDC reader miss it entirely; the source emptied, the target kept every row, forever.

- 2026-06-11Postgres Replication slots don't die with your process — A slot is a promise the server keeps until you drop it; a crashed backup, a refused cold-start, and a week-one leak each pinned WAL on the source until the disk filled.

- 2026-06-11Cross-cutting Rewriting the whole manifest, once per chunk — Every backup checkpoint re-wrote the entire manifest.json &mdash; and since the manifest grows with table count, the total work was quadratic: a measured ~78 hours at 100k tables. The fix's two obvious cousins are the same quadratic in disguise.

- 2026-06-10Cross-cutting One JSON blob in one row is a quadratic write — Storing all per-table progress as a single growing JSON blob, re-upserted on every checkpoint, is O(n&sup2;) &mdash; and on Postgres the amplification lands somewhere specific: a new tuple version plus a re-TOAST of the whole value, every time, on one hot row.

- 2026-06-09MySQL & Vitess The cold-start that buffered a whole table into swap — A 13 GB PlanetScale table drove the process to ~41 GB of RAM and got OOM-killed with zero rows written &mdash; because the VStream snapshot reader held the entire copy phase in memory. The buffer wasn't laziness; three engine behaviors forced it.

- 2026-06-08MySQL & Vitess BIGINT UNSIGNED overflows both bigint and int64 — A MySQL BIGINT UNSIGNED reaches 2&sup6;&#8308;&minus;1, past Postgres bigint's 2&sup6;&sup3;&minus;1 &mdash; and past Go's int64, so the driver hands it back as a uint64 that a []byte/string-only decoder can't route into a numeric or text target. Even the documented recovery was broken.

- 2026-06-07MySQL & Vitess Setting workload=olap silently truncated our chunked reads — A one-line fix to lift vtgate's 100k-row cap set workload=olap session-wide; the parallel chunked reader inherited it and each chunk streamed only a prefix, so a 1.5M-row migrate copied 7,536 rows and exited 0 with migration complete.

- 2026-06-03MySQL & Vitess The transaction that lands in neither the snapshot nor the binlog — Capture the consistent snapshot and the binlog position as two separate statements, and a transaction committing between them falls into the gap &mdash; after the frozen read view, below the recorded offset. It's in neither the copy nor the CDC tail. FLUSH TABLES WITH READ LOCK closes the seam.

- 2026-06-02Postgres Postgres text can't hold a NUL byte — text/varchar/char reject an embedded 0x00 with SQLSTATE 22021; MySQL char/text store it fine. Over COPY the rejection surfaces far from the offending row and reads cryptically &mdash; and stripping the byte would be silent corruption.

- 2026-05-31MySQL & Vitess MySQL TIME is a duration, not a time of day — A MySQL TIME ranges -838:59:59 to 838:59:59 and models elapsed duration, not clock time. Map it to Postgres time by name and any negative or over-24-hour value has nowhere to go &mdash; the target is interval.

- 2026-05-30MySQL & Vitess MySQL turned our emoji into '?' — MySQL substitutes ? for 4-byte UTF-8 in ENUM/SET labels at CREATE TABLE time regardless of column charset; the label is gone from the catalog before any client sees it.

- 2026-05-30Cross-cutting One redaction flag, two engines, two behaviors — --redact randomize:int:100000,200000 into a SMALLINT column loud-refused on a Postgres target and silently clamped every row to 32767 on a MySQL one &mdash; turning an anonymization rule into a constant, and a compliance guarantee into a compliance failure.

- 2026-05-28Postgres REPLICA IDENTITY FULL ate our UPDATEs — Building an UPDATE's WHERE over every old column works forever on int/varchar, then a jsonb value fails the equality round-trip, the UPDATE matches zero rows, and idempotency tolerance swallows the miss.

- 2026-05-25Cross-cutting The replication stream never tells you the column default — Neither pgoutput nor the MySQL binlog carries a column's DEFAULT. Forward an ADD COLUMN … DEFAULT now() over CDC and the target re-evaluates the default independently &mdash; so every pre-existing row gets a different value than the source's backfill.

- 2026-05-24Postgres CREATE IF NOT EXISTS is not a lock — CREATE TABLE/TYPE … IF NOT EXISTS does a catalog pre-check and then an insert, and the two steps aren't atomic. Race the same name from two connections and one gets a unique_violation on pg_class &mdash; from the statement that reads like it can't fail.

- 2026-05-23Postgres proto_version lets you parse streaming; only streaming='on' emits it — Two pgoutput knobs are easy to conflate, and the gap between them hides a silent-loss shape: if streaming ever activates and each chunk commits as its own transaction, a dropped StreamAbort leaves the pre-abort rows durably on the target &mdash; extra rows no checksum diff will catch.

- 2026-05-22Postgres A Postgres LSN means nothing without its timeline — Resume a logical-replication slot after a PITR or a promotion and the same LSN points into a different WAL reference frame &mdash; the source streams from it happily and events are silently skipped. MySQL gets this right for free with GTIDs; Postgres's raw LSN carries no provenance.

- 2026-05-20Cross-cutting BIT crosses the wire as bytes, and the engines disagree on layout — MySQL hands BIT(N) back as ceil(N/8) right-justified big-endian bytes; Postgres surfaces bit as a '0'/'1' text string. Carry the raw bytes between them and the value is silently corrupted &mdash; the ASCII of the digits, not the bits.

- 2026-05-17Postgres The pgx codec that flattened numeric[][] — A driver that selects its binary codec per target OID turned a 2&times;2 matrix into a flat four-element array, on byte-identical code that round-tripped int[][] perfectly.

- 2026-05-15Cross-cutting Count your bytes, not your rows — A batch size tuned for narrow OLTP rows &mdash; 5,000 rows, under 10 MB &mdash; quietly pins hundreds of MB the moment the workload is MB-scale TEXT, BYTEA, JSON, or geometry. The streaming paths were fine; only the two accumulators blew up.

- 2026-05-10Cross-cutting {}: two characters, two types — {} is an empty array in Postgres and an empty object in JSON; []byte("{}") is genuinely ambiguous, and for nine releases the MySQL writer resolved it the wrong way.

- 2026-05-08MySQL & Vitess One INSERT is three binlog events (or four) — A single-row INSERT lands in the binlog as three events (BEGIN / WRITE_ROWS / XID), plus a spurious empty BEGIN/COMMIT per new connection. If you size a rollover bound by INSERT count, budget 4&times; &mdash; and Postgres counts differently again.

- 2026-05-07Postgres Every HA knob on, and the slot still vanished at failover — Patroni slot-sync on, sync_replication_slots on, hot_standby_feedback on &mdash; and a logical slot that hadn't advanced during the sync window was still lost on promotion. The idle slot is the fragile one.

- 2026-05-05MySQL & Vitess parseTime governs the query protocol, not the binlog — parseTime=true on the DSN makes the query driver return time.Time — but the replication stream hands temporal columns back as raw strings regardless. The first TIMESTAMP row killed the CDC pump, and the silent-channel-close looked exactly like a network stall for two release cycles.

- 2026-05-05MySQL & Vitess One LOAD DATA can't load a BLOB and a JSON column — A BLOB needs CHARACTER SET binary or the server rejects its first non-ASCII byte; a JSON column rejects its input under CHARACTER SET binary. One statement-level clause, two columns that demand opposite answers.

- 2026-05-04MySQL & Vitess MySQL won't match a JSON column by bind parameter — WHERE json_col = ? matches zero rows whether you bind the value as a string or as bytes &mdash; MySQL won't cast the parameter to JSON. On a CDC UPDATE, replay-idempotency tolerance turns the zero-row match into silent divergence.

These notes are also swept into llms.txt / llms-full.txt, so an AI assistant pointed at sluice's docs inherits this engine lore too.

---
Canonical page: https://sluicesync.com/field-notes/ · Full docs index: https://sluicesync.com/llms.txt
