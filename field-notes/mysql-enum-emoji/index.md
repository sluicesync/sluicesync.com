# MySQL's data dictionary turned our emoji into question marks

> A MySQL ENUM whose label contains an emoji doesn't contain that emoji by the time you read it back. MySQL substitutes ? for 4-byte UTF-8 characters in ENUM/SET labels at CREATE TABLE time, regardless of column charset — and the label is gone from the catalog before any client sees it.

Observed — MySQL → Postgres cross-engine migrate, ENUM/SET columns with supplementary-plane labels. Internally Bug 106; documented and surfaced in v0.92.2. This is a MySQL server behavior, not a sluice bug.

## What happened

A MySQL → Postgres migrate of a table with ENUM('vanilla','strawberry-🍓', &hellip;) on a utf8mb4 column created the target enum type with a corrupted label — strawberry-? — and then loud-failed the first row INSERT, because the source row's genuine F0 9F 8D 93 bytes matched nothing in the target enum:

    ERROR: invalid input value for enum enum_utf8_flavor_enum: "strawberry-🍓" (SQLSTATE 22P02)

The row data was fine. The enum label in the schema was already ? before sluice ever read it.

## Why (the mechanism)

MySQL's data dictionary silently substitutes ? for supplementary-plane (4-byte UTF-8) characters in ENUM/SET labels at CREATE TABLE time — regardless of the column's charset. 2-byte and 3-byte BMP characters (é, 日) survive; only 4-byte characters (emoji) are transliterated. Inspect the label bytes and the loss is unambiguous:

    strawberry-?  hex=737472617762657272792d3f   <- emoji replaced with 0x3f '?'
    espéçial      hex=657370c3a9c3a769616c       <- 2-byte chars survived
    日本語        hex=e697a5e69cace8aa9e         <- 3-byte chars survived

The crucial part: this happens to the label in the catalog, not to the column's row data. A stored row keeps the real bytes; only the enum's definition is corrupted, at table-creation time, before any client reads it back. So a cross-engine migration faithfully creates a target enum type with the mangled label and then can't insert the source's honest bytes. mysqldump reproduces the identical loss — the label is gone from the source's own catalog, so no tool can recover it. The original suspicion was a session-charset issue (character_set_results), but forcing utf8mb4 on the connection does not fix it; the substitution is a server-side data-dictionary property.

## The repro

    CREATE TABLE enum_utf8 (
      id BIGINT PRIMARY KEY,
      flavor ENUM('vanilla','strawberry-🍓','espéçial','日本語') CHARACTER SET utf8mb4
    );

    -- read the label back — the emoji is already '?', regardless of your session charset:
    SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_NAME = 'enum_utf8' AND COLUMN_NAME = 'flavor';
    --  enum('vanilla','strawberry-?','espéçial','日本語')

## What sluice does about it

The only honest response available: sluice detects a ? in ENUM/SET label metadata at schema-read and WARNs before the runtime INSERT loud-fails, so the operator learns about the loss at the top of the run instead of mid-copy. The heuristic is kept narrow (warn only when a label literally contains ?) to avoid false positives, and the escape hatch is --type-override <table>.<col>=text, which carries the column as free text so the real bytes migrate. sluice can't recover the original label — nobody can — but it refuses to let the loss be a surprise.

## The transferable lesson

Character-set correctness is not uniform across a database's own surfaces. A column declared utf8mb4 stores 4-byte characters perfectly in its rows while the same server silently downgrades them in identifiers and enum labels in the data dictionary. When you copy schema, you are copying metadata that may have passed through a lossier path than the data did — verify label and identifier bytes with hex(), not by eye, and treat a corrupted catalog value as unrecoverable rather than assuming a re-read with the right charset will heal it.

## Primary sources

- MySQL ENUM type and its limits — MySQL 8.0 Reference Manual: the ENUM type.

- MySQL character-set support and utf8mb4 — the utf8mb4 character set.

- sluice type mapping and overrides — type mapping (the --type-override escape).

---
Canonical page: https://sluicesync.com/field-notes/mysql-enum-emoji/ · Full docs index: https://sluicesync.com/llms.txt
