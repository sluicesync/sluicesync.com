# mydumper chunk numbers are PK ranges, not a sequence

> Every consumer's instinct says numbered chunk files — table.00000.sql, 00001, … — form a sequence, so a missing file is detectable as a gap. Ground truth from real mydumper: the numbers are derived from primary-key ranges. Healthy dumps have gaps, -r dumps start at 00001, and a deleted trailing chunk leaves no gap at all — so contiguity is neither necessary nor sufficient. Meanwhile a deleted middle chunk streams silently short at exit 0, and the loss detector the format actually ships is the metadata everyone skips as informational.

Observed — the 2026-07-15 repo audit (MED-D0-2: a dump with chunks 00000+00002 streamed 2 of 3 rows at exit 0, zero WARNs, and verify re-counted the same directory) plus a ground-truth probe against real mydumper v1.0.3 in Docker during the fix work. The silent short-stream was sluice's own gap — the reader explicitly dropped the dump's -metadata/-checksum companions as &ldquo;informational only.&rdquo; Two detection nets shipped in v0.99.258 and were proven both-sides by the regression cycle (numbers below). mydumper's numbering itself is by design; nothing to file upstream.

## What happened

Delete one data chunk from the middle of a mydumper dump and restore it. What should happen: an error, or at least a warning. What did happen through sluice v0.99.257: the remaining chunks stream, every row in them lands, exit 0, no signal anywhere. The regression cycle's fixture — three chunks, 15 rows total, rm the middle one — landed 10 rows with zero WARNs. A verifier re-scanning the same directory confirms the short count. Chunk-file-level loss is maximally quiet because each chunk is a complete, well-formed SQL file; nothing about the survivors reveals the absence.

The obvious net is a contiguity check on the chunk numbers. That's where the ground-truth probe earned its keep, because the obvious net is wrong:

- Chunk numbers are derived from PK ranges, not a counter. A table with sparse primary keys legitimately dumped as 00001&ndash;00003 plus 450001&ndash;450003 on real v1.0.3 — observed once, on one probe, but it only takes one healthy dump with gaps to make a contiguity refusal reject good data.

- Dumps taken with -r (rows-per-chunk) start at 00001, not 00000.

- A deleted trailing chunk leaves no gap at all — the numbering just ends earlier.

So contiguity is neither necessary (healthy dumps have gaps) nor sufficient (trailing loss shows no gap). An alarm built on the assumed semantics would have both false-alarmed and under-detected.

## The net was inside the dump the whole time

mydumper records per-table row counts in its own metadata — rows = N entries in the modern dump-wide ini form, bare-integer -metadata companion files on older versions. The probe found the modern counts exact on v1.0.3. That's the free cross-check that catches chunk-level loss regardless of numbering: count what you streamed, compare with what the producer said it wrote. sluice's reader had been explicitly discarding those companions as &ldquo;informational only&rdquo; — forfeiting the only loss detector the format ships.

v0.99.258 added both nets, deliberately as WARNs rather than refusals (cross-producer metadata fidelity is unverified, and gaps can be legitimate): a non-contiguous chunk-number WARN at open naming the gap, and the decisive post-stream row-count tripwire on both the bulk-copy and verify-count doors. The regression cycle's differential, same deleted-middle-chunk fixture:

    binary       outcome
    ---------    ----------------------------------------------------------
    v0.99.257    rc=0, 10 of 15 rows, ZERO warns — the silent short-stream
    v0.99.258    rc=0, same 10 rows, BOTH nets fire: the contiguity WARN
                 (gap_after_chunk=0 next_chunk=2) and the count WARN
                 naming metadata_rows=15 chunk_rows=10

One honest residual, stated because it's exactly the class this note is about: pscale-dump (the PlanetScale producer of the same format family) writes empty metadata companions, which sluice ignores leniently — so on that producer, a deleted trailing chunk leaves neither a gap nor a count mismatch. The net is only as good as the producer's metadata, per producer.

## Reproducing it

Real mydumper via Docker, any MySQL:

    docker run --rm --network host mydumper/mydumper:v1.0.3-1 \
      mydumper -h 127.0.0.1 -u root -p secret -B mydb -o /dump -r 5   # small -r forces multiple chunks

    ls dump/mydb.t.*.sql          # note: -r dumps start at 00001; sparse-PK tables can jump
    grep -A2 '\[`mydb`.`t`\]' dump/metadata   # the dump's own per-table "rows = N"

    rm dump/mydb.t.00002.sql      # delete a middle chunk

    sluice migrate --source-driver=mydumper --source ./dump --target-driver=mysql --target '<dsn>'
    # <= v0.99.257: rc=0, silently short, no signal
    # >= v0.99.258: rc=0 + the gap WARN + "metadata records a different row count" naming both numbers

To see the numbering semantics directly: dump a table whose PKs live in two distant bands (say 1&ndash;1000 and 450000&ndash;451000) and observe the chunk numbers jump with the keyspace.

## The transferable lesson

Two lessons stacked. First: an identifier derived from data is not a sequence — before you alarm on a producer's numbering, verify what the numbers mean, on the real producer, or your check will reject healthy inputs and miss unhealthy ones. (The verification cost here was one Docker probe; the alternative was a contiguity refusal that false-alarms on every sparse-PK dump.) Second, the sharper one: the metadata your reader skips as &ldquo;informational&rdquo; may be the only loss detector the format ships. A dump format's row counts, checksums, and manifests exist because the producer knew exactly what it wrote — a consumer that discards them is choosing to verify nothing against the one party with ground truth.

## Primary sources

- mydumper documentation and observed v1.0.3 behavior — chunk numbering (PK-range-derived; -r starts at 00001; sparse keyspaces produce non-contiguous numbers, observed once on the fix's Docker probe) and the metadata rows = entries (exact on v1.0.3).

- sluice v0.99.258 changelog — the gap WARN + row-count tripwire, including the ground-truth note (&ldquo;chunk numbers are PK-range-derived, so gaps can be legitimate — the row-count tripwire is the real net&rdquo;); the 2026-07-15 audit finding MED-D0-2.

- sluice-testing session report v0.99.258 (F3) — the deleted-middle-chunk differential live on both binaries.

- Companion field notes — mydumper-format-family (producer forks in the same format, including pscale-dump's empty metadata) and verifier-rode-the-same-reader (statement-level skips through the same reader).

---
Canonical page: https://sluicesync.com/field-notes/mydumper-chunk-numbers-pk-ranges/ · Full docs index: https://sluicesync.com/llms.txt
