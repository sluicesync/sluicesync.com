# MariaDB has no BEGIN, and won't tell you if your position survived

> Porting a MySQL binlog CDC reader to MariaDB surfaces two assumptions MySQL quietly baked in. A MariaDB transaction opens with a MariadbGTIDEvent and no BEGIN, so a pump that only handles MySQL's GTIDEvent never advances its position. And you cannot pre-check whether your resume position still exists: @@gtid_binlog_state is unchanged across PURGE BINARY LOGS, so a dead position looks live — the only honest signal is the stream itself throwing error 1236.

Observed — porting sluice's MySQL binlog CDC reader to MariaDB (v0.99.271, ADR-0170), ground-truthed on mariadb:11.4 and mariadb:10.11. Two roadmap-draft premises were falsified by the live probe; both are below.

## Assumption one: a transaction opens with BEGIN

A MySQL transaction opens with a BEGIN QueryEvent, and a binlog reader keys its transaction boundary — and its GTID accumulation — off that event. MariaDB emits no BEGIN. A plain-DML transaction is exactly:

    MARIADB_GTID  ->  TABLE_MAP  ->  WRITE/UPDATE/DELETE_ROWS  ->  XID

and the opening event is a MariadbGTIDEvent — a different event type from MySQL's GTIDEvent. A pump that handles only GTIDEvent never sees a transaction boundary and never advances its GTID set, so every resume position it emits is stale. That is not a crash; it is a silent wrong-position gap on the next restart. The fix is to handle MariadbGTIDEvent as the transaction opener and synthesize the begin the vanilla pump expected.

Folklore correction. The oft-repeated claim that MariaDB emits a per-transaction dummy QueryEvent you must filter &ldquo;for performance&rdquo; is false on the current LTS lines — there is no dummy event. Adding an over-broad filter &ldquo;to be safe&rdquo; is exactly how you would silently skip a real DDL.

## Assumption two: you can ask whether your position still exists

Before resuming, you would like to ask the server: is my saved position still in the binlog? On MySQL you can. On MariaDB there is no honest way. It has no GTID_SUBSET function and no @@gtid_purged. The tempting variable, @@gtid_binlog_state, reports the newest GTID per domain — and it is completely unchanged across PURGE BINARY LOGS. Ground-truthed: it read 0-1-15 before purging every prior file and 0-1-15 after. So a position below the purged floor is indistinguishable from a live one; a naive containment check returns a false &ldquo;reachable.&rdquo;

The only faithful signal is the stream itself. Starting replication from a purged position throws error 1236 (&ldquo;Could not find GTID state requested by slave in any binlog files&hellip;&rdquo;) on the first event. sluice classifies that reactive error as an invalid position and routes it to a clean cold-start re-snapshot rather than a silent wrong-position stream. Reachability on MariaDB is only knowable by trying.

## The shape underneath: domain GTIDs

MariaDB's GTIDs are domain-server-sequence (e.g. 0-1-15), not MySQL's server_uuid:sequence. Cold-start reads the position from @@gtid_binlog_pos (not @@gtid_current_pos), and the reader parses, serializes, resumes, and advances the domain-based set per event. The master-status probe accepts SHOW BINLOG STATUS (MariaDB's spelling, working on 10.11+) alongside the older forms, so no supported server pays an extra round-trip.

## The transferable lesson

A &ldquo;resume position&rdquo; is only as safe as the server's ability to tell you it is still reachable — and that ability is not universal even across engines that share a binlog format. Two things a MySQL reader assumes for free, MariaDB withholds: a transaction boundary you can key on, and a way to test a position without streaming it. When you port a replication reader, do not trust that the transaction opens the way you expect or that a reachability check exists; verify both against the live server, and design the purged-position path around a reactive error, because that may be the only signal you get.

## Primary sources

- sluice ADR-0170 (MariaDB flavor Phase 3 — CDC; the MariadbGTIDEvent pump fix and the reachability model) and CHANGELOG 0.99.271; ground-truthed on mariadb:11.4 and mariadb:10.11.

- MariaDB Knowledge Base — Global Transaction ID (domain-server-sequence), @@gtid_binlog_pos / @@gtid_binlog_state, and SHOW BINLOG STATUS.

- Related field note: the position that leads or trails the data — another way a resume position and the data it names can disagree.

---
Canonical page: https://sluicesync.com/field-notes/mariadb-gtid-no-begin/ · Full docs index: https://sluicesync.com/llms.txt
