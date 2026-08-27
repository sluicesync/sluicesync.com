# TINYINT(1) is a display width, not a value constraint

> MySQL's BOOL and BOOLEAN are aliases for TINYINT(1), so every migration tool reads TINYINT(1) as a boolean — and the (1) is a formatting hint, not a range. The column stores the full signed 8-bit range, so a legacy column holding 0–6 collapsed to true under the boolean mapping, at exit 0. sluice WARNed — and carried the collapsed value anyway. And on the VStream wire, --type-override structurally cannot fix it.

Observed &mdash; a real user's field report: a migrate of two TINYINT(1) columns holding values 0&ndash;6 exited 0 with every value rewritten to 1. Hardened in sluice v0.130.0. A TINYINT(1) that genuinely holds only 0/1 never triggered this and is unaffected &mdash; and the rows the old behavior had already copied held genuine 0/1 and were correct; the loss was confined to columns actually holding out-of-range values.

## The display-width trap

MySQL has no distinct boolean type: BOOL and BOOLEAN are aliases for TINYINT(1), so reading TINYINT(1) as a boolean is what the type means 99% of the time, and every MySQL-aware tool does it. But the (1) is a display width &mdash; a client formatting hint, deprecated in MySQL 8 &mdash; not a constraint. The column physically stores the full signed 8-bit range, &minus;128..127. So a column some developer declared TINYINT(1) years ago and used as a small enum &mdash; status 0..6 &mdash; is boolean-by-convention only, and the convention is wrong for exactly that column. The boolean decode collapses every non-zero value to true: 0&ndash;6 became 0/1, at exit 0, in values no target could refuse.

## We warned, and lost the data anyway

The sharp part: sluice already detected this. It emitted a WARN naming the column &mdash; and then carried the collapsed value. The warning scrolled past in the output of a migration that &ldquo;succeeded.&rdquo; A warning you don't stop on is not a safeguard; it is a footnote on the corruption. v0.130.0 turns it into a hard refusal (SLUICE-E-VALUE-TINYINT1-RANGE) at the first value outside {0,1}, on every read path &mdash; bulk copy, binlog CDC, VStream CDC and cold start, and the flat-file source &mdash; before the row is written. And because a large multi-table copy would otherwise hit the bad row hours in, a fail-fast preflight probes each mapped column at planning time &mdash; &hellip; WHERE col NOT IN (0,1) LIMIT 1, capped with a MAX_EXECUTION_TIME hint so a clean unindexed column never pays a full table scan &mdash; and refuses before any target table is created.

## The twist: the wire decides, not your override

The printed remedy leads with &ldquo;change the source column's type&rdquo; (ALTER TABLE &hellip; MODIFY col SMALLINT) rather than the more convenient --type-override col=smallint, and the reason has transfer value. The override rewrites the declared schema the ordinary read paths decode with, and on those paths it works. But on a PlanetScale/Vitess source, the VStream cell decoder types the column from the replication wire's own column_type string &mdash; the wire says tinyint(1), so the wire decides boolean, and no schema-side override reaches that decision. The layer where a value's type is decided is not always the layer where you configured it.

## The transferable lesson

A display width is metadata wearing a constraint's clothes. &ldquo;The type says boolean&rdquo; is a convention you must be able to falsify against the data &mdash; one bounded probe per mapped column buys that &mdash; and a warning that doesn't halt anything is a claim your pipeline makes to nobody. This note's companion, the same tool disagreeing with itself about the same column type, picks up one layer down: even deciding whether a given tinyint(1) is a boolean turns out to have two answers inside one tool, and the two drifted. See also the warning your own next statement erases &mdash; MySQL telling you about a coercion in a way that doesn't stick is the engine-side member of the same family.

## Primary sources

- MySQL reference &mdash; numeric type syntax &mdash; BOOL/BOOLEAN as TINYINT(1) aliases; display width as a formatting hint, deprecated in 8.0.

- sluice v0.130.0 changelog &mdash; the field report, the refusal on every read path, and the bounded preflight.

- Related field notes: The same tool disagreed with itself about whether a TINYINT(1) is a boolean &mdash; the companion, one layer down; Your own next statement erases the warning.

---
Canonical page: https://sluicesync.com/field-notes/tinyint1-display-width/ · Full docs index: https://sluicesync.com/llms.txt
