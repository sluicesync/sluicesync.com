# parseTime governs the query protocol, not the binlog

> parseTime=true on the DSN makes the query driver return time.Time. But the replication stream is a different code path, and it hands temporal columns back as raw strings regardless. The first TIMESTAMP row killed the CDC pump — and the silent channel-close looked exactly like a network stall for two release cycles.

Observed — MySQL → target CDC on any table with a TIMESTAMP / DATETIME / DATE column. Internally Bug 12.

## What happened

A MySQL CDC stream against any table with a temporal column silently applied zero events — the channel just went quiet, exactly like a stalled network connection. The mis-diagnosis chased port-forwarding and connectivity for two release cycles before the real cause surfaced: the very first temporal row event was killing the pump.

## Why (the mechanism)

The DSN carried parseTime=true, which tells go-sql-driver/mysql to return time.Time for temporal columns — but that setting governs the query protocol (the result path of a normal SELECT). The binlog replication stream is a separate code path, and it hands temporal values back as their raw string form ("2026-05-05 20:38:23") no matter what the DSN says. The row decoder accepted only a time.Time, so the first temporal row event raised cannot decode string as time.Time (parseTime=true should be set). And the way that error surfaced is what turned a loud bug into a silent one: the pump reported it via a deferred setErr (visible only through a later Err() call, never logged at the point of failure), then closed the events channel. Downstream, the applier just saw the channel close with zero events — a fatal decode error wearing the costume of an idle stream.

## The repro

    -- source: any table with a temporal column, CDC tailing it
    CREATE TABLE t (id INT PRIMARY KEY, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO t (id) VALUES (1);
    -- pre-fix: the binlog row event carries ts as the string "2026-05-05 20:38:23";
    --   the decoder rejects it, the pump setErr()s and closes the channel,
    --   the applier sees 0 events. Looks identical to a dead connection.

## What sluice does about it

The binlog decoder now parses MySQL's canonical temporal string forms — second-precision, microsecond-precision, and date-only — plus their byte-slice equivalents and the 0000-00-00 zero-value sentinel, rather than assuming a pre-parsed time.Time. (Pinned end-to-end against a real mysql:8.0: pre-fix dropped 100% of CDC events on a temporal table, post-fix all flow.)

## The transferable lesson

A driver flag like parseTime tunes the query protocol, not the replication stream — they are different paths through the same driver, and the binlog hands you raw strings whatever the DSN claims. When a setting clearly "works" for your queries but CDC breaks on the exact type it should govern, suspect that the replication path never saw the flag. The companion lesson is about failure visibility: a fatal error routed only through a deferred Err() — not logged where it happens — is indistinguishable from a healthy-but-idle stream, and that ambiguity is what cost the two release cycles. Surface pump-fatal errors loudly, at the point of failure. (The binlog is not the query protocol in more ways than one — it also compresses whole transactions into a single event a query-path reader never sees.)

## Primary sources

- go-sql-driver parseTime (a connection/query-path option) — go-sql-driver/mysql parameters.

- MySQL binlog row images carry temporal values in their own encoding — Rows_event.

- How sluice reads MySQL CDC — How sluice copies your data.

---
Canonical page: https://sluicesync.com/field-notes/binlog-temporal-strings/ · Full docs index: https://sluicesync.com/llms.txt
