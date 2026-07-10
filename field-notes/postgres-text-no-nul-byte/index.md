# Postgres text can't hold a NUL byte

> text, varchar, and char reject an embedded 0x00 with SQLSTATE 22021; MySQL char/text store it without complaint. A cross-engine copy hits it, and because it fires inside the COPY protocol the error lands far from the offending row.

Observed — MySQL → Postgres copy of a text column containing an embedded NUL byte. Internally the Postgres prepareValue NUL guard.

## What happened

A cross-engine copy of a perfectly ordinary VARCHAR column failed on the Postgres side with a cryptic invalid byte sequence for encoding "UTF8": 0x00 — and because it surfaced inside the bulk COPY stream, the error landed nowhere near the row that carried the byte. The source column held a string with an embedded 0x00 (a stray NUL from an upstream C string, a serialized blob mislabeled as text, a bad import), which MySQL had stored without objection.

## Why (the mechanism)

Postgres text types — text, varchar, char — cannot store a 0x00 byte. The NUL is reserved as a string terminator in the server's internal C representation, so an embedded one is rejected as an invalid byte sequence (SQLSTATE 22021, character-not-in-repertoire). MySQL's CHAR/VARCHAR/TEXT have no such rule — they treat the NUL as an ordinary byte and store it. So the value is legal on one engine and illegal on the other, and a migration is exactly where the two meet. The diagnosis is made harder by COPY: the failure fires while streaming the bulk buffer, so the error message is detached from the individual offending row.

## The repro

    -- MySQL stores an embedded NUL happily:
    CREATE TABLE t (id INT, s VARCHAR(64));
    INSERT INTO t VALUES (1, CONCAT('a', CHAR(0), 'b'));   -- OK, 3 bytes

    -- Postgres rejects the same bytes in a text type:
    SELECT E'a\x00b'::text;
    --   ERROR: invalid byte sequence for encoding "UTF8": 0x00  (SQLSTATE 22021)
    -- bytea holds arbitrary bytes, NUL included:
    SELECT E'\x610062'::bytea;   -- \x610062, no complaint

## What sluice does about it

sluice refuses the value loudly with a coded error (SLUICE-E-VALUE-NUL-BYTE) that names the column and the constraint, rather than letting the opaque COPY-stream error surface far from the row — and rather than the tempting silent "fix" of stripping the NUL, which would quietly alter the data. The data-preserving path, when you genuinely need to carry those bytes, is to target bytea, which stores arbitrary binary including 0x00. Loud refusal with the remedy named beats a cryptic wire error or a silent mutation.

## The transferable lesson

"It's a string column on both sides" is not the same as "the same bytes are legal on both sides." Postgres text is Unicode text with a hard rule — no 0x00 — that MySQL text does not share, so a value that lives happily in MySQL is a hard error in Postgres. When the two disagree about what bytes a type may hold, the honest options are to refuse loudly (naming the column and the fix) or to route the data to a type that can hold it (bytea); silently stripping the offending byte to make the insert succeed is data corruption wearing the disguise of a bug fix.

## Primary sources

- Postgres on the NUL character in text — character types and SQLSTATE 22021 in the error-code appendix.

- bytea for arbitrary bytes — binary data types.

- sluice's value contract and coded refusals — Error & exit codes.

---
Canonical page: https://sluicesync.com/field-notes/postgres-text-no-nul-byte/ · Full docs index: https://sluicesync.com/llms.txt
