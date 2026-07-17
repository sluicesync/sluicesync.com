# MariaDB 11.4's default collation doesn't exist on MySQL 8

> Migrate a MariaDB 11.4 schema to a MySQL-family target and sluice WARNs on nearly every string column — because 11.4 made utf8mb4_uca1400_ai_ci (UCA 14.0.0) the server default, and no MySQL 8 server implements it. sluice maps each affected column to the closest equivalent MySQL 8 has, utf8mb4_0900_ai_ci (UCA 9.0.0), preserves every byte, and surfaces the swap. This note is why that WARN is correct-by-design, not a data problem: the bytes are intact; only the collation weights (and PAD semantics) for a small set of characters change.

Observed — live-validating MariaDB as a migrate source (2026-07-17): MariaDB 11.4 → vanilla MySQL 8.4 and MariaDB 11.4 → PlanetScale (MySQL) on the shipped mariadb flavor (v0.99.268+). Both runs completed all seven tables with a clean verify --depth count — and both logged a collation WARN on essentially every string column. Nothing was wrong. This note is why that WARN is the tool being honest, not a failure.

## A warning on almost every VARCHAR

Point sluice migrate at a MariaDB 11.4 source landing on a MySQL or PlanetScale target and the log fills with a repeating line, once per table, naming each string column:

    WARN mysql: column data is preserved; some source collations do not exist on this
         target's server family, so the closest equivalent is used (edge-case sort/comparison
         order may differ — UCA version and PAD semantics)
         table=customers columns="email (utf8mb4_uca1400_ai_ci → utf8mb4_0900_ai_ci)"

On a schema of any width that is a lot of WARNs — it fires on essentially every VARCHAR/TEXT/CHAR column of an 11.4 source. The volume is alarming the first time you see it. It is also entirely expected, and it means exactly what it says.

## Where the collation went

MariaDB 11.4 changed its server default collation to utf8mb4_uca1400_ai_ci — the Unicode Collation Algorithm 14.0.0 weight tables, accent- and case-insensitive. So a column declared with no explicit COLLATE clause on an 11.4 server inherits uca1400, and that is now the common case rather than the exotic one.

MySQL 8's newest UCA collation is utf8mb4_0900_ai_ci — UCA 9.0.0. There is no uca1400 collation on any MySQL 8 server, of any flavor. A CREATE TABLE that names utf8mb4_uca1400_ai_ci on a MySQL 8 target fails outright with Error 1273: Unknown collation. The two engines' newest Unicode collations are five UCA revisions apart, and the names don't overlap.

## What sluice does — and why it isn't loss

sluice's cross-flavor collation remap (roadmap item 73) maps every utf8mb4_uca1400_* collation to the closest same-semantics collation the MySQL 8 target actually implements — utf8mb4_uca1400_ai_ci → utf8mb4_0900_ai_ci, and the accent/case-sensitive and binary variants alongside it — so the emitted DDL is valid on the whole supported MySQL-family floor instead of dying on Error 1273. Crucially, the remap is never silent: the CREATE-TABLE path emits one WARN per table naming each remapped column, and the ALTER paths emit one per column, both carrying the same message — &ldquo;column data is preserved &hellip; the closest equivalent is used &hellip;&rdquo;.

That first clause is the whole point. A collation is a comparison and sort rule, not an encoding — it does not touch the stored bytes. Every string value migrates byte-for-byte identical; what the remap changes is only the rule the target uses to order and compare those bytes. And even that rule is almost the same: UCA 14.0.0 and UCA 9.0.0 assign identical weights to the overwhelming majority of characters, differing only for scripts and codepoints added or reweighted between the two Unicode revisions. The one genuine semantic delta beyond that is PAD: the uca1400 collations are PAD SPACE while the 0900 set is NO PAD, so trailing-space handling in comparisons can differ. sluice deliberately declines to guess for language-specific tailorings (utf8mb4_uca1400_de_* and friends): those pass through verbatim and fail loudly on a target that lacks them, rather than silently substituting a different language's collation table.

## When to actually care

For the common case — application text compared for equality, sorted for display, indexed for lookup — the closest-equivalent mapping is correct and you can ignore the WARN. It matters only if your application depends on the exact collation ordering of characters that were reweighted between UCA 9.0.0 and 14.0.0, or on PAD SPACE trailing-space equality. If it does, review the named columns and set an explicit COLLATE that both engines share (or one you have validated on the target), rather than relying on the inherited default. A future UX polish could de-noise the per-column storm into a single per-run summary; the honesty of surfacing every swap is the part that must not change.

## The transferable lesson

&ldquo;Compatible&rdquo; engines drift at their defaults, and a version bump can move a default from exotic to universal overnight — MariaDB 11.4 turned uca1400 from a column you had to ask for into the collation every string column inherits. When the target can't reproduce a source attribute exactly, the right move is a preserving substitution that fails loud when it can't be honest, and a WARN that says precisely what changed and what didn't. A warning on every column is not the tool struggling; it is the tool refusing to let a semantic difference cross the boundary unannounced. Read the message: &ldquo;column data is preserved&rdquo; is a promise, not a hedge.

## Primary sources

- sluice roadmap item 73 (MariaDB flavor) — crossFlavorCollationRemap and the utf8mb4_uca1400_* &harr; utf8mb4_0900_* remap tables in internal/engines/mysql, with the per-table (CREATE) and per-column (ALTER) WARNs; live-validated on mariadb:11.4 → mysql:8.4 and → PlanetScale (2026-07-17).

- MariaDB Knowledge Base — Unicode collation versions; utf8mb4_uca1400_ai_ci as the 11.4 default (UCA 14.0.0, PAD SPACE).

- MySQL 8.0 Reference Manual — utf8mb4_0900_ai_ci (UCA 9.0.0, NO PAD); Error 1273 Unknown collation.

- Related — the Migrating from MariaDB guide (this WARN in context), and sibling MariaDB notes: MariaDB reports its defaults in a different dialect and MariaDB and MySQL 8 disagree on which coordinate comes first (another correct-by-design MariaDB divergence).

---
Canonical page: https://sluicesync.com/field-notes/mariadb-default-collation-remap/ · Full docs index: https://sluicesync.com/llms.txt
