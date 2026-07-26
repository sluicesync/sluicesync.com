# Your own next statement erases the warning

> Under a relaxed sql_mode MySQL coerces 300 into a TINYINT as 127 and tells you exactly once — on the session diagnostics area, which the next statement clears. For a CDC applier whose position write shares the batch transaction, the statement that makes the batch durable is the statement that destroys the evidence.

Observed &mdash; MySQL-family target under an explicit relaxed-sql_mode opt-in. A CDC-apply-path probe shipped in sluice v0.100.0. Strict mode &mdash; the default &mdash; still refuses the value loudly at the statement; this path is reachable only when an operator asks for it.

## What happened

Relaxing sql_mode is the standard move for getting a stubborn legacy import to finish. What it actually does is convert a class of loud refusals into silent coercions. 300 into a TINYINT becomes 127. An over-long string becomes a truncated one. The statement succeeds, the row count is right, and the value is wrong.

MySQL does tell you. It raises a warning &mdash; once &mdash; into the session's diagnostics area, readable with SHOW WARNINGS. And the diagnostics area is per-statement: the very next statement on that connection clears it.

## Why that is a design constraint, not a detail

For a CDC applier this is sharper than it first looks, because of where the applier's own bookkeeping lives. sluice persists its apply position in a control table on the target, and that position write rides the same transaction as the batch it describes &mdash; that co-location is what makes the apply exactly-once (see the position-store note for the same design biting differently).

So the sequence inside one transaction is: write the rows, write the position, commit. Which means the statement that makes the batch durable is the statement that erases the proof the batch was coerced. By the time anything downstream could ask &ldquo;did that apply cleanly?&rdquo;, the answer has already been overwritten by the applier's own housekeeping.

There is no after-the-fact recovery. You cannot ask the server later, and you cannot reconstruct it from the row, because a coerced 127 is indistinguishable from a value that was always 127. The probe has to sit at the write call sites, on the same connection and the same transaction, immediately after each value-writing statement &mdash; or the evidence is already gone.

    -- relaxed session
    SET sql_mode = '';
    INSERT INTO t (small) VALUES (300);       -- succeeds; stores 127
    SHOW WARNINGS;                            -- 1 row: "Out of range value ..."

    -- but insert ANY statement between the two and the evidence is gone:
    INSERT INTO t (small) VALUES (300);
    UPDATE sluice_cdc_state SET pos = '...';  -- the applier's own position write
    SHOW WARNINGS;                            -- Empty set. The clamp is unrecoverable.

## What sluice does about it

The apply path now probes for clamp warnings on the same transaction, immediately after each value-writing statement &mdash; the serial single-row write and the coalesced multi-row upsert both &mdash; and WARNs naming the table and column. The cost shape falls out of the same per-statement fact: a strict session short-circuits before any round trip, so the default path pays exactly zero added latency, and a table that has already warned never probes again. DELETE and TRUNCATE write no operator values and are not probed.

## The transferable lesson

A diagnostic scoped to &ldquo;the last statement&rdquo; can only be collected synchronously, at the seam that produced it. That sounds obvious stated plainly, and it is routinely violated by accident, because the layers that insert a statement between your write and your read are exactly the ones you stop thinking about: a position or checkpoint write, a savepoint, a metrics or heartbeat query, a connection-pool reset probe, an ORM's post-write refetch. Any of them is a silent evidence destroyer. If your system relies on a per-statement diagnostic, audit what runs between the write and the read &mdash; and be most suspicious of your own bookkeeping, which is the one thing guaranteed to run on that connection.

## Primary sources

- MySQL SHOW WARNINGS &mdash; the diagnostics area and its per-statement lifetime.

- MySQL Server SQL Modes &mdash; what strict mode refuses and what a relaxed mode coerces instead.

- Related field note &mdash; one redaction flag, two engines, two behaviors, where the same MySQL clamp turned an anonymization rule into a constant.

---
Canonical page: https://sluicesync.com/field-notes/warning-erased-by-next-statement/ · Full docs index: https://sluicesync.com/llms.txt
