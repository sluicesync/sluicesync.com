# The CDC stream that reports green and applies nothing

> Everyone knows row-based CDC needs binlog_format=ROW — the surprise is what a non-ROW source looks like from the consumer's side: nothing. A STATEMENT-format source cold-copies clean, then every change arrives as a QueryEvent the row dispatcher ignores — the target freezes at the snapshot, the persisted position never advances, the stream runs green, and shutdown exits nil. MIXED is the same class, and MIXED is MariaDB's platform default.

Observed &mdash; a real mysql:8.0 started with --binlog-format=STATEMENT, 2026-07-23: the filed &ldquo;quietly empty CDC stream&rdquo; premise was live-verified before sluice's gate shipped in v0.99.292. The silent mode existed on every earlier release; the engine behavior itself is by design (statement-based logging is a supported mode &mdash; just not one row-based CDC can replay).

## What a non-ROW source looks like: nothing

The requirement is folklore &mdash; row-based CDC needs binlog_format=ROW &mdash; but the failure shape when the source isn't ROW is worth seeing once, because it is total silence. The cold copy lands (3/3 rows in the observation &mdash; the target looks entirely plausible), and then every live INSERT/UPDATE/DELETE arrives as a QueryEvent: SQL text. A row-based dispatcher has an arm for QueryEvents &mdash; it consumes them for schema-cache invalidation, because that's how DDL arrives &mdash; and deliberately applies nothing from them, since executing arbitrary SQL text against the target is exactly what a row-based applier must never do. Every piece behaves correctly, and the composition loses everything:

    observed on mysql:8.0, binlog_format=STATEMENT (2026-07-23):

    cold copy    3/3 rows land            -- target looks right
    live DML     arrives as QueryEvents   -- generic-DDL arm: nothing applied
    target       frozen at the copy snapshot for the whole window
    position     never advances past the cold-start anchor (before == after)
    stream       keeps running, no error
    shutdown     exits nil

No error, no partial delivery, no log line. The stream is connected, consuming real events, heartbeating &mdash; and applying none of it. The worst silent-loss shape.

## MIXED is the same class &mdash; and it's MariaDB's default

Two sharpeners. First, MIXED is not a safe middle: the server statement-logs every write it judges deterministic, which is most DML, so a MIXED source loses most changes the same way &mdash; it's the same class, not a milder one. Second, the defaults split the family: MySQL 8.0 defaults to ROW, which hides the class from everyone who never touched the knob &mdash; while MIXED is MariaDB's platform default, so an un-tuned MariaDB source hits this out of the box.

## Gate on the format you can actually replay

Because nothing downstream will ever complain, the check has to be upfront &mdash; and at every stream start, since the variable is dynamic and can change between runs. sluice v0.99.292 reads @@GLOBAL.binlog_format at every binlog CDC chokepoint (stream start &mdash; covering the sync cold-start handoff, warm resume, and backup incremental &mdash; plus both snapshot openers, so a cold start refuses before the bulk copy) and refuses anything but ROW with the coded SLUICE-E-CDC-BINLOG-FORMAT-NOT-ROW, naming the value and the remedy. One resume caveat belongs in the refusal's fine print: flipping to ROW is dynamic but not retroactive &mdash; binlog segments already written under STATEMENT stay statement-logged, and the changes lost while the format was wrong were never recorded as row events at all, so the honest remedy is a fresh start plus re-verify, not a resume across the flip. Documented residual: a SUPER session-level binlog_format=STATEMENT override slips the global read.

## The transferable lesson

A CDC consumer must gate on the log format it can actually replay, at every stream start, because a wrong format produces no downstream signal: the events still flow, they're just the kind you ignore. &ldquo;Connected and consuming&rdquo; is not &ldquo;applying&rdquo; &mdash; if your pipeline's liveness signals measure the former, a format mismatch is green forever. The same family one knob over: binlog_row_image=MINIMAL eats every UPDATE &mdash; there the stream loses one verb's content; here it loses everything.

## Primary sources

- sluice v0.99.292: the binlog_format preflight and SLUICE-E-CDC-BINLOG-FORMAT-NOT-ROW (internal/engines/mysql/cdc_binlog_format_preflight.go), pinned by a real-server integration matrix &mdash; mysql STATEMENT, mysql MIXED, mariadb STATEMENT &mdash; each asserting the refusal fires with the target catalog untouched; the pre-gate live observation (frozen target, position anchor before == after, nil shutdown) is in the shipping commit's ground-truth record.

- MySQL / MariaDB documentation &mdash; binlog_format and statement-based logging; MIXED's deterministic-write rule; MariaDB's MIXED default.

- Related field notes &mdash; the platform default that eats every UPDATE (the row-image sibling: same source-knob-decides-what-the-stream-carries class) and two syncs, one publication (the Postgres cousin of a green stream delivering nothing).

---
Canonical page: https://sluicesync.com/field-notes/binlog-format-statement-green-stream/ · Full docs index: https://sluicesync.com/llms.txt
