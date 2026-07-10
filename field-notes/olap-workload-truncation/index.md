# Setting workload=olap silently truncated our chunked reads

> A one-line change set vtgate's workload=olap session-wide to lift a 100k-row cap on no-PK scans. The parallel chunked reader inherited the setting, each concurrent chunk streamed only a prefix, and a 1.5M-row migrate copied 7,536 rows — exit 0, migration complete.

Observed + bisected — a PlanetScale / Vitess source (reproduced on vttestserver). The version bisection is clean; the exact behavior inside vtgate that truncates a bounded chunk read under session-wide OLAP was observed but not root-caused down into the gateway (see below).

## What happened

A migrate from a Vitess/PlanetScale source, of a table large enough to be split into parallel copy chunks, at the default parallelism, silently copied a tiny fraction of the rows and reported success. The measured shape was stark: 1,500,000 source rows, 7,536 copied, exit 0 with migration complete tables=1. Dropping to --bulk-parallelism=1 (a single stream) copied all 1,500,000. Vanilla (non-Vitess) MySQL sources were never affected, and neither were tables below the chunking threshold — which is exactly why the existing test suite, built on small tables, never saw it.

## Why (as far as we bisected it)

vtgate's default OLTP workload caps a single result set at roughly 100,000 rows. A no-PK full-table scan is one big streaming SELECT that can't be primary-key-chunked, so it hit that cap and truncated. The fix for that was to set workload=olap (which streams, lifting the cap) on the source reader — but it was set session-wide. That session setting also covered the LIMIT-paged, bounded WHERE pk BETWEEN lo AND hi reads that the parallel chunked bulk-copy uses for large PK tables. Under OLAP streaming mode, each concurrently-read chunk's page came back truncated to a small prefix, and sluice treated end-of-(truncated)-stream as &ldquo;chunk complete&rdquo; — so the un-read tail of every chunk was silently dropped.

Stated honestly: the diagnosis rests on a clean deterministic version bisection (the release before the workload=olap change copied every row; that change is the only relevant difference) plus per-chunk row-count logs that summed to the truncated total. The precise mechanism by which session-wide OLAP truncates a bounded, paged read inside vtgate was not chased into the gateway's source, and whether it reproduces on real PlanetScale at scale versus being a vttestserver/vtcombo streaming interaction was left an open question. The fix removes session-wide OLAP from the paged reads entirely, so it closes the gap regardless of which it was.

## The repro

Deterministic on vttestserver:mysql80 with a 1.5M-row bigint-PK table; only the version and parallelism differ:

    sluice version   --bulk-parallelism   rows copied (of 1,500,000)   exit
    --------------   ------------------   -------------------------   ----
    pre-olap         default (8)          1,500,000  ✓                 0
    olap session-wide default (8)         7,536      ✗                 0
    olap session-wide 1 (single stream)   1,500,000  ✓                 0

A 1,000-row table copies fully even on the affected version — the loss only appears above the chunk threshold, which is precisely the region the sub-threshold test corpus never exercised.

## What sluice does about it

workload=olap is now scoped to just the unbounded no-PK full scan — the one read that actually needs the cap lifted — and applied on a dedicated connection, never session-wide. The LIMIT-paged batch reader the chunked copy uses is OLAP-free again, exactly as it was before the regression, so the parallel copy reads every row while the no-PK cap lift it was added for is preserved. An operator-supplied workload in the DSN still wins. It's pinned by a regression test that migrates an above-threshold PK table at parallelism > 1 and asserts exact row-count parity — the chunk-threshold dimension the prior pins missed.

## The transferable lesson

A session variable is a blunt instrument: it changes the behavior of every statement on that connection, including ones you weren't thinking about when you set it. Here a knob added to make one read return more rows made a different, unrelated read return fewer — and because the loss was scale-dependent and silent, it sailed past a test suite that only ever ran small tables. Scope a session setting to exactly the code path that needs it (a dedicated, short-lived connection), and when a change alters how much data a query returns, add a test at the scale where the two behaviors actually diverge.

## Primary sources

- Vitess documentation and the OLAP vs OLTP workload modes vtgate exposes (OLAP streams results and lifts the OLTP result-set cap; it also forbids transactions).

- sluice's parallel bulk-copy and chunking model — How sluice copies your data.

---
Canonical page: https://sluicesync.com/field-notes/olap-workload-truncation/ · Full docs index: https://sluicesync.com/llms.txt
