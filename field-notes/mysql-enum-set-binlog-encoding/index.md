<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# ENUM is an ordinal and SET is a bitmask on the wire

> In a raw binlog row event a MySQL ENUM cell is its 1-based ordinal and a SET cell is a numeric bitmask; the member-name list lives only in the table definition, never in the event. Decode without the schema and SET('a','c') becomes "5". Snapshot and VStream hand you text, so it hides until raw CDC.

Observed — MySQL raw-binlog CDC of ENUM / SET columns. Internally Bug 145 (ENUM ordinal) + Bug 148 (SET bitmask).

## What happened

A MySQL CDC stream delivered an ENUM('small','medium','large') value as 2 and a SET('a','b','c') value as 5 instead of 'medium' and 'a,c'. The same columns had round-tripped perfectly during the bulk-copy snapshot — the divergence appeared only once the raw binlog took over.

## Why (the mechanism)

MySQL stores ENUM and SET as integers and puts those integers, not the labels, on the binlog wire:

- an ENUM cell in a RowsEvent is its 1-based ordinal ('medium' → 2);

- a SET cell is a numeric bitmask (bit i → the i-th member; 'a','c' → 0b101 = 5), sized to the storage width.

The mapping from those integers back to label strings lives only in the table definition — it is never in the row event. A CDC reader that doesn't join the event against the schema decodes the raw integer and emits "2" / "5". What hides the bug is that the two other ways of reading the same data both resolve the labels for you: a snapshot via database/sql returns the text, and Vitess VStream returns the text — so everything looks correct until you hit the raw binlog path, where the integers are all you get. (And a bit set beyond the declared members must be an error, not silently dropped.)

## The repro

    CREATE TABLE t (id INT, size ENUM('small','medium','large'), tags SET('a','b','c'));
    INSERT INTO t VALUES (1, 'medium', 'a,c');

    -- a snapshot query resolves the labels:
    SELECT size, tags FROM t;           -- 'medium', 'a,c'

    -- the raw binlog RowsEvent carries the integers:
    --   size = 2         (1-based ordinal of 'medium')
    --   tags = 5         (bitmask 0b101 = 'a' | 'c')
    -- decode without the ENUM/SET member list and you store "2" and "5".

## What sluice does about it

sluice carries the ENUM/SET member lists from the table's schema into the binlog decoder, so an ordinal is resolved back to its label and a bitmask is expanded to the comma-joined member set — matching exactly what the snapshot and VStream paths produce, so the two halves of a cold-start-then-CDC migration agree. A bitmask bit or ordinal outside the declared members is refused loudly rather than dropped, because a value the schema can't explain is a signal, not a row to guess at. This is a companion to a different ENUM/SET trap — MySQL substituting ? for a 4-byte-UTF-8 label at CREATE TABLE — two independent ways these "simple" types are sneakier than they look.

Update (v0.156.3): "VStream hands you text" is not true for every column. vttablet sends an ENUM/SET cell of a non-UTF-8 column as UTF-8 label text in CDC but as its stored bytes in the COPY phase, with identical field metadata — so through v0.156.2 a COPY cell holding Ã© in a latin1 ENUM('é','Ã©') landed as the other member, é, silently. A _bin-collated ENUM/SET arrives typed as binary and had arrived as bytes in both phases. Since v0.156.3 sluice resolves each such cell against the column's own label list, and refuses (CHARSET-NOT-DECODABLE) a cell that is a member under both readings; the empty string MySQL stores for an invalid ENUM value (index 0) is a member of every ENUM. On the binlog an ENUM/SET cell is still an index or bitmask, as above. See non-UTF-8 character sets.

## The transferable lesson

ENUM and SET are integers in a trenchcoat: an ordinal and a bitmask on disk and on the binlog wire, with the crucial integer→label dictionary held only in the table definition. Any decoder that reads the raw replication stream must join it against the schema to recover meaning — and the danger is that the easy paths (query results, VStream) do that join for you, so the raw-binlog path is the one place the abstraction leaks, and it leaks silently as plausible-looking numbers. When a value's meaning lives in metadata separate from the value, make sure every read path has that metadata in hand.

## Primary sources

- MySQL ENUM and SET storage (ordinal / bitmask) — The ENUM Type and The SET Type.

- Binlog row images — Rows_event.

- sluice's cross-engine value contract — Type mapping.

---
Canonical page: https://sluicesync.com/field-notes/mysql-enum-set-binlog-encoding/ · Full docs index: https://sluicesync.com/llms.txt
