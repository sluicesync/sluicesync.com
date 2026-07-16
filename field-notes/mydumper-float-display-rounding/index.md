# Your dump already rounded your floats

> mydumper renders single-precision FLOAT through mysqld's ~6-significant-digit float-to-text formatter: 8388608 lands in the dump file as 8.38861e6, which parses back to a different float32 — while DOUBLE columns in the very same run dump at full round-trip precision. The loss is in the file, at dump time. Restore it, archive it, trust it: the low bits are already gone.

Observed — building sluice's mydumper flat-file source engine (ADR-0161, v0.99.247), caught by the real-dump oracle: comparing rows read from an actual mydumper v1.0.3 dump against the same table read live. Every value matched except single-precision FLOATs.

## What happened

We built a reader for mydumper-format dump directories, and its central test is an equivalence oracle: dump a corpus with real mydumper, read the dump with sluice, migrate the same source live with sluice's MySQL engine, and compare row by row. The oracle flagged FLOAT.

A FLOAT column holding 8388608 (223 — a value a float32 represents exactly) appears in the .sql chunk as 8.38861e6. Parse that back and you get 8388610, a different float32 — float32 spacing at 223 is 1.0, so the six-digit rendering steps to a neighboring representable value. Meanwhile, in the same run, the same dump, DOUBLE columns holding 3.141592653589793, 0.1, and 1.7976931348623157e308 all dump at full shortest-round-trip precision. That FLOAT/DOUBLE split was proven, not assumed — the corpus carries beyond-6-digit DOUBLE values precisely so a regression in the sibling family would be caught.

The split is the trap. The natural spot-check for &ldquo;does my dump preserve float precision?&rdquo; is to eyeball a DOUBLE column — doubles are where people expect precision to live — and the DOUBLE evidence says full precision. The FLOAT columns, silently, are already rounded in the bytes on disk, with no warning anywhere in the toolchain: not from mydumper, not from myloader on the way back in, not from the server.

## Why (the mechanism)

mydumper reads with a bare SELECT, which means values arrive as text formatted by mysqld's float-to-text path — and MySQL's display conversion for single-precision FLOAT renders roughly six significant digits (a very old server-side behavior; MySQL Bug #43262 is the long-lived upstream thread), while DOUBLE gets a full-precision rendering. So the divergence isn't in mydumper's own code; it inherits the server's formatter, and the dump faithfully records the formatter's output rather than the column's value.

We've written about this exact formatter class before, live: Vitess's VStream COPY phase delivers FLOATs through the same server-side text conversion, rounded, while its binlog phase delivers exact bits — same value, two precisions, depending on the phase. This note is the same class at rest: one of the most widely used MySQL logical-dump tools, writing the rounded rendering into the archive itself. As of this writing we have not filed it upstream with mydumper; the mechanism sits in the server's formatter, and the sibling Vitess report is pending the same filing decision.

## Reproducing it

Any MySQL plus the mydumper container (v1.0.3 is what we ground-truthed):

    mysql> CREATE TABLE f (v FLOAT, d DOUBLE);
    mysql> INSERT INTO f VALUES (8388608, 3.141592653589793);

    $ docker run --rm -v $PWD/dump:/dump mydumper/mydumper \
        mydumper -h <host> -u <user> -p <pass> -B testdb -o /dump

    $ grep -o '([^)]*)' dump/testdb.f.00000.sql
    (8.38861e6,3.141592653589793)
    --  ^ FLOAT: six significant digits — parses back to 8388610, a
    --    different float32          ^ DOUBLE: full precision, same run

The side-by-side is the point: check only the DOUBLE column and the dump looks lossless. 8388608 is 223, chosen because float32 spacing there is exactly 1.0 — the re-parsed 8388610 is provably a different value, not a rendering nicety.

## What sluice does about it

A reader cannot re-read precision the file never contained, so sluice does the only honest thing: on a mydumper-format source, it WARNs once per table naming the FLOAT columns and pointing at the remedy — migrate that table from the live server (where sluice's reader fetches exact bits) rather than from the dump. DOUBLEs are read from the dump at full fidelity. The WARN is pinned in tests so it can't silently vanish.

## The transferable lesson

A logical backup is only as faithful as the value-to-text formatter that produced it, and FLOAT is the family that formatter rounds on MySQL. If your archival or migration path runs through a SQL-text dump, audit the single-precision columns specifically — checking DOUBLE tells you nothing about FLOAT, because the two families take different formatting paths in the same run. And if you build tooling on dumps: when the file provably can't carry the fidelity you promise, warn on the family and name the columns; silence here is a rounded archive that someone will trust years from now.

## Primary sources

- MySQL Bug #43262 — FLOAT displayed at reduced precision through the server's float-to-text conversion (the upstream root of the class).

- mydumper — reads via SELECT, so dumped values are the server formatter's text output (v1.0.3 ground-truthed).

- Companion field note — Vitess copy phase rounds your FLOATs: the same formatter class, streaming instead of at rest.

- sluice ADR-0161 §4 — the named FLOAT display-rounding wart, the per-table WARN, and the DOUBLE-proven-unaffected oracle.

---
Canonical page: https://sluicesync.com/field-notes/mydumper-float-display-rounding/ · Full docs index: https://sluicesync.com/llms.txt
