# One INSERT is three binlog events (or four)

> The binlog is a log of events, not row changes. A single-row INSERT lands as three (BEGIN / WRITE_ROWS / XID), plus a spurious empty BEGIN/COMMIT per new connection — so if you size a rollover bound by INSERT count, budget 4×. Postgres counts differently again.

Observed — sizing sluice backup stream's --rollover-max-changes against expected INSERT counts on a MySQL source. See How sluice copies your data.

## What happened

An operator set an incremental-backup rollover bound against the number of INSERTs they expected to drive, and the windows closed 3&ndash;4&times; earlier than that — rows they thought would land in the current incremental spilled into the next one. The count the tool bounds on and the count in the operator's head were measuring different things.

## Why (the mechanism)

The MySQL binlog records events, not user-visible row changes, and a change is wrapped in transaction framing. A single autocommit one-row INSERT is three events:

    1. BEGIN            (QueryEvent)
    2. WRITE_ROWS_EVENTv2   (the actual row)
    3. XID              (commit)

A multi-row INSERT ... VALUES (r1),(r2),...,(rN) collapses the row events into one each, so it's 2 + N (BEGIN + N row events + XID) — a 1,000-row multi-row insert is ~1,002 events, not 3,000. On top of the per-transaction framing there's a per-connection tax: many client sessions emit an empty BEGIN/COMMIT pair before their first DML, because the driver issues a session-setup statement (SET autocommit, SET time_zone, …) inside an implicit transaction that gets logged but carries no rows. So naive INSERT-counting under-counts binlog events by 3&ndash;4&times;. Postgres is different again: pgoutput delivers one countable change per row and surfaces transaction boundaries as separate Begin/Commit messages the consumer doesn't count as changes — so a PG operator can size by INSERT count directly, no multiplier.

## What sluice does about it

The rule of thumb, documented for the flag: on a MySQL source, budget at least 4&times; your expected INSERT count for --rollover-max-changes (the 3-event per-row shape plus headroom for the empty pair and other bookkeeping — heartbeats, rotate, format-description). Predictable bulk multi-row shapes can go tighter (the 2 + N collapse). On Postgres, no multiplier.

## The transferable lesson

"Number of changes" is an engine-specific unit. MySQL's binlog is a log of events — row images plus the BEGIN/XID framing around every transaction, plus a per-connection empty pair — so it runs 3&ndash;4&times; ahead of the row count you're thinking of; Postgres's logical stream is closer to one-per-row. When you bound anything against a replication log (a rollover, a batch, an alert threshold), bound it against the log's own unit, and remember the same "count the changes" knob does not mean the same thing across engines.

## Primary sources

- MySQL binlog event types — the replication event stream (QUERY_EVENT, WRITE_ROWS_EVENT, XID_EVENT).

- Postgres pgoutput per-row messages — logical replication message formats.

---
Canonical page: https://sluicesync.com/field-notes/binlog-event-volume/ · Full docs index: https://sluicesync.com/llms.txt
