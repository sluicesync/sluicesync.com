<!-- GENERATED FILE — DO NOT EDIT. Written by build.mjs; edit the page source there and re-run `node build.mjs`. -->
# Preview & validate before you migrate

> See the exact target DDL, steer the type translation, and confirm the copy — without guessing.

sluice is correctness-first: it would rather refuse loudly than land data subtly wrong. The flip side is that you can see everything it intends to do before it does it. This guide covers the three read-only inspection commands — schema preview, schema diff, and verify — plus --type-override, the one knob that steers translation when you disagree with a default. Reach for this guide whenever a migration touches types you care about (money, JSON, UUIDs, SQLite's untyped columns) or before any production cutover.

## 1. Preview the target DDL

schema preview reads the source schema, runs the full cross-engine translation, and prints the exact DDL the target engine would emit — with advisory notes on anything non-obvious. It never connects to the target to write; the target DSN is only used to construct the right dialect's writer:

    sluice schema preview \
        --source-driver mysql    --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET"

Scope it with --include-table / --exclude-table (glob-aware), write it to a file with -o ddl.sql, or get machine-readable output with --format json. This is where you eyeball how each MySQL type maps to Postgres before a single row moves.

## 2. Steer a type with --type-override

When you disagree with a default mapping — say you want a MySQL JSON column to land as Postgres jsonb rather than json, or a free-form column forced to text — override it per column. The format is TABLE.COLUMN=TYPE, repeatable, and it's accepted by preview, migrate, and sync start alike, so you can preview the override and then migrate with the identical flag:

    sluice schema preview \
        --source-driver mysql --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --type-override products.attrs=text \
        --type-override events.payload=jsonb

For target-type options that need more than a type name — e.g. jsonb with binary: true — use the YAML mappings: block instead of the CLI flag (the CLI form takes a bare type). See Configuration → YAML config.

## SQLite & D1: declared types vs stored affinity

SQLite (and Cloudflare D1) don't store strict types — a column has a declared type but values live under SQLite's loose affinity rules. sluice infers the target type from the declared type, but two cases need an explicit decision because guessing would risk a silently-wrong value:

- Dates & times. A column declared DATE / DATETIME / TIMESTAMP / TIME could hold ISO text, unix seconds/millis, or a Julian day. You name the encoding with --sqlite-date-encoding (iso default, or unixepoch / unixmillis / julian). A value whose storage class doesn't match is refused loudly, naming the row — never coerced to a wrong date.

- Outliers. If one column genuinely holds raw text you don't want interpreted, carry it as-is with --type-override <col>=text.

Preview an import the same way you'd preview any source — point --source-driver at sqlite or d1 — to see the resolved target types before committing. Full detail is in the SQLite/D1 guide.

## 3. Diff a live target against the source

When the target already exists — a previous migration, an Atlas/Liquibase-managed schema, a hand-built warehouse — schema diff compares what's actually on the target against what sluice would produce from the source, and reports the drift with copy-paste DDL suggestions. It exits non-zero on any difference, so it gates cleanly in CI:

    sluice schema diff \
        --source-driver mysql    --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET"

## 4. Verify the data landed

After a migration (or once a sync has caught up), verify compares the data itself. It has a depth ladder — start cheap, escalate only if you need stronger guarantees:

Depth · What it does ·

--depth count (default) · Per-table row-count comparison. Fast, catches whole-table and bulk-row loss. ·

--depth sample · Counts plus per-table sampled-row content hashes — ~99% confidence of catching a 5%+ corruption rate at the default 100 rows/table. Same-engine only: a cross-engine pair is refused, so use count there. Raise --sample-rows-per-table for rarer anomalies; --strict-hash switches the row hash from MD5 to SHA-256. ·

    # fast count check, CI-gated (non-zero exit on mismatch) — works across engines
    sluice verify --source-driver mysql --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" --depth count

    # content sampling with a larger sample — same engine on both sides
    sluice verify --source-driver postgres --source "$SLUICE_SOURCE" \
        --target-driver postgres --target "$SLUICE_TARGET" \
        --depth sample --sample-rows-per-table 500

Both modes accept --format json and -o FILE for piping into a CI gate or alertmanager. A full per-row hash mode is planned but not yet shipped.

### What verify cannot see

A clean verify is evidence, not proof of every value. Across engines it compares row counts only. Within one engine, --depth sample hashes a sample of rows per table. Since v0.158.1 both sides read one shared column plan — the source's column names, sorted, keyed by the source's primary key — by name, so a value sitting under the wrong column name mismatches, a target that only declares the same columns in another order stays clean, and a source column the target lacks fails the table as COLUMN-MISMATCH (exit 1; a column only the target has is named and left out of the hash). In --format json every table carries a one-word status (ok, count-mismatch, column-mismatch, sample-mismatch or unverified); branch on it, because a column mismatch sets none of the older fields.

A clean sample from v0.158.0 or older does not clear a swapped target. Before v0.158.1 each side hashed its columns in its own declared order, so a swapped target read clean (measured), and the row rendering collapsed some values that differ: NULL and an empty string; a value containing the | separator; a MySQL/MariaDB FLOAT (rendered at 6 significant digits); a MySQL GEOMETRY, BIT, BINARY, VARBINARY or BLOB value that is not valid UTF-8; a MySQL 8 JSON document larger than max_allowed_packet (which now refuses the table, naming the row — verify it with a larger max_allowed_packet); and a day/month-swapped DATE between Postgres endpoints with different DateStyle defaults. Re-run verify --depth sample on v0.158.1 or later.

Three defects fixed in v0.158.0 are still worth checking separately. Both backup verify depths and a restore read a chain as written, so none of them sees any of the three:

- A column swap on the target. A target whose columns hold each other's values (a source RENAME COLUMN swap that an earlier release forwarded as no change). On v0.158.1+ a sample catches it with high probability: the swap leaves every pre-swap row swapped, so a sample of N misses it only with probability (1−f)N for a pre-swap fraction f — about 3×10−5 at f = 10% and the default N = 100. If the pre-swap rows are a small fraction of the table, raise --sample-rows-per-table. Before v0.158.1 a sample read it as clean.

- Values decoded under the wrong column names behind the binlog head (Bug 301). Only the rows written in a window before the schema change are affected, typically far fewer than a sample reaches, so a sample flags one only if it happens to include it; a clean sample does not clear it, and a chain that captured them is internally consistent.

- MariaDB NO_LOG UNSIGNED values stored as negatives. These land on a cross-engine target, where verify compares counts, which catches a lost DELETE and nothing else.

No sluice check clears a target or chain exposed to the Bug 301 or NO_LOG defects on an affected release. What to check instead, and the remedy, is in the v0.158.0 notice.

---
Canonical page: https://sluicesync.com/docs/preview-and-validate/ · Full docs index: https://sluicesync.com/llms.txt
