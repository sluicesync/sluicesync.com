# proto_version lets you parse streaming; only streaming='on' emits it

> Two pgoutput knobs are easy to conflate. The receiver flag equips you to parse streamed transactions; a separate publisher flag makes the server actually send them. The gap between them hides a silent-loss shape: a dropped StreamAbort leaves already-committed chunks on the target.

Observed — Postgres logical replication via pgoutput, a defensive audit of the streaming-protocol dispatch. Internally ADR-0055 (finding F1 of a Postgres-internals audit).

## What happened

A protocol audit found a default: branch in the WAL dispatcher that silently skipped StreamAbortMessageV2. Harmless in the tool's current configuration — but one config change away from durable, undetectable divergence. The interesting part is why it was latent, which is a pair of pgoutput knobs that look like one.

## Why (the mechanism)

pgoutput negotiates streaming through two independent capabilities on START_REPLICATION:

- proto_version &ge; 2 equips the receiver to parse the streaming frames — StreamStart / StreamStop / StreamCommit / StreamAbortV2 — for transactions that exceed logical_decoding_work_mem (default 64 MB) at the source.

- streaming = 'on' (PG 14+) or 'parallel' (PG 16+) makes the publisher actually emit those frames. Pass proto_version = 2 without it and an oversized transaction is buffered and spilled to disk server-side, then delivered as one ordinary begin / rows / commit unit after it fully decodes.

Parsing capability and emission are separate switches. Now the trap: suppose streaming is enabled (a config drift, a future change) and a consumer maps each streamed chunk to its own target transaction — a reasonable "one boundary → one commit" design. Chunk 1 commits durably on the target. Chunk 2 commits. Chunk N commits. Then the source rolls the transaction back and emits StreamAbortMessageV2. Drop that message and the N chunks stay committed on the target while the source has no record of them. The target now carries rows the source rolled back.

What makes it nasty is the shape of the loss. It is not a missing-rows gap that a row-count or checksum diff would catch — it is extra rows relative to the post-abort source, and nothing upstream is signalling their existence.

## The repro (the two knobs)

    -- receiver equipped to PARSE streaming, but publisher not asked to EMIT it:
    START_REPLICATION SLOT s LOGICAL 0/0 (proto_version '2', publication_names 'p');
    --   a 200 MB transaction spills to pg_replslot/<slot>/ and arrives as ONE
    --   begin/rows/commit unit. No StreamStart ever appears.

    -- ask the publisher to emit it too:
    START_REPLICATION SLOT s LOGICAL 0/0
      (proto_version '2', streaming 'on', publication_names 'p');
    --   now the same txn arrives as StreamStart / rows / StreamStop chunks,
    --   and a source ROLLBACK arrives as StreamAbortV2 — which a consumer
    --   MUST act on, not skip.

## What sluice does about it

sluice runs proto_version = 2 deliberately without streaming, so one source transaction maps to one target transaction (the alignment its batched apply depends on) and oversized transactions are the source's memory problem, not a target-consistency problem. The audit fix replaces the silent default: skip with an explicit StreamAbortMessageV2 arm that refuses loudly if a streamed abort is ever seen — so a future flip of the publisher flag can't quietly resurrect the extra-rows class. (The spill it trades for is now observable too: PG 14+ exposes spill_txns / spill_bytes in pg_stat_replication_slots.)

## The transferable lesson

When a protocol negotiates a capability from both ends, "I can parse it" and "you will send it" are different switches, and the interesting failures live in the gap. Enumerate the messages a capability could deliver even if your current config never triggers them, and make the ones you don't handle refuse loudly rather than fall through a silent default: — because the config that starts triggering them is one flag away, and a protocol message you drop is a decision you made without knowing it. Watch especially for loss that shows up as extra committed state rather than a gap: checksums and row counts are built to find gaps.

## Primary sources

- pgoutput protocol & the streaming option — logical streaming replication protocol and streaming subscription option.

- Streaming-of-in-progress-transactions & the spill counters — pg_stat_replication_slots.

- How sluice maps source transactions to target transactions — How sluice copies your data.

---
Canonical page: https://sluicesync.com/field-notes/pgoutput-streaming-abort/ · Full docs index: https://sluicesync.com/llms.txt
