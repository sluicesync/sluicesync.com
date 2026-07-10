# A whole transaction in one zstd binlog event

> MySQL 8.0.20+ can pack an entire transaction into a single compressed TRANSACTION_PAYLOAD_EVENT. A binlog reader without a handler for it applies nothing and freezes its position with no error — and the server zeroes the inner events' end_log_pos, so a naive resume restarts mid-payload and dies.

Observed — MySQL → target CDC from a source with binlog_transaction_compression = ON. Internally the TRANSACTION_PAYLOAD_EVENT decode + resume-alignment fix.

## What happened

CDC from a MySQL 8.0.20+ source that had binlog_transaction_compression enabled (common for WAN replication and disk savings) silently applied nothing for compressed transactions: rows never landed, the stream position froze, and there was no error. Turning the setting off "fixed" it — which is the tell that the reader was missing an event type, not hitting a bug.

## Why (the mechanism)

With binlog_transaction_compression = ON, the server packs a whole transaction — its TABLE_MAP, its ROWS events, its XID — into a single zstd-compressed TRANSACTION_PAYLOAD_EVENT. A binlog consumer that doesn't recognize that event type simply skips it: zero rows applied, position advanced past it, no error raised. Everything the transaction did is inside a payload the reader walked past.

There is a second, sharper trap in the resume path. Inside the payload, the server zeroes the end_log_pos of the inner events (they no longer have a meaningful standalone file offset — they live inside the outer event). A resumer that stamps its checkpoint from an inner event's header therefore records position 0, and on warm-resume restarts inside the payload — where it finds row events with no preceding table map and dies with "no corresponding table map event." The correct checkpoint is the outer TRANSACTION_PAYLOAD_EVENT's LogPos (the transaction boundary). GTID-mode streams dodge this half, because the GTIDEvent precedes the payload and carries the resumable coordinate.

## The repro

    -- source (MySQL 8.0.20+):
    SET GLOBAL binlog_transaction_compression = ON;
    INSERT INTO t VALUES (1), (2), (3);   -- one compressed txn

    -- in the binlog, instead of TABLE_MAP + WRITE_ROWS + XID you now see:
    --   Transaction_payload   (compression: ZSTD)
    --     └─ TABLE_MAP / WRITE_ROWS / XID  (inner; end_log_pos = 0)
    -- a reader with no Transaction_payload handler applies 0 of the 3 rows,
    -- reports no error, and advances past it.

## What sluice does about it

sluice decompresses the TRANSACTION_PAYLOAD_EVENT and dispatches its inner events as if they had arrived uncompressed, so a compressed source is transparent. For the resume half, it stamps its checkpoint from the outer payload event's LogPos (the transaction boundary), never an inner event's zeroed end_log_pos — so a warm-resume lands on a transaction boundary and never mid-payload. Both halves are pinned by regression tests, because the failure only appears with the setting on and a resume across a compressed transaction.

## The transferable lesson

A binlog reader's completeness is defined by the source settings it has never seen, not the ones it was tested against. binlog_transaction_compression is off by default, so a reader can pass every local test and silently drop every transaction the moment a DBA turns it on for bandwidth. Two lessons ride together: handle (or loudly refuse) every binlog event type the source can emit, not just the common ones; and when a container event rewrites its children's coordinates — here, zeroing inner end_log_pos — make sure your resume checkpoint comes from the coordinate that's still valid (the outer boundary), or your recovery path breaks exactly when you need it.

## Primary sources

- MySQL binlog transaction compression — binary log transaction compression and the Transaction_payload_event.

- sluice's MySQL CDC and resume model — How sluice copies your data.

---
Canonical page: https://sluicesync.com/field-notes/binlog-transaction-compression/ · Full docs index: https://sluicesync.com/llms.txt
