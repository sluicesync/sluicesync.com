# BIT crosses the wire as bytes, and the engines disagree on layout

> MySQL hands BIT(N) back as ceil(N/8) right-justified big-endian bytes; Postgres surfaces bit as a '0'/'1' text string. Carry the raw bytes between them through one []byte path and you silently store the ASCII of the digits, not the bits.

Observed — migrating a BIT column between MySQL and Postgres. Internally catalog Bug 75.

## What happened

Carrying a BIT(N) value between engines through a single []byte IR path silently corrupted every value — it stored the ASCII bytes of the '0'/'1' digits and the writer then kept only the last one. A bit field that looked like a trivial "just move the bytes" column was the one that lost its data.

## Why (the mechanism)

The two engines put BIT on the wire in completely different shapes, and a raw-bytes IR is ambiguous between them:

- MySQL hands BIT(N) back as ceil(N/8) big-endian bytes, right-justified — the value's bits packed into the minimum number of bytes. BIT(14) = b'10110100110010' is two packed bytes.

- Postgres's bit / bit varying text I/O surfaces the value as a '0'/'1' text string already — the same form as the literal B'1010'.

So "the bytes" means packed bits on one side and ASCII digit characters on the other. A pipeline that grabbed the driver's bytes and re-decoded them as if they were packed bits took Postgres's "10110100110010" (fourteen ASCII characters) and interpreted it as raw bit-bytes — storing garbage, then truncating to the last byte. Same code path, opposite meaning, silent loss.

## What sluice does about it

Carry a single canonical form: a '0'/'1' text bit-string, most-significant bit first, exactly the column's declared bit-length (the same form Postgres's text I/O and B'…' literals use). It's engine-neutral and exact for any width. MySQL's packed bytes convert in via BitBytesToString (unpack ceil(N/8) right-justified big-endian bytes into the N-character string); the MySQL writer binds the uint64 form, not the raw bytes, so the write side doesn't re-introduce the ambiguity either. The canonical string is the one representation that can't be misread between the packed and expanded layouts.

## The transferable lesson

"It's a bit field, just move the bytes" hides that two databases disagree on what "the bytes" are: MySQL packs the bits into ceil(N/8) big-endian bytes, Postgres's text protocol hands you the ASCII '0'/'1' expansion. A raw-[]byte intermediate is ambiguous between the packed and expanded forms, and the ambiguity resolves as silent corruption. When two engines encode the same logical value differently on the wire, don't pass the wire bytes through — pick a canonical representation that is unambiguous at every width and convert at each engine boundary.

## Primary sources

- MySQL BIT storage & retrieval — The BIT Type and bit-value literals.

- Postgres bit text I/O — bit-string types.

- sluice's cross-engine value contract — Type mapping.

---
Canonical page: https://sluicesync.com/field-notes/mysql-bit-wire-bytes/ · Full docs index: https://sluicesync.com/llms.txt
