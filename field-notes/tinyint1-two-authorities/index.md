# The same tool disagreed with itself about whether a TINYINT(1) is a boolean

> MySQL's BOOL alias does not extend to UNSIGNED or AUTO_INCREMENT tinyint(1) — those are integers. The schema translator knew that; the VStream replication decoder answered the same yes/no question from a different input, the wire's own column_type string, and answered it differently. An auto-increment tinyint(1) primary key silently collapsed every value ≥2 to 1 on the change stream — while the cold copy of the same table was correct.

Observed &mdash; sluice's Vitess/PlanetScale VStream decode path, found by a post-release audit of v0.130.0 and ground-truthed on real MySQL 8.0.46; fixed in v0.130.1. The blast radius is deliberately stated narrowly: it takes an AUTO_INCREMENT or UNSIGNED tinyint(1) actually holding values &ge;2 (an auto-increment PK is the realistic shape), and only the VStream replication lane &mdash; the cold copy, and non-Vitess binlog sources, typed the column from the schema and were correct. Ordinary signed 0/1 boolean columns were never affected.

## The boundary everyone forgets

MySQL's BOOL-is-TINYINT(1) convention has edges: an UNSIGNED or AUTO_INCREMENT tinyint(1) is an integer in every practical sense &mdash; a primary key can perfectly well be TINYINT(1) AUTO_INCREMENT, and it stores and serves the full range, not {0,1}. sluice's schema translator got this right. Its VStream replication decoder answered the same yes/no question &mdash; is this column a boolean? &mdash; from a different input: the wire's column_type DDL string, through a rule that accepted tinyint(1) unsigned as boolean and never consulted the wire's AUTO_INCREMENT flag at all. Two authorities, one question, and they agreed everywhere except the columns that matter.

## What the drift did

An auto-increment tinyint(1) PK keeps its tinyint(1) spelling on the wire, so the decoder called it boolean and collapsed every value &ge;2 to 1 &mdash; merging distinct primary keys into one row on a MySQL-family target &mdash; and it did this only on the change stream. The cold copy of the same table, typed from the schema, was correct: the table diverged from itself the moment CDC took over. Then the kicker: v0.130.0's brand-new TINYINT(1) out-of-range refusal fires on the decoded value &mdash; so sitting on the mis-decode, it false-refused those same legitimate integer columns, asserting a boolean mapping sluice doesn't actually make for them. A guard is only as correct as the decode beneath it; layer a validity check on the wrong authority and it inherits the error, loudly.

## One question, one function

The fix is structural, not another patch to the string rule: a single shared predicate &mdash; display width 1, signed, non-auto-increment &mdash; that both the schema translator and the VStream decoder consult, the decoder feeding it unsigned parsed from the wire's column_type and auto-increment from the wire's field flags. A matrix gate pins decode-verdict == schema-verdict over {signed/unsigned} &times; {auto-increment/not} &times; zerofill &times; width, and fails the build if the two authorities ever diverge again. The tell worth stealing from the diff: a unit test was already green on the buggy behavior &mdash; it pinned tinyint(1) unsigned → bool as the expected result. A stale test doesn't just miss a bug; it certifies it.

One premise deserved and got its own proof: the fix trusts the wire to say a column is auto-increment. A later end-to-end run against a real Vitess 24 cluster confirmed it measured, not inferred &mdash; the FIELD event for the auto-increment column carried the auto-increment flag bit set (Flags 49667, bit 512), the plain tinyint(1) carried it unset (32769) &mdash; so the wire genuinely distinguishes the two shapes.

## The transferable lesson

When a system answers the same type question in two places from two inputs &mdash; the declared schema here, the replication wire's DDL string and flags there &mdash; the answers will drift, and the drift lands exactly on the boundary cases the alias's fine print excludes. If a decision must be made twice, it must be made by one function, and a gate should hold the two call sites to it. The companion note is the same column type one layer up &mdash; whether TINYINT(1)-means-boolean is even true of your data; this one is whether your own tool holds a single opinion about it.

## Primary sources

- MySQL reference &mdash; numeric type syntax &mdash; the BOOL alias and its TINYINT(1) equivalence.

- Vitess reference &mdash; VStream &mdash; FIELD events carry column_type and MySQL column flags.

- sluice v0.130.1 changelog &mdash; the shared predicate, the false-refuse regression it also closes, and the divergence-pinning matrix gate.

- Related field notes: TINYINT(1) is a display width, not a value constraint &mdash; the companion note; The same unsigned primary key is int64 to one reader and uint64 to the other &mdash; two readers disagreeing about the same column at the Go-type layer.

---
Canonical page: https://sluicesync.com/field-notes/tinyint1-two-authorities/ · Full docs index: https://sluicesync.com/llms.txt
