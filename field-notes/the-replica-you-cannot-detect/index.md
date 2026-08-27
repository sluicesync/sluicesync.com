# The replica you can't detect is the replica that loses your writes

> A MySQL replica with log_replica_updates=OFF applies replicated writes without entering them in its own binlog, so CDC pointed at it silently misses the entire write stream the replica exists to carry — and GTID arithmetic (purged = executed − binlogged) turns the gap into a perpetual resnapshot loop. The probe that should refuse this configuration has a dialect trap of its own: on MariaDB, bare SHOW REPLICA STATUS lists only the default connection, so a named multi-source replica — on the fork that also defaults log_slave_updates to OFF — answers zero rows to every MySQL-style question.

Observed &mdash; the 2026-08-26/27 capture-completeness sweep and its follow-up audit. Two linked mysql:8.0.46 containers (GTID auto-position, replica running log_replica_updates=OFF): the primary's INSERTs were SQL-visible on the replica while its binlog stayed untouched &mdash; position frozen at 197, SHOW BINLOG EVENTS listing only Format_desc and Previous_gtids &mdash; and a direct local write was logged. Separately, on real MariaDB 11.4, twice independently: a CHANGE MASTER 'conn1' TO &hellip; named connection returned zero rows to bare SHOW REPLICA STATUS. sluice's refusal shipped in v0.132.0 and was extended to MariaDB named connections in v0.132.1 &mdash; after a fresh audit found the day-old door narrower than its name.

## Act one: the replica that loses your writes

Pointing CDC at a read replica is the natural offload move, and everything checks out at first: the replica's SQL layer shows all the data, so the cold copy is perfect. But a replica's SQL thread and its binlog are separate circuits. With log_replica_updates=OFF &mdash; ON by default since MySQL 8.0.3, commonly turned off on tuned replicas to save write amplification, and OFF by default on MariaDB (as log_slave_updates) &mdash; replicated transactions are applied without being written to the replica's own binlog. A direct local write is logged; everything arriving from the primary is not. So a binlog consumer attached to that replica captures local writes only, and silently misses the entire replicated stream &mdash; which on a read replica is essentially all of the writes.

GTID bookkeeping turns the quiet gap into visible churn with an invisible cause. The replicated GTIDs still enter gtid_executed &mdash; the server really did execute them &mdash; and gtid_purged is defined as executed minus what's still in the binlogs, so those GTIDs appear in gtid_purged immediately, not after retention expiry. A GTID-mode resume check therefore concludes its position was purged and triggers an automatic resnapshot &mdash; which completes, falls behind through the same hole, and resnapshots again, forever: a well-formed, healthy-looking loop, easily misdiagnosed as a retention problem, whose steady state is data loss. In file/position mode there is no tripwire at all &mdash; the stream just runs, silently incomplete, indefinitely.

## Act two: the replica you can't detect

The obvious refusal is a conjunction: the server is a configured replica and log updates are off. The second conjunct has a spelling split (MariaDB has no log_replica_updates at all &mdash; reading it errors &mdash; so a portable probe falls back to log_slave_updates, readable on both). It's the first conjunct that hides the trap. On MySQL, SHOW REPLICA STATUS returns one row per replication channel, multi-source included: the bare statement is channel-complete. On MariaDB, the identical statement reports only the default connection &mdash; and MariaDB's standard multi-source idiom is named connections (CHANGE MASTER 'conn1' TO &hellip;), which the bare form answers with zero rows. A statement that parses identically on both engines enumerates a different set on each.

The conjunction of defaults is what makes this dangerous rather than merely quirky: the fork whose replicas invisibly answer &ldquo;I'm not a replica&rdquo; is the same fork that defaults log_slave_updates=0. The undetectable replica is the lossy replica. MariaDB's complete spelling is its own extension &mdash; SHOW ALL REPLICAS STATUS &mdash; which MySQL rejects with a 1064 syntax error, so a portable probe must run both spelling families and reason about which server it's talking to from which spellings answered: a bare-form success plus an ALL-form syntax error identifies a channel-complete MySQL, where the bare answer stands.

## Act three: the door was narrower than its name, for exactly one release

sluice v0.132.0 shipped the refusal (SLUICE-E-CDC-REPLICA-NO-LOG-UPDATES) at every CDC-open chokepoint, ground-truthed on the linked-pair experiment above. One release later, a fresh audit of that same code found act two: the probe used only the bare spellings, so a MariaDB named-connection replica &mdash; the exact silent-loss configuration the door exists to refuse &mdash; walked straight through it. v0.132.1 extends the probe with the ALL spellings, pins the MySQL-syntax-error toleration so it can never degrade the door, and pins the whole thing against a real named-connection MariaDB with an anti-vacuity floor asserting the bare form really does return zero rows for it. One stated residual survives: where a restricted role can't run any status spelling (MariaDB 10.5+ splits this under the REPLICA MONITOR privilege), the probe warns and passes rather than refusing a working configuration &mdash; a detector's honesty about its own reach.

## The transferable lesson

Two lessons, one per act. First: a replica shows you all the data and is still not a complete change source unless it re-logs what it applies &mdash; this is the MySQL-binlog member of a three-engine family, alongside Postgres trigger capture missing replica-role writes and the PG 16 standby's asymmetric source capabilities: three mechanisms, one shape, &ldquo;reads complete, change feed not.&rdquo; Second: dialect traps aren't confined to DDL. A status statement can parse identically on two engines and enumerate a different set on each &mdash; so an empty result is only meaningful if you know which question the server actually heard, and a preflight built on such a statement inherits the dialect's blind spot until someone audits the gate itself. The gates get audited too; that's the part that turned one release's blind spot into a pinned class.

## Primary sources

- MySQL reference &mdash; log_replica_updates &mdash; whether the replica writes replicated transactions to its own binary log; ON by default since 8.0.3.

- MySQL reference &mdash; gtid_purged &mdash; the definition that makes the loop: GTIDs executed but no longer (or never) in the binlog.

- MariaDB documentation &mdash; multi-source replication and SHOW REPLICA STATUS &mdash; named connections, the default-connection scope of the bare statement, and the SHOW ALL REPLICAS STATUS spelling.

- sluice v0.132.0 and v0.132.1 changelogs &mdash; the refusal, the named-connection extension, and the verify-then-resnapshot guidance for anyone who was syncing from such a replica.

- Related field notes: Your trigger-based CDC can't see replicated writes; The read replica is a better migrate source and a worse CDC source than the docs.

---
Canonical page: https://sluicesync.com/field-notes/the-replica-you-cannot-detect/ · Full docs index: https://sluicesync.com/llms.txt
