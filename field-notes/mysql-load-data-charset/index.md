# One LOAD DATA can't load a BLOB and a JSON column at once

> A BLOB column needs CHARACTER SET binary or the server rejects its first non-ASCII byte; a JSON column rejects its input under CHARACTER SET binary. The two requirements point opposite ways, and there is no statement-level clause that satisfies both.

Observed — MySQL bulk load via LOAD DATA LOCAL INFILE into a table with both a binary and a JSON column. Internally the LOAD DATA row writer, ADR-0026.

## What happened

The fast bulk-load path — LOAD DATA LOCAL INFILE, typically 5&ndash;10&times; faster than parameter-bound multi-row INSERTs because the server parses one statement and one stream — hit a table that carried both a BLOB/VARBINARY column and a JSON column. There is no single CHARACTER SET clause on the statement that loads both. Pick either one and the other column's rows are rejected.

## Why (the mechanism)

LOAD DATA validates every input byte against a charset, and that charset is a statement-level setting — one CHARACTER SET clause for all columns. The two column types want opposite things from it:

- Without CHARACTER SET binary, the server validates input against the connection charset (utf8mb4) and rejects the first non-ASCII byte in a BLOB/VARBINARY column with Error 1300: Invalid utf8mb4 character string. Any binary column is silently broken.

- With CHARACTER SET binary, the server flips: a JSON column rejects its input with Cannot create a JSON value from a string with CHARACTER SET 'binary', because JSON requires a Unicode-tagged input stream.

The requirements are mutually exclusive at the statement level: binary columns demand the raw-bytes charset, JSON columns demand a Unicode one, and you get to name exactly one.

## The repro

    CREATE TABLE mixed (id INT PRIMARY KEY, blob_col BLOB, json_col JSON);

    -- utf8mb4 (default): the BLOB's first non-ASCII byte →
    --   ERROR 1300 (HY000): Invalid utf8mb4 character string
    LOAD DATA LOCAL INFILE 'Reader::x' INTO TABLE mixed
      CHARACTER SET utf8mb4 (id, blob_col, json_col);

    -- CHARACTER SET binary: the JSON column →
    --   ERROR 3144 (22032): Cannot create a JSON value from a string
    --   with CHARACTER SET 'binary'
    LOAD DATA LOCAL INFILE 'Reader::x' INTO TABLE mixed
      CHARACTER SET binary (id, blob_col, json_col);

## What sluice does about it

Load every field into a user variable under CHARACTER SET binary, then re-tag per column in a SET clause. Binary, numeric, and temporal columns take their variable verbatim (raw bytes, exactly what they want); JSON, TEXT, VARCHAR, and SET columns get CONVERT(@cN USING utf8mb4) — the bytes are unchanged, only the charset tag is corrected:

    LOAD DATA LOCAL INFILE 'Reader::x' INTO TABLE mixed
      CHARACTER SET binary
      (@c0, @c1, @c2)
      SET id       = @c0,
          blob_col = @c1,                      -- raw bytes, verbatim
          json_col = CONVERT(@c2 USING utf8mb4); -- re-tagged to Unicode

The per-column re-tag is a named, tested wart (columnSetExpr): adding a new type that needs re-tagging is a one-line switch case. (Geometry stays on the batched-INSERT path and forgoes the LOAD DATA speedup; the fallback names the offending column in a WARN so the cause is diagnosable from one log line.)

## The transferable lesson

CHARACTER SET on LOAD DATA is a single, statement-wide, all-columns setting for what is really a per-column problem — and MySQL's own type system contains two columns that demand incompatible answers. The escape hatch is a general one: when a bulk statement must apply different byte-interpretation rules to different columns, funnel every field through a user variable and do the per-column work in a SET clause, where each column gets its own expression. It is the row-writer analogue of never trusting a single global setting to be right for every member of a heterogeneous set.

## Primary sources

- MySQL LOAD DATA, its CHARACTER SET clause, and the user-variable + SET form — LOAD DATA statement.

- Why JSON rejects a binary charset — The JSON Data Type.

- How sluice bulk-loads a MySQL target — How sluice copies your data.

---
Canonical page: https://sluicesync.com/field-notes/mysql-load-data-charset/ · Full docs index: https://sluicesync.com/llms.txt
