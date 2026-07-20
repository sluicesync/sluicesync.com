# The catalog column that says PAD SPACE isn't in MariaDB

> MySQL 8 added a first-class information_schema.COLLATIONS.PAD_ATTRIBUTE column that says whether a collation is PAD SPACE (trailing spaces ignored in =) or NO PAD. MariaDB forked before that column existed and never added it, so the one attribute that decides whether 'EU' matches a stored 'EU ' is a queryable catalog fact on MySQL and only a _nopad_ token in the collation name on MariaDB. A comparator that keys off PAD_ATTRIBUTE is reading a hole on MariaDB; the fallback of parsing the name has to be anchored to a real-server oracle, or a NO-PAD collation whose name escapes the rule silently mis-pads a filtered row-move.

Observed — scoping sluice's filtered-sync --where collation comparator, which has to decide a column's PAD attribute to reproduce the source's own = for a filtered replica (2026-07-20). Ground-truthed side by side on mysql:8.0 and mariadb:11.4; the parity gate that keeps it honest ships on main (after v0.99.283).

## The catalog column MySQL added and MariaDB never had

MySQL 8 tells you authoritatively whether a collation compares PAD SPACE (trailing spaces ignored in =) or NO PAD (they are significant) with a first-class column in information_schema.COLLATIONS. MariaDB forked before 8.0 introduced that column, and never added it:

    -- MySQL 8
    SELECT COLLATION_NAME, PAD_ATTRIBUTE FROM information_schema.COLLATIONS
     WHERE COLLATION_NAME = 'utf8mb4_general_ci';
    --  utf8mb4_general_ci    PAD SPACE

    -- MariaDB 11.4
    SELECT PAD_ATTRIBUTE FROM information_schema.COLLATIONS ... ;
    --  ERROR 1054 (42S22): Unknown column 'PAD_ATTRIBUTE' in 'field list'

So the one attribute that decides whether a stored 'EU ' matches WHERE region = 'EU' is a queryable catalog fact in one engine and simply absent in the other.

## In MariaDB, NO-PAD is a naming convention, not a catalog fact

MariaDB still has NO-PAD collations — it just shipped them under a _nopad_ naming convention (utf8mb4_nopad_bin, utf8mb4_general_nopad_ci, utf8mb4_unicode_nopad_ci) instead of exposing the attribute in the catalog. On MariaDB the only signal for NO-PAD-ness is the substring nopad in the collation name: there is nothing to SELECT, so you parse the name or you probe the behavior. (MySQL's NO-PAD set is the modern utf8mb4_0900_* family plus binary — and there the catalog and the name agree.)

## Guess wrong and it is silent

A tool reproducing a source's = for a filtered replica has to know the PAD attribute: on a PAD SPACE column it must right-trim trailing spaces before comparing, on a NO-PAD column it must not. Treat MariaDB's utf8mb4_nopad_bin as PAD SPACE — the default outcome if you only special-case MySQL's _0900_ / binary — and you right-trim a column whose = is trailing-space-significant. A stored 'EU ' then wrongly compares equal to 'EU', and a row that moved out of a region = 'EU' filter (its trailing space meaning it no longer matches) is mis-classified as still in scope: a silent, trailing-space-only row-move error, exit 0. That is exactly the shape an internal audit (SL-COLL-1) caught before it shipped.

## What sluice does about it

sluice's collationNoPad classifier recognizes all three NO-PAD signals: MySQL's _0900_ family, binary, and MariaDB's nopad name token. Because that MariaDB branch rests on a naming convention rather than a catalog column, it is pinned by a dual-oracle real-server parity test that runs every CI cycle. On MySQL it asserts collationNoPad(name) equals the server's own PAD_ATTRIBUTE for every collation the catalog knows (286 of them), so a future MySQL NO-PAD collation whose name escapes the heuristic fails CI. On MariaDB — where there is no PAD_ATTRIBUTE to ask — it ground-truths behaviorally: it stores 'EU ' and checks whether WHERE v = 'EU' matches it (match ⇒ PAD SPACE, no match ⇒ NO PAD), then asserts the classifier agrees with what the real server actually does. The name heuristic is never trusted on its own — it is only ever a proxy for a real-server oracle.

## The transferable lesson

information_schema is not a portable contract across a fork. A column one engine adds after the split is simply missing in the other, and a reader that keys off it is silently reading a hole — not an error, just an absent field that defaults to whatever your code assumes. When the authoritative signal is gone, the fallback (here, parsing the collation name) is a heuristic — and a heuristic guarding a silent-loss decision has to be anchored to a real-server oracle: a catalog query where the catalog exists, a behavioral probe where it doesn't. That way the day the naming convention gains an exception, a test fails instead of a row quietly changing scope.

## Primary sources

- sluice internal/engines/mysql/collation.go (collationNoPad) and the dual-oracle parity gate collation_pad_attribute_integration_test.go (MySQL catalog assertion over all 286 collations + the MariaDB behavioral probe), ADR-0174; ground-truthed on mysql:8.0 / mariadb:11.4 (2026-07-20).

- MySQL 8.0 Reference Manual — information_schema.COLLATIONS (PAD_ATTRIBUTE, values PAD SPACE / NO PAD, added in 8.0).

- MariaDB Knowledge Base — information_schema.COLLATIONS (no PAD_ATTRIBUTE column) and the *_nopad_* NO-PAD collations.

- Related field notes — the = that ignores your trailing spaces (the PAD-SPACE row-loss this prevents on MySQL), MariaDB reports its defaults in a different dialect, and you can't reimplement MySQL's =.

---
Canonical page: https://sluicesync.com/field-notes/mariadb-no-pad-attribute-column/ · Full docs index: https://sluicesync.com/llms.txt
