# When the row's own identity gets rounded

> The VStream FLOAT repair re-reads the source exactly and matches rows by primary key. That works perfectly — until the FLOAT is part of the primary key. Then the target's copy of the key is itself rounded, the exact re-read never finds its row, the repair silently no-ops, and --strict-float exits 0 with a rounded archive.

Observed — PlanetScale / self-hosted Vitess source over VStream. A companion to Vitess's copy phase rounds your FLOATs: this is the corner where the repair that note describes cannot help.

## What happened

A VStream cold-start COPY display-rounds single-precision FLOAT to 6 significant digits, and sluice repairs that by re-reading the affected columns exactly and correcting the target. But a table declared PRIMARY KEY (id, f) with a non-PK FLOAT column g came out of the repair with g still rounded — and worse, backup full --strict-float, whose entire contract is &ldquo;exact, or fail; never rounded,&rdquo; exited 0 and wrote a rounded archive. The one flag built to make a rounded archive impossible produced one, silently.

## Why (the mechanism)

The repair keys row identity on the primary key. It re-reads each repairable table's FLOAT columns exactly from the source ((col * 1E0) forces full-precision rendering) and then, for sync, issues UPDATE t SET g = ? WHERE id = ? AND f = ? to patch the target row; for backup, it builds a PK→exact-floats map and patches each archived COPY row. Both paths assume the primary-key value is stable between the two sides being matched. When a FLOAT is in the primary key, that assumption breaks: the bulk COPY wrote the PK's f column display-rounded, while the exact re-read scans f at full precision. The two values differ, so the WHERE ... AND f = ? matches zero rows. Zero-rows-affected is, by design, a silent no-op — the table is counted as repaired, exit 0. The --strict-float refusal nets didn't cover this mixed shape (a FLOAT in the PK and another FLOAT outside it), so it fell between them.

The corollary is wider than the repair machinery: a float-in-PK table on a VStream source has its row identity rounded on the target, so subsequent CDC UPDATE/DELETE events — which carry the exact float32 PK — also miss those rows.

## The repro

A PlanetScale/Vitess source, a FLOAT in the primary key, and a value that needs more than 6 significant digits:

    CREATE TABLE t (
      id INT,
      f  FLOAT,   -- part of the PK, needs > 6 sig digits (e.g. 8388608)
      g  FLOAT,   -- a plain FLOAT column
      PRIMARY KEY (id, f)
    );

    -- Cold-start COPY writes the PK's f rounded (8388608 -> 8388610).
    -- The exact re-read scans f = 8388608 and tries:
    --   UPDATE t SET g = <exact> WHERE id = ? AND f = 8388608
    -- The target row's f is 8388610, so zero rows match: g stays rounded.
    -- backup full --strict-float: the PK->floats patch key never matches,
    --   rows archive rounded, and the mixed shape exits 0.

## What sluice does about it

A table whose primary key contains a single-precision FLOAT is now classified non-repairable through one shared predicate used by both the sync cold-start and backup paths — so the rule can't drift between them. That routes the table to the honest &ldquo;this table cannot be repaired&rdquo; warning and, under --strict-float, to an upfront refusal instead of a rounded archive at exit 0. Tables with no FLOAT in the primary key are unaffected and still repaired exactly, as before.

## The transferable lesson

Precision loss in a value is a bounded problem — you can re-read it, patch it, warn about it. Precision loss in an identity is a different animal: it silently breaks every operation that keys on that identity, all at once and with no error, because the lookups simply don't match anymore. Before you build a repair, a merge, or a change-apply that matches rows by key, check that the key itself survives every path it travels — a key that rounds is a key that can't be joined on.

## Primary sources

- MySQL Bug #43262 — the FLT_DIG display-rounding of single-precision FLOAT that starts this whole chain.

- MySQL 8.0 Reference Manual B.3.4.8 — &ldquo;Problems with Floating-Point Values.&rdquo;

- The value it can repair, and how — Vitess's copy phase rounds your FLOATs.

---
Canonical page: https://sluicesync.com/field-notes/float-in-primary-key/ · Full docs index: https://sluicesync.com/llms.txt
