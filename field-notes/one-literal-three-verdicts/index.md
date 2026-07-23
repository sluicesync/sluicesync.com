# One literal, three verdicts

> Hand Postgres, MySQL, and MariaDB the same WHERE d = '2024-01-01 08:30' on a DATE column and you get three different comparison semantics: PG casts the literal down to the column's type (time-of-day discarded — the row matches), MySQL promotes the column up to datetime (no match), and MariaDB promotes like MySQL but truncates extra fractional digits where MySQL rounds half-up. Any system that evaluates one predicate in two places disagrees with itself exactly on these boundaries — so normalize each literal under the source engine's own lens, and refuse when you don't have one.

Observed &mdash; ground-truthed on real servers (PostgreSQL 16.14, MySQL 8.0.46, MariaDB 11.8.8) on 2026-07-23, building the temporal leg of sluice's filtered-sync predicate evaluator. The two-evaluator defect it explains affected sluice v0.99.276&ndash;v0.99.290 (every filtered-sync release); fixed in v0.99.291.

## Three engines, three rules

The question sounds too basic to have three answers: a temporal literal is finer-grained than the column it's compared against &mdash; a time-of-day against a DATE, or more fractional-second digits than the engine's microsecond resolution. Every engine has to reconcile the mismatch somehow, and the three of them picked three different reconciliations:

    WHERE d = '2024-01-01 08:30'      -- d is a DATE column; the row holds 2024-01-01

    Postgres 16.14   casts the LITERAL down to the column's type:
                     d = '2024-01-01'::date            -> row MATCHES
    MySQL 8.0.46     promotes the COLUMN up to datetime, compares the full instant
                                                       -> NO match
    MariaDB 11.8.8   promotes like MySQL -- but splits from it one level down:

      extra fractional digits (beyond the engine's 6):
      MySQL    '.1234565' -> .123457    round HALF-UP on the exact digits, with carry
      MariaDB  '.1234565' -> .123456    TRUNCATE, no carry
      Postgres '.1234565' -> .123456    its own third rule -- rounding through a C double

Note where the splits fall. Postgres vs the MySQL family is a direction disagreement &mdash; coerce the literal down vs promote the column up &mdash; visible on any date-vs-datetime comparison. But MySQL vs MariaDB is a fork disagreeing with itself, one level down, on rounding: half-up with carry against truncation without. And Postgres's rounding isn't exact decimal either &mdash; the fraction goes through an IEEE-754 double before rint, a rule subtle enough that it gets its own note. A bonus fact the real-server matrix pinned: comparison precision is the type's microsecond resolution, not the declared column precision &mdash; a timestamp(0) column still compares literals at full &micro;s (the typmod rounds what gets stored, not what gets compared), verified with rows read back from the servers themselves.

## Postgres coerces at DDL time too &mdash; and stores the result

The Postgres half goes one step further than query evaluation. Put the same finer-than-column literal into a publication row filter and PG doesn't refuse it &mdash; it coerces the literal at CREATE PUBLICATION time and stores the truncated predicate in the catalog:

    CREATE PUBLICATION p FOR TABLE t WHERE (d < '2026-01-15 12:00');
    -- accepted, no warning. Now read the definition back:
    SELECT pg_get_expr(prqual, prrelid) FROM pg_publication_rel;
    --   (d < '2026-01-15'::date)          <- the time-of-day is gone, durably

From that point the stored prqual &mdash; not your input text &mdash; is the contract: it's what the server evaluates for every streamed change, forever. The subtlety, and the reason this isn't simply &ldquo;PG loses data&rdquo;: the snapshot SELECT coerces the same literal identically, so a system whose filtering is entirely server-side gets a perfectly self-consistent PG-semantics replica. The defect isn't in the engine. It appears the moment a second evaluator &mdash; an equivalence belt, a verify leg, a client-side CDC filter &mdash; runs the same predicate at a different precision than the server it's mirroring. Read the definition back after DDL; the catalog's rendering is the truth.

## Two evaluators, one predicate, silent disagreement

That's exactly the position filtered CDC is in: no source delivers a filtered change stream for free, so the --where predicate the snapshot leg pushed into the source's SQL gets re-evaluated client-side, per change event (the predicate you evaluate twice has to agree, or refuse). sluice's client evaluator compared temporal literals at full parsed precision &mdash; a fourth semantics no engine implements. On a PG source, --where "d = '2024-01-01 08:30'" snapshot-copied the row (PG truncated the literal; the row matches) and the client evaluator then judged every one of its subsequent changes out-of-scope and dropped them: a stale target row at exit 0, the same one-row-two-verdicts shape as the collation and PAD-SPACE splits before it, now on the temporal axis.

## Normalize under the source's lens &mdash; and refuse without one

The fix shape generalizes past temporals: the source engine names its coercion rule as a small declared semantics (ir.TemporalLiteralSemantics &mdash; cast-to-column for PG, promote-and-round-half-up for MySQL, promote-and-truncate for MariaDB, flavor-parameterized because a fork can split from its parent), and the engine-neutral evaluator normalizes each literal under that lens at compile time, carrying no per-engine reasoning of its own. The load-bearing discipline is the default: when no lens is available, sluice refuses the predicate outright rather than comparing at full precision &mdash; because full precision is not a neutral fallback, it's a fourth rule that provably disagrees with all three engines on the boundary. One honest residual: on Vitess sources the pushed filter runs on vtgate's evalengine, whose coercion of these shapes is unverified &mdash; so predicates that engage it route through the client-side fallback rather than the server push until a real cluster ground-truths it.

## The transferable lesson

&ldquo;Compare a date column to a datetime literal&rdquo; has no portable meaning: one engine changes the literal, two change the column, and the two that agree on direction disagree on rounding. If your system evaluates a user's predicate anywhere other than the source engine itself &mdash; a client-side filter, a verifier, a mirror of a server-stored predicate &mdash; the only correct implementations are the source's own rule, reproduced exactly and proven against the real server, or a loud refusal. There is no engine-neutral temporal comparison to fall back on, and hand-picked boundary values won't tell you when you've drifted &mdash; use the engine's implementation, not your model of it, and let a server-as-oracle matrix keep it honest.

## Primary sources

- sluice v0.99.291 (the source-faithful normalization + the no-lens refusal), ir.TemporalLiteralSemantics (internal/ir/temporal_literal.go &mdash; the three observed rules, documented with the per-engine boundary values), and the three-engine real-server matrix in internal/rowpredicate (server-as-oracle, RED-before-GREEN on live PG, incl. the typmod/fsp read-back pins).

- The publication-DDL half: observed on PG 16.14 (CREATE PUBLICATION &hellip; WHERE (d < '2024-01-01 12:00') accepted, stored prqual (d < '2024-01-01'::date)); v0.99.290 first excluded these shapes from sluice's push-down envelope, v0.99.291's normalization re-admitted them.

- PostgreSQL documentation &mdash; date/time input interpretation and CREATE PUBLICATION &hellip; WHERE; MySQL 8.0 and MariaDB documentation &mdash; date/datetime comparison and fractional-second handling.

- Related field notes &mdash; Postgres rounds your fractional seconds through a C double (this arc's sharpest sub-plot), the predicate you evaluate twice, and you can't reimplement MySQL's =.

---
Canonical page: https://sluicesync.com/field-notes/one-literal-three-verdicts/ · Full docs index: https://sluicesync.com/llms.txt
