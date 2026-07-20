# Field Notes

> War stories from building a correctness-first migration tool — the engine behaviors, wire-protocol edges, and silent-corruption classes we hit, and what we changed because of them.

sluice's first tenet is that a migration must never silently corrupt or lose data — a loud failure you can act on beats an exit 0 that quietly dropped four thousand rows. Living up to that means chasing down a lot of surprising database behavior: drivers that pick a different binary codec per column type, managed services with hidden query limits, replication phases that disagree with each other, precision edges that only bite above a specific integer. This section is where we write those up.

Field notes are evergreen engine-behavior documentation, not release announcements. Each one is a real thing we hit — most of them silent-corruption classes caught by fuzzing, battle-testing, or differential runs — with the mechanism explained, a repro you can run yourself, what sluice does about it, and the transferable lesson for anyone building on the same engines. Where the root cause is upstream (an open MySQL bug, a Vitess design choice), we say so and cite the public source; where it was our bug, we name it and link the fix.

None of these require sluice to reproduce — they are properties of Postgres, MySQL, Vitess, SQLite, and the wire protocols and drivers around them. If you move data between databases for a living, several of them will eventually be your problem too.

They're listed newest first, each dated to roughly when the work landed in sluice. The engine tag is just a signpost — the primary ordering is chronological, not by engine.

- 2026-07-20MariaDB MySQL 8 has this collation column; MariaDB added it in 12.1 — MySQL 8 has a first-class information_schema.COLLATIONS.PAD_ATTRIBUTE column telling you whether a collation compares PAD SPACE (trailing spaces ignored in =) or NO PAD. MariaDB shipped without it for years &mdash; it's absent through the entire 11.x LTS line and 12.0, and only appears in 12.1+. So on the MariaDB most people run, the attribute that decides whether 'EU' matches a stored 'EU ' isn't in the catalog at all, and you're left reading the _nopad_ token in the collation name. A cross-version reader can't assume the column is present or absent; the only version-robust signals are the name and the server's own behavior &mdash; which is why sluice's parity gate probes both.

- 2026-07-18MySQL & Vitess The = that ignores your trailing spaces — On a MySQL legacy collation (utf8mb4_general_ci, _bin, latin1_* — every collation except the 8.0 _0900_ ones), WHERE region = 'EU' matches a stored 'EU ': those collations are PAD SPACE and ignore trailing spaces in =. The modern _0900_ collations are NO PAD and don't. Reuse a comparator that folds case and accents but doesn't check the collation's PAD_ATTRIBUTE and it silently disagrees with the source on the default legacy collation &mdash; a real, shipped silent row-loss. It shipped green because the test compared the comparator to itself; the fix was to compare it to a real server.

- 2026-07-18MySQL & Vitess You can't reimplement MySQL's =, so link its comparator in — A filtered change stream evaluates region = 'EU' client-side, and it has to match the source's own = exactly &mdash; but MySQL's default collation is case- and accent-insensitive, and reimplementing that (ToLower? Unicode folding?) is a guess that diverges on &szlig;, the Turkish dotless i, and locale tailoring. The fix isn't a better reimplementation: it's linking the source engine's own comparator (Vitess's collations + evalengine) and calling it under the column's collation. That closes the case/accent axis &mdash; but linking is necessary, not sufficient (the library folds case and accents but not the collation's PAD attribute or charset), so the reuse still has to be ground-truthed against the real server's own =, not against the library. Use its implementation, not your model of it &mdash; then verify against the real thing.

- 2026-07-18MySQL & Vitess The change stream that won't drop your row — To filter a Vitess VStream server-side you push a where into its rule &mdash; and then fear the move-OUT: a row updated so it no longer matches, that the stream might silently drop instead of delete, leaking a stale row. The Vitess source settles it: for a non-vindex filter, if either the before- or after-image passes, VStream emits the change with both images. So a move-OUT arrives as a full UPDATE, never dropped &mdash; but VStream tells you that the row touched the filter, not which image matched, so you must still classify the move direction yourself.

- 2026-07-17Cross-cutting You can't filter a parent table without orphaning its children — Row-level filtering reads like a per-table setting, but a relational schema couples the filters through its foreign keys. Filter a parent (--where users=country IN ('US','CA')) and copy the children whole, and the deferred ADD CONSTRAINT FOREIGN KEY fails with SQLSTATE 23503 &mdash; the kept child rows point at parents the filter excluded. A tool that quietly dropped the key would hand you a database that looks complete and violates its own schema; sluice refuses loudly (SLUICE-E-WHERE-FK-ORPHAN), names the constraint, and makes you filter consistently or opt into an explicit NOT VALID degrade.

- 2026-07-17Cross-cutting The predicate you evaluate twice has to agree, or refuse — No source delivers a filtered change stream, so filtered CDC evaluates the --where predicate client-side, per event &mdash; the same predicate the migrate leg pushed down to the source. A byte-exact client compare of name = 'ANA' diverges from a case-insensitive collation, silently leaking or dropping rows &mdash; so sluice refuses at sync-start (SLUICE-E-WHERE-CDC-UNSUPPORTED-PREDICATE) anything it can't reproduce faithfully. When the same predicate runs in two engines, prove they agree or refuse; never approximate.

- 2026-07-17Cross-cutting The optimization that trimmed away the column a later feature needed — Filtered CDC (sync --where country IN ('US','CA')) has one hard case: an UPDATE that moves a row out of the filter must become a target DELETE, or the out-of-scope row silently leaks. sluice designed exactly that &mdash; then it leaked anyway, because both CDC readers already narrow the UPDATE before-image down to the primary key, so the filtered column was gone before the predicate saw it. A data-narrowing optimization can silently defeat a feature added later, and only end-to-end testing over the real stream witnesses it.

- 2026-07-17MariaDB MariaDB and MySQL 8 disagree on which coordinate comes first — Migrate a POINT in SRID 4326 from MariaDB to MySQL 8 and a naive ST_AsText diff shows longitude and latitude swapped. Nothing is corrupt: sluice copied the WKB faithfully and the point is in the same place &mdash; ST_Latitude/ST_Longitude match exactly. The two engines simply default to opposite axis orders when they display a geographic SRID; compare the coordinates, not the rendered text.

- 2026-07-17MariaDB MariaDB 11.4's default collation doesn't exist on MySQL 8 — MariaDB 11.4 defaults every string column to utf8mb4_uca1400_ai_ci (UCA 14.0.0) &mdash; a collation MySQL 8 has never heard of. Migrate to a MySQL-family target and sluice maps it to the closest equivalent, utf8mb4_0900_ai_ci (UCA 9.0.0), preserves every byte, and WARNs on nearly every string column. The warning is deliberate honesty, not a failure: the data is intact; only the sort order of the handful of characters that changed between UCA 14 and UCA 9 &mdash; and PAD semantics &mdash; can differ.

- 2026-07-17Postgres ACTIVE_HEALTHY through a five-minute recovery — Flooding a 1 GB Supabase Micro with WAL pushed it into crash recovery &mdash; every connection refused for five and a half minutes &mdash; while the Management API kept reporting status=ACTIVE_HEALTHY. A control-plane status field is an assertion of intent, not a data-plane liveness signal &mdash; misleading for backend readiness, so probe with a real query. And a logical slot's WAL runway is set by the compute tier (512 MB Micro, 2 GB Small), not the PITR add-on.

- 2026-07-17Cross-cutting gocloud classifies "301" by substring — sluice's backup-chain CAS maps S3's 412 PreconditionFailed to a coded conflict refusal &mdash; through gocloud, whose s3blob classifier carries strings.Contains(err.Error(), "301"). S3 stamps a random hex RequestID on every response, so about 2% of the time a genuine 412 is misread as NoSuchBucket → NotFound. An HTTP status code is a three-digit needle in a haystack of opaque identifiers; classify from the structured API error, never from a substring of the rendered string.

- 2026-07-17Postgres The read replica is a better migrate source and a worse CDC source than the docs — &ldquo;You can't do logical replication from a read replica&rdquo; is Postgres &le;15 lore, and PG 16 flipped both halves of it in opposite directions. pg_export_snapshot() now works on a standby &mdash; a fully snapshot-consistent bulk-migrate source the docs still say is impossible &mdash; while a slot can be created but CREATE_REPLICATION_SLOT hangs on an idle primary, and the publication DDL CDC needs can't run on a hot standby at all.

- 2026-07-17MySQL & Vitess The row image you can't preflight, because a proxy is in the way — Under self-hosted Vitess with binlog_row_image=NOBLOB, an UPDATE omits an unchanged BLOB &mdash; the same silent-overwrite class as the binlog NOBLOB note, one door over. But the vanilla fix, reading @@GLOBAL.binlog_row_image at stream start, is structurally impossible here: sluice connects to a vtgate, a proxy in front of a fleet of tablets with no single row-image posture to read. The authoritative signal is the wire itself &mdash; and the layer underneath is loud when the flag is off and goes silent exactly when it's on.

- 2026-07-17MariaDB MariaDB has no BEGIN, and won't tell you if your position survived — A MySQL transaction opens with a BEGIN QueryEvent; a MariaDB one opens with a MariadbGTIDEvent and no BEGIN at all, so a pump that only handles MySQL's GTIDEvent never advances its position. And you can't pre-check reachability: @@gtid_binlog_state is completely unchanged across PURGE BINARY LOGS, so a dead position looks live &mdash; the only honest signal is the stream throwing error 1236.

- 2026-07-17MariaDB The type that migrates clean and corrupts under CDC — MariaDB's native uuid/inet6/inet4 round-trip perfectly under a bulk migrate &mdash; the driver hands them back as formatted text. Turn on CDC and the same columns can corrupt: the binlog carries the raw storage bytes, and the loudness is target-dependent &mdash; a Postgres target rejects the garbage string, a MySQL-family CHAR(36) silently accepts it. &ldquo;It migrated fine&rdquo; tells you nothing about the CDC path.

- 2026-07-17MariaDB MariaDB accepts a geometry SRID it won't show you — Declare POINT REF_SYSTEM_ID=4326 and MariaDB stores the SRID &mdash; but SHOW CREATE TABLE echoes the column as a bare point DEFAULT NULL, and unlike MySQL 8 there's no srs_id catalog column. Read the SRID the obvious way and every geometry column silently comes back as SRID 0. The declared value lives only in the OGC-standard GEOMETRY_COLUMNS view.

- 2026-07-17MariaDB The join that's 1:1 on MySQL 8 and fans out on MariaDB — MariaDB stores a JSON column as LONGTEXT plus an auto-CHECK named after the column, and its constraint names are unique per-table, not per-schema. A catalog join that's provably 1:1 on MySQL 8 becomes a cartesian fan-out on MariaDB &mdash; two tables with a meta JSON column each are enough to emit a duplicate CHECK and fail CREATE TABLE. And the fix can't be symmetric: MySQL 8's CHECK_CONSTRAINTS has no TABLE_NAME column to join on.

- 2026-07-17MySQL & Vitess The retention variable that tells five different truths — binlog_expire_logs_seconds means five different things across DigitalOcean, RDS, Cloud SQL, Vultr, and Azure: on two it lies (days on the label, minutes in practice), on one it's honest and enforced, on one it's honest the other way (never-expire), and on one there's no knob behind it at all. The number isn't the answer &mdash; whether anything SQL-visible is decides whether a tool can detect the trap or only guess from the hostname.

- 2026-07-17MySQL & Vitess The platform default that eats every UPDATE — Azure Database for MySQL ships binlog_row_image=MINIMAL, under which an UPDATE's before-image carries only the primary key. A CDC applier builds a WHERE that matches nothing, replay-tolerance swallows the zero-row miss, and every UPDATE silently vanishes on a green stream. Azure is the first major platform to default to MINIMAL &mdash; and PARTIAL_JSON is the same class one knob over.

- 2026-07-17Postgres The one-line fix that unpinned itself through the pooler — Pinning extra_float_digits=3 before you read sounds like one line. It's four &mdash; sluice renders floats as text in four different sessions, including the verifier that was blessing the corruption it exists to catch &mdash; and a bare SET before a COPY lands on two different backends under a transaction-mode pooler, silently unpinned, while the fix's own hint steered users onto that pooler.

- 2026-07-17Postgres Your floats are fine; your diff tool is comparing two renderings — One server sets extra_float_digits=0, another the modern default of 1, and every text-level float comparison between them reports differences that don't exist &mdash; the bits are identical, only the rendering moved. The reassuring direction (data exact, report wrong) is what makes it waste hours; and if any stage of your pipeline moves floats as text, the setting stops being cosmetic.

- 2026-07-17Postgres pgx's AfterConnect replaces, it doesn't chain — pgx stdlib gives you one slot to run per-connection setup. Install a session GUC pin and a PostGIS codec through it and the second silently evicts the first &mdash; no error, one feature just stops working on exactly the connections that need it. A single-writer callback slot is a shared resource; composition has to be the only way in.

- 2026-07-17Postgres information_schema reports a numeric scale of 2046 — Since PG 15, numeric(5,-2) is legal &mdash; and information_schema.columns reports its scale as 2046. The catalog view masks an 11-bit two's-complement scale field without sign-extending it, so the portable, standards-blessed way to read numeric scale is quietly wrong for every negative-scale column. When a number looks impossible, read the typmod.

- 2026-07-16MariaDB MariaDB reports its defaults in a different dialect — Side by side on the same DDL, MariaDB's information_schema speaks a different dialect than MySQL 8's: string defaults keep their quotes, a defaultless nullable column's default is the literal word NULL, and DEFAULT CURRENT_TIMESTAMP reads as current_timestamp() with an empty extra. A MySQL-convention reader silently corrupts every default &mdash; and SYSTEM VERSIONED tables and SEQUENCEs hide from the BASE TABLE filter entirely.

- 2026-07-16Postgres The heartbeat aged seven hours at write time — A concurrent-run guard compared time.Now() against a heartbeat written with CURRENT_TIMESTAMP into a bare timestamp &mdash; a value Postgres stores in the server's zone and pgx reads back as UTC. The age is wrong by exactly the server's offset, and the offset's sign picks the failure: a live guard goes inert, or a crashed run's resume is falsely refused. Arithmetically invisible on every UTC CI container.

- 2026-07-16Postgres The privilege catalog is not the permission system — Three live-proven ways the privilege catalog lied on one cloud provider: the RDS master role shows rolreplication=f yet creates logical slots (membership, not attribute); SHOW GRANTS shows RELOAD yet FLUSH TABLES WITH READ LOCK returns 1045; and the capability probe checked a predefined role that exists in no stock Postgres. The grant table describes a permission model, it isn't one.

- 2026-07-16Postgres The crash was the good outcome — sluice's trigger-CDC captures change images with to_jsonb(), and JSON has no token for a non-finite float &mdash; so Infinity travels as a string. The array-element decoder skipped it and the apply loop crashed loudly. That was the value contract working: a blind float64 coercion would have truncated a numeric[] element and turned a text[] holding the word &ldquo;Infinity&rdquo; into a number.

- 2026-07-16Postgres The parent table that returns rows it doesn't own — Old-style INHERITS parents present to information_schema as ordinary, unrelated BASE TABLEs &mdash; while a SELECT on the parent, without ONLY, also returns every child's rows. The standard enumerate-and-copy recipe lands the child data twice, silently, exit 0 &mdash; and the same filter hides FDW foreign tables entirely.

- 2026-07-16Cross-cutting The Parquet library nulled every false — Hand parquet-go rows as map[string]any and it decides NULL-vs-present for optional columns by asking whether the Go value is the zero value &mdash; so false, 0, "", and the epoch all silently export as NULL. And a Parquet NULL reads back as exactly the zero value, so the naive round-trip test goes green while the file says NULL.

- 2026-07-16Cross-cutting CSV has no NULL — RFC 4180 says nothing about NULL, so the convention rides on the quoted/unquoted distinction &mdash; which Go's encoding/csv collapses. And at exactly one column wide, the universal skip-blank-lines convention is byte-indistinguishable from a legitimate record whose only field is empty: a NULL row, silently eaten.

- 2026-07-16MySQL & Vitess "mydumper format" is a family, not a spec — pscale database dump produces &ldquo;mydumper format&rdquo; &mdash; byte-compatible enough that one reader serves both. The shared layout hides three producer forks: binary travels differently, string quoting differs, and TIMESTAMP semantics hinge on a TIME_ZONE header one producer always writes and the other never does.

- 2026-07-16MySQL & Vitess Your dump already rounded your floats — mydumper renders single-precision FLOAT through mysqld's ~6-significant-digit formatter: 8388608 lands in the dump file as 8.38861e6, which parses back to a different float32 &mdash; while DOUBLE columns in the very same run dump at full precision. The loss is in the file, at dump time.

- 2026-07-16MySQL & Vitess mydumper chunk numbers are PK ranges, not a sequence — Healthy dumps have numbering gaps, -r dumps start at 00001, and a deleted trailing chunk leaves no gap at all &mdash; so contiguity is neither necessary nor sufficient, a deleted middle chunk streams silently short at exit 0, and the real loss detector is the dump's own rows = metadata everyone skips as informational.

- 2026-07-16MySQL & Vitess The two MySQL escapes that keep their backslash — MySQL's escape table has a trap in its last two rows: \% and \_ evaluate to the two bytes backslash-percent and backslash-underscore &mdash; backslash kept &mdash; while every other unrecognized escape drops it. A uniform unescaper silently shortens the data by one byte.

- 2026-07-16Cross-cutting Persist a resume cursor as JSON and it silently teleports — Go's json.Marshal replaces invalid-UTF-8 bytes with U+FFFD and numbers ride float64 past 253 &mdash; so a resumed keyset walk skipped 73,100 of 100,000 rows at exit 0. A corrupted cursor doesn't corrupt a cell you might notice: it relocates the walk. Resume state is a codec too.

- 2026-07-16Cross-cutting Same document, different winner — RFC 8259 leaves duplicate JSON object keys undefined, and two engines picked opposite answers: SQLite's json_valid blesses them and reads the FIRST; Postgres jsonb keeps the LAST. Promote a &ldquo;validated&rdquo; text column to jsonb and you silently change which value every future query reads &mdash; validate with the destroyer, and you bless exactly what it destroys.

- 2026-07-16Postgres The alert cleared at the exact moment the slot died — When Postgres invalidates a replication slot, pg_replication_slots reports wal_status='lost' and the lag columns go NULL &mdash; not huge. Coerce NULL to zero, compute 0% pressure, and your threshold evaluator concludes the condition cleared &mdash; a false all-clear at precisely the moment the state became fatal.

- 2026-07-16MySQL & Vitess The dump reader skipped what it couldn't lex — and the verifier rode the same reader — A UTF-8 BOM glued to a chunk's first INSERT made the whole statement lex empty and vanish at exit 0 &mdash; and verify --depth count counted through the identical blind spot, confirming the loss instead of catching it. Then the fix's own third act: the refusal reached verify's report but not its exit code.

- 2026-07-16MySQL & Vitess Your dump reader is quadratic in a knob somebody else set — twice — A dump reader's cost was quadratic in statement size &mdash; mydumper's --statement-size, a knob the dump's producer set. We fixed it, benchmarked the layer, shipped &ldquo;order-of-magnitude&rdquo; &mdash; and the pipeline stayed quadratic, because the value decoder one layer down sized its buffers to the statement tail. Benchmark the pipeline, not the layer.

- 2026-07-16Cross-cutting The round-trip test that cannot see symmetric bugs — If your writer and every test pin read through the same library, the format boundary is self-consistent, not correct: a symmetric regression ships files the rest of the world can't read while your suite stays green. The fix isn't another test &mdash; it's a reader you don't ship. And the checker built to be that reader promptly demonstrated the class inside its own harness.

- 2026-07-16MySQL & Vitess The index that shares only a name — Detect-then-skip index builds trust the name &mdash; and when the source's UNIQUE index name-matches a plain INDEX on the target, the existing definition silently decides which duplicate writes the target accepts or refuses. Every step exits green; &ldquo;already exists&rdquo; is not &ldquo;already correct.&rdquo;

- 2026-07-16Cross-cutting Two things the Parquet export directory doesn't tell you — GeoParquet defines an omitted crs as &ldquo;this is lon/lat degrees&rdquo; &mdash; so an EPSG:3857 export without the stamp reads Web-Mercator meters as degrees, no error. And when read_parquet('dir/*.parquet') makes the directory the catalog, a re-export that only adds files leaves a dropped table's stale .parquet answering the glob as current data.

- 2026-07-16MySQL & Vitess Your replication "position" is an unbounded set — A MySQL GTID set grows with every server UUID that has ever written to the topology; a Vitess VGTID is that set again per shard. Checkpoint &ldquo;the position&rdquo; into a 64 KB TEXT column and you've stored an unbounded value in a bounded box &mdash; and on a non-strict server the overflow is a silently truncated position, discovered only at the next resume.

- 2026-07-16Postgres Postgres writes +00; your parser expects +00:00 — ISO 8601 admits at least four spellings of a UTC offset and Postgres COPY picks the shortest: bare +00. A layout list that stops at &plusmn;hh:mm refuses Postgres's own default text output &mdash; and the naive fix reads a time zone out of every bare date's day-of-month, because 2026-07-02 ends in exactly the two-digit offset shape.

- 2026-07-16Cross-cutting Object stores can now say "that changed since you read it" — the portability layer can't ask — Every writer of the backup-chain catalog was last-Put-wins. The textbook fix is compare-and-swap, and the stores now have it &mdash; but the portable object-store surface exposes only create-if-absent, so the guard is a CAS built from create-only claim markers, ground-truthed on real S3, GCS, and Azure &mdash; three stores that answer an occupied key with three different status codes, all absorbed in the error mapping &mdash; with the millisecond residual it can't close stated honestly.

- 2026-07-14MySQL & Vitess MySQL's own certificate can't pass verify-full — The certificate mysqld generates for itself carries no SubjectAltName, and modern Go won't fall back to the Common Name &mdash; so tls=true (verify-full) can never validate a stock MySQL server. The secure middle ground is Postgres's sslmode=verify-ca: trust a CA, verify the chain, skip the hostname the cert can't satisfy.

- 2026-07-12Cross-cutting An ALTER with no rows behind it is invisible to Postgres CDC — Postgres pgoutput never streams DDL &mdash; a schema change surfaces only as a RelationMessage, emitted lazily right before the first row for that table. So an ALTER &hellip; ADD COLUMN with no following writes leaves nothing in the stream. MySQL's binlog logs the same DDL as a first-class event at its own position, whether or not a row ever follows.

- 2026-07-10Cross-cutting A CDC position can lead or trail the rows it covers — Postgres and MySQL put a schema/DDL position before the rows it introduces; Vitess stamps its VGTID after the rows the commit covers, so a snapshot and its transaction's rows can share one token. A &ldquo;did we reach the boundary?&rdquo; check that's sound on one engine silently false-negatives on the other.

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
