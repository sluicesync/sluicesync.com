# The two MySQL escapes that keep their backslash

> MySQL's string-literal escape table has a trap in its last two rows: \% and \_ do not evaluate to % and _ — they evaluate to the two bytes \% and \_, backslash included. Every other unrecognized escape drops the backslash. A uniform unescaper — which is what almost every hand-rolled MySQL-literal decoder is — silently shortens data containing literal backslash-percent sequences by one byte.

Observed — building sluice's mydumper flat-file source engine (ADR-0161, fixed in the shared quoted-string decoder, v0.99.247). The wrong rule was unreachable on sluice's live read paths — MySQL's own literal printing never emits \% or \_ — and became load-bearing the moment arbitrary dump files entered the picture.

## What happened

MySQL string literals have a short table of named escapes (\0, \b, \n, \r, \t, \Z, \\, \', \") and a general rule for everything else: an unrecognized \x evaluates to x — the backslash is dropped. Nearly every hand-rolled decoder implements the table plus the general rule and stops.

The actual grammar has two more rows. \% evaluates to the two bytes \% and \_ to \_ — backslash kept. They're LIKE-pattern escapes: preserved so that a pattern-matching wildcard escape survives the trip through a string literal into a LIKE context. Outside any LIKE, in plain data, the parser still applies that rule — so a stored value containing a literal backslash-percent must be written as '\%' in a dump, and must decode back to backslash-percent, not percent.

A decoder applying the uniform drop-the-backslash rule to those two sequences silently emits one byte fewer. No error, no warning — the string is simply shorter, and almost-right: \%discount\% becomes %discount%, plausible enough to pass any casual inspection.

## Why it stayed hidden, and where it bit

The correctness oracle for reading a dump file is precise: decode exactly the bytes MySQL's parser would store if myloader replayed this literal. sluice's shared quoted-string decoder predated the dump reader and carried the uniform rule — harmlessly, because its inputs were MySQL's own literal output (information_schema defaults and the like), and MySQL's literal printer never produces \% or \_. Dump files broke that assumption: a dump is arbitrary literals headed for MySQL's grammar, covering the entire escape surface, including the two rows the uniform rule gets wrong. The fix landed in the shared decoder, with pins for both sequences in every quoting shape the dump family produces.

## Reproducing it

    mysql> CREATE TABLE t (s VARCHAR(20));
    mysql> INSERT INTO t VALUES ('50\%');    -- literal evaluates to: 50\%
    mysql> SELECT s, LENGTH(s) FROM t;
    -- 50\%   4         <- backslash kept: four bytes, not three

Now dump the table (mydumper or mysqldump both re-emit the value as the literal '50\%') and run the dump through any decoder that applies the uniform drop-the-backslash rule to unknown escapes — it emits 50%, three bytes, one silently gone. The diff oracle is the server itself: replay the dump into MySQL (myloader/mysql client), SELECT LENGTH(s), and compare against your decoder's output length; MySQL says 4, the naive unescaper says 3.

## The transferable lesson

When you implement a decoder for someone else's literal grammar, the exceptions to the general rule are the entire job — the general rule is the easy 95% that every implementation gets right, and the two rows that contradict it are where the silent byte-level corruption lives. Read the grammar's table to the end, and test the decoder against the oracle that matters: not &ldquo;does it look right,&rdquo; but &ldquo;does it produce exactly the bytes the original parser would store.&rdquo; One-character mechanism, silent-corruption consequence — the cheapest class of bug to prevent and among the hardest to notice after the fact.

## Primary sources

- MySQL Reference Manual — String Literals: the escape-sequence table, including \% and \_ evaluating to \% and \_ (&ldquo;used to search for literal instances of % and _ in pattern-matching contexts&rdquo;), and the drop-the-backslash rule for other unrecognized escapes.

- sluice ADR-0161 §4 — the shared quoted-string decoder and the keep-the-backslash fix, pinned across the dump family's quoting shapes.

---
Canonical page: https://sluicesync.com/field-notes/mysql-like-escapes-keep-backslash/ · Full docs index: https://sluicesync.com/llms.txt
