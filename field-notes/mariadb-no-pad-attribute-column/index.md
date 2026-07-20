# MySQL has had this collation column since 8.0; MariaDB added it in 12.1

> MySQL 8 has an information_schema.COLLATIONS.PAD_ATTRIBUTE column that says whether a collation is PAD SPACE (trailing spaces ignored in =) or NO PAD. MariaDB shipped without it for years — absent through the whole 11.x LTS line and 12.0, added only in 12.1 — so on the MariaDB most people run, the attribute that decides whether 'EU' matches a stored 'EU ' is not in the catalog and you read the _nopad_ collation name instead. A portable reader can't assume the column is present or absent across versions; the version-robust signals are the name token and the server's own behavior, and sluice's parity gate anchors to both.

Observed — scoping sluice's filtered-sync --where collation comparator, which has to decide a column's PAD attribute to reproduce the source's own = for a filtered replica. Ground-truthed across the MariaDB line &mdash; 11.4, 11.8, 12.0, 12.1, 12.2, 12.3 &mdash; and mysql:8.0 (2026-07-20). The parity gate that keeps sluice's classifier honest ships on main (after v0.99.283).

## A collation column MySQL has had since 8.0

MySQL 8 tells you authoritatively whether a collation compares PAD SPACE (trailing spaces ignored in =) or NO PAD (they are significant) with a first-class column in information_schema.COLLATIONS, present since 8.0:

    SELECT COLLATION_NAME, PAD_ATTRIBUTE FROM information_schema.COLLATIONS
     WHERE COLLATION_NAME = 'utf8mb4_general_ci';
    --  utf8mb4_general_ci    PAD SPACE

MariaDB &mdash; a fork that markets MySQL compatibility &mdash; shipped without that column for years. It is not there on the MariaDB most production systems run today:

    information_schema.COLLATIONS.PAD_ATTRIBUTE present?

      MySQL     8.0+    yes
      MariaDB   11.4    no     (LTS)
      MariaDB   11.8    no     (LTS)
      MariaDB   12.0    no
      MariaDB   12.1    yes    <- added here
      MariaDB   12.2    yes
      MariaDB   12.3    yes

So the attribute that decides whether a stored 'EU ' matches WHERE region = 'EU' is a queryable catalog fact on MySQL 8, absent on the entire MariaDB 11.x LTS line and 12.0, and present again from MariaDB 12.1. Query PAD_ATTRIBUTE against 11.8 and you don't get a NULL or an empty result &mdash; you get ERROR 1054: Unknown column 'PAD_ATTRIBUTE'.

## The catalog surface is version-dependent, so you can't assume it

That is the trap. A reader written against MySQL, or against MariaDB 12.1+, that SELECTs PAD_ATTRIBUTE works &mdash; until it meets an 11.x server and the query errors out. A reader that assumes MariaDB never has it (as an earlier version of this very note wrongly did) is wrong from 12.1 on. Neither &ldquo;it's there&rdquo; nor &ldquo;it's not there&rdquo; is safe across a compatible fork's version range. What is stable: MariaDB names its NO-PAD collations with a _nopad_ token (utf8mb4_nopad_bin, utf8mb4_general_nopad_ci, utf8mb4_unicode_nopad_ci) in every version, and the server's actual = behavior is queryable everywhere. The version-independent signals are the name and the behavior &mdash; not the catalog.

## Guess wrong and it is silent

A tool reproducing a source's = for a filtered replica has to know the PAD attribute: on a PAD SPACE column it must right-trim trailing spaces before comparing, on a NO-PAD column it must not. Treat MariaDB's utf8mb4_nopad_bin as PAD SPACE — the default outcome if you only special-case MySQL's _0900_ / binary — and you right-trim a column whose = is trailing-space-significant. A stored 'EU ' then wrongly compares equal to 'EU', and a row that moved out of a region = 'EU' filter (its trailing space meaning it no longer matches) is mis-classified as still in scope: a silent, trailing-space-only row-move error, exit 0. That is exactly the shape an internal audit (SL-COLL-1) caught before it shipped.

## What sluice does about it

sluice's collationNoPad classifier keys off the version-independent name signal — MySQL's _0900_ family, binary, and MariaDB's nopad token — with no catalog query, so it behaves identically on MariaDB 11.8 and 12.3. Because that rests on a naming convention, it is pinned by a dual-oracle real-server parity test that runs every CI cycle. On MySQL (where the column has always existed) it asserts collationNoPad(name) equals the server's own PAD_ATTRIBUTE for every collation the catalog knows (286 of them), so a future MySQL NO-PAD collation whose name escapes the heuristic fails CI. On MariaDB it ground-truths behaviorally across the whole LTS spread — it stores 'EU ' and checks whether WHERE v = 'EU' matches it (match ⇒ PAD SPACE, no match ⇒ NO PAD), then asserts the classifier agrees with the real server — because a behavioral probe is the one oracle that works whether or not a given release happens to expose PAD_ATTRIBUTE. The name heuristic is never trusted on its own; it is only ever a proxy for a real-server oracle.

## The transferable lesson

information_schema is not a portable contract across a fork — and it isn't even stable across the fork's own versions. A column MySQL has had since 8.0 was absent from MariaDB's current LTS line and only landed in 12.1, so a reader that keys off it works on some MariaDB versions and errors or mis-reads on others. When you depend on a catalog attribute of a claimed-compatible engine, don't assume it is present or absent: find a version-independent signal (here, the collation name and the server's own comparison behavior), and anchor it to a real-server oracle — a catalog query where the catalog has it, a behavioral probe where it might not — so the day a version moves the ground under you, a test fails instead of a row quietly changing scope.

## Primary sources

- sluice internal/engines/mysql/collation.go (collationNoPad) and the dual-oracle parity gate collation_pad_attribute_integration_test.go (MySQL catalog assertion over all 286 collations + the MariaDB behavioral probe), ADR-0174; ground-truthed on mysql:8.0 and MariaDB 11.4 / 11.8 / 12.0 / 12.1 / 12.2 / 12.3 (2026-07-20).

- MySQL 8.0 Reference Manual — information_schema.COLLATIONS (PAD_ATTRIBUTE, values PAD SPACE / NO PAD, present since 8.0).

- MariaDB Knowledge Base — information_schema.COLLATIONS (the PAD_ATTRIBUTE column, added in the 12.1 series) and the *_nopad_* NO-PAD collations.

- Related field notes — the = that ignores your trailing spaces (the PAD-SPACE row-loss this prevents on MySQL), MariaDB reports its defaults in a different dialect, and you can't reimplement MySQL's =.

---
Canonical page: https://sluicesync.com/field-notes/mariadb-no-pad-attribute-column/ · Full docs index: https://sluicesync.com/llms.txt
