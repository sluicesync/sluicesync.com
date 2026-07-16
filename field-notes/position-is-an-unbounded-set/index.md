# Your replication "position" is an unbounded set — and a 64 KB column caps it near 1,000 servers

> A MySQL GTID set grows with every server UUID that has ever written to the topology; a Vitess VGTID is that set again per shard. Checkpoint "the position" into a MySQL TEXT column and you've stored an unbounded value in a 64 KB box — and on a server without strict mode, the overflow is a silently truncated position, discovered only at the next resume.

Observed — a full inventory of sluice's own MySQL control tables (roadmap item 65a, fixed v0.99.249). Never observed overflowing in the field, and on sluice's connections it would have failed loudly (STRICT_TRANS_TABLES is pinned); the silent-truncation half of this note is standard non-strict MySQL semantics stated as reasoning, not a field observation.

## What happened

A replication position looks like a scalar — a number, a name — and for a single-server binlog coordinate it nearly is. A GTID set is not. It is a union of per-server-UUID interval lists (uuid:1-5000,uuid2:1-300,&hellip;), and its size is a function of topology history: every failover, clone, or promotion can introduce a server UUID that lives in the set from then on. A Vitess VGTID multiplies that again — one GTID set per shard, so resharding scales the token with the shard count.

Any CDC tool that persists &ldquo;the position&rdquo; therefore needs a column sized for an unbounded value. MySQL TEXT caps at 65,535 bytes — roughly 1,000 server-UUID entries at typical entry sizes, or one very heavily sharded VGTID. sluice's inventory found it had made this call correctly once and then re-made it wrong twice: the schema-history anchor column was LONGTEXT from day one, with a comment saying exactly why (&ldquo;for GTID sets can be long&rdquo;), while two sibling tables holding the same token had shipped as TEXT. Inconsistent sizing across sibling columns holding the same value is precisely how this class ships — the reasoning was done, recorded, and not propagated.

## The loud/silent split

What happens at byte 65,536 depends on a server setting the checkpoint writer may not control. With STRICT_TRANS_TABLES (sluice pins it), the INSERT/UPDATE errors and the position write aborts loudly mid-stream — recoverable, if inconvenient. On a server with strict mode disabled — still common in legacy configs — the value is silently truncated at the column limit with a warning nobody reads. A truncated GTID set is not detectably wrong: it parses, it's a valid set, it just describes less history than it should. The corruption manifests at the next resume as a position that re-fetches (or skips) work, which is the worst possible place for corruption to land — far from the write that caused it, wearing the costume of a replication bug.

## The coda: the one-line fix that gets refused

The remediation is a one-line ALTER &hellip; MODIFY &hellip; LONGTEXT — which, on a PlanetScale branch with safe migrations enabled, is itself refused with Error 1105, because safe migrations refuses direct DDL by statement class regardless of effect (a widen-in-place MODIFY included). So the shipped fix is detect-then-ALTER: probe information_schema for the column's current DATA_TYPE, issue the MODIFY only while it's still text (zero DDL on the already-wide path), and when a genuinely needed widen is blocked, refuse loudly carrying the exact ALTER for the operator to ship through a deploy request — never a silent skip. Fresh installs simply declare LONGTEXT. (Postgres is unaffected; its text is unbounded.)

## Reproducing it

The arithmetic first: one GTID-set entry is a 36-character server UUID plus its interval list (uuid:1-500000 &asymp; 45&ndash;60 bytes with separators), so a 65,535-byte TEXT column holds on the order of 1,000 entries — synthesize one past the cap and watch what your strict-mode posture does with it:

    mysql> CREATE TABLE ckpt (id INT PRIMARY KEY, pos TEXT);
    mysql> SET SESSION sql_mode = 'STRICT_TRANS_TABLES';
    mysql> INSERT INTO ckpt VALUES (1, REPEAT('a', 70000));
    ERROR 1406 (22001): Data too long for column 'pos'      -- loud abort

    mysql> SET SESSION sql_mode = '';
    mysql> INSERT INTO ckpt VALUES (2, REPEAT('a', 70000));
    Query OK, 1 row affected, 1 warning                     -- silently truncated
    mysql> SELECT LENGTH(pos) FROM ckpt WHERE id = 2;       -- 65535

The non-strict row is the field failure mode: a valid-parsing, shorter-than-written position discovered only at resume. The widen coda reproduces on any PlanetScale safe-migrations branch: ALTER TABLE ckpt MODIFY pos LONGTEXT is refused with Error 1105 even as a pure widen — which is why the fix must probe information_schema first and issue the ALTER only when the column is genuinely still text.

## The transferable lesson

Position tokens carry more structure than they look like they do. We've written before about a Postgres LSN being a coordinate in a reference frame rather than an absolute address; this is the size-shaped sibling: a MySQL/Vitess position is a set that grows with topology history, and &ldquo;how big can the position get?&rdquo; has no engine-provided answer. Size every column that stores an engine-opaque token as unbounded, and when you get that reasoning right once, grep for the siblings — the second and third columns holding the same value are where the corrected mistake quietly survives. And know your strict-mode posture: it is the difference between this bug aborting your stream and relocating your resume point.

## Primary sources

- MySQL Reference Manual — GTID format and storage (per-server-UUID interval lists), TEXT column size limits, and strict SQL mode vs silent truncation.

- Vitess documentation — VGTID (per-shard GTID sets in a keyspace position).

- sluice v0.99.249 changelog — the TEXT → LONGTEXT widen, the detect-then-ALTER shape, and the safe-migrations refusal path.

---
Canonical page: https://sluicesync.com/field-notes/position-is-an-unbounded-set/ · Full docs index: https://sluicesync.com/llms.txt
