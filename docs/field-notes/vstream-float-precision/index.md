# Vitess's copy phase rounds your FLOATs; its binlog phase doesn't

> MySQL renders FLOAT to 6 significant digits over the text protocol, so a stored, exact 8388608 comes back as 8388610. Vitess's VStream copy phase inherits it; its binlog phase doesn't — the same column, same row, arrives exact or rounded depending on which phase delivered it.

Observed — MySQL 8.0.46 (also via vttestserver mysql80), Vitess/VStream copy phase. The root cause is MySQL Bug #43262, open since 2009.

## What happened

Reading a Vitess/PlanetScale source over VStream, a single-precision FLOAT column that stored an exact value came back rounded — 8388608 arrived as 8388610, 123456.789 as 123457 — but only for rows delivered by the copy phase. The very same column, for a row modified after copy and delivered by the binlog phase, was exact. A row that exists at copy time and is never touched again keeps the rounded value forever. Resharding or moving a table can therefore permanently alter its FLOAT data in the 7th significant digit.

## Why (the mechanism)

MySQL formats FLOAT over the text protocol at FLT_DIG = 6 significant digits — the number MySQL guarantees round-trips for any input. But a binary32 carries about 7.2 decimal digits, and round-tripping an arbitrary one needs up to FLT_DECIMAL_DIG = 9. Six digits is lossy whenever the 7th significant digit is meaningful. This is MySQL Bug #43262, documented in the manual under B.3.4.8, &ldquo;Problems with Floating-Point Values.&rdquo;

Vitess inherits it in the one place it hurts most. The rowstreamer copy phase reads rows with a text-protocol SELECT <columns> ... ORDER BY <pk>, so a FLOAT column arrives already rounded to the 6-digit text form — the exact bits are gone before Vitess's Go layer ever sees them. The binlog phase, by contrast, re-encodes the raw binary32 bits with Go's shortest-round-trip formatter (strconv.AppendFloat(float64(f32), 'E', -1, 32), in go/mysql/binlog/rbr.go) and is exact. So Vitess produces the exact form on one of its two paths and the rounded form on the other, for the same value. DOUBLE is unaffected (MySQL renders it at full dtoa precision); this is single-precision FLOAT/REAL only.

## The repro

Server-level and tool-independent — no Vitess required to see the rounding, since it's MySQL's text rendering:

    CREATE TABLE f (id INT PRIMARY KEY, v FLOAT, d DOUBLE);
    INSERT INTO f VALUES (1, 8388608, 8388608),
                         (3, 123456.789, 123456.789),
                         (4, 16777217, 16777217);

    -- Text protocol (what the copy-phase SELECT returns):
    SELECT id, v AS float_text, d AS double_text FROM f;
    --  1   8388610    8388608       <- FLOAT rounded, DOUBLE exact
    --  3   123457     123456.789
    --  4   16777200   16777217

    -- The stored FLOAT is exact; only the text rendering is lossy:
    SELECT v = CAST(8388608 AS FLOAT) AS stored_is_exact FROM f WHERE id = 1;  -- 1 (true)

    -- And the rounding isn't idempotent — restoring the rounded text
    -- yields a DIFFERENT binary32:
    SELECT CAST(8388610 AS FLOAT) = CAST(8388608 AS FLOAT) AS same;            -- 0 (false)

The stored value is a perfect binary32; the copy-phase text rendering is what loses it, and the loss can't be undone by re-parsing — the rounded decimal maps to a different binary32.

## What sluice does about it

A VStream consumer can't fix this client-side: the copy SELECT is built inside vttablet's rowstreamer and doesn't honor a client-supplied projection expression — analyzeExpr in go/vt/vttablet/tabletserver/vstreamer/planbuilder.go rejects arithmetic like col * 1E0 in a stream filter. So sluice works around it with a post-copy exact re-read: after the copy phase, it re-reads FLOAT columns with an out-of-band SELECT (col * 1E0) ... through vtgate, which forces MySQL to render at full precision, and patches the rounded copy values. That's only possible for a consumer that also has a direct SQL path to the source and can absorb a second read — which is exactly why the right home for the fix is upstream in rowstreamer.

We've written up an upstream issue for vitessio/vitess describing the copy-vs-replication inconsistency and proposing two server-side fixes — widen the copy SELECT to project the column as a double (CAST(col AS DOUBLE), so MySQL renders round-trippable precision and the target narrows back to the exact binary32), or read the copy via the binary protocol and reuse the same shortest-round-trip formatter the binlog path already uses in rbr.go. The argument is deliberately narrow: FLOAT is an approximate type, granted, but a row's value shouldn't depend on which Vitess phase delivered it, and Vitess already produces the exact form on one of its two paths. (The write-up references MySQL Bug #43262, the manual's B.3.4.8, and the public Vitess source paths above; it is drafted, not yet filed.)

## The transferable lesson

When a system has two independent paths to deliver the same data — a bulk copy and a change stream, a dump and a replica — check that they agree on precision, not just on content. A 17-year-old upstream display-rounding bug is harmless in a mysqldump you reload once, but it becomes a silent, permanent data alteration when it rides one of two phases in a resharding pipeline and the other phase is exact. The corruption hides in static rows precisely because the rows that are modified later get corrected by the exact path.

## Primary sources

- MySQL Bug #43262 — the canonical FLT_DIG display-rounding bug (open since 2009).

- MySQL 8.0 Reference Manual B.3.4.8 — &ldquo;Problems with Floating-Point Values.&rdquo;

- Vitess VReplication &mdash; &ldquo;Life of a Stream&rdquo; — documents the copy-phase SELECT ... ORDER BY <pk>.

- Vitess's exact binlog formatter: go/mysql/binlog/rbr.go; the projection-expression restriction: go/vt/vttablet/tabletserver/vstreamer/planbuilder.go (github.com/vitessio/vitess).

---
Canonical page: https://sluicesync.com/docs/field-notes/vstream-float-precision/ · Full docs index: https://sluicesync.com/llms.txt
