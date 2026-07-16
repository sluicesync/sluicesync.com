# CSV has no NULL — and in a one-column file, the "blank line" you skip was a NULL row

> RFC 4180 defines quoting, delimiters, and line endings, and says nothing about NULL. NULL-vs-empty is pure producer convention riding on the quoted/unquoted distinction — which Go's encoding/csv collapses. And at exactly one column wide, the universal skip-blank-lines convention is byte-indistinguishable from a legitimate record whose only field is empty.

Observed — building sluice's CSV/TSV source drivers (ADR-0163, v0.99.250). The one-column silent row drop was caught by the pre-land value-fidelity review and was never in any published version — a caught-before-ship story, which is part of the point.

## What happened

CSV's spec has a hole where NULL should be. RFC 4180 never mentions it, so every producer invents a convention, and the most important one — Postgres COPY &hellip; CSV — encodes the distinction in quoting: NULL is written as an unquoted empty field, empty string as "". Which means the quoted/unquoted distinction is load-bearing data.

Go's encoding/csv, like many standard-library parsers, erases it: a,,b and a,"",b come back as the same record. A reader built on it literally cannot implement the COPY convention, no matter how careful the code above it is. That alone forced sluice's flat-file driver to carry its own strict RFC 4180 lexer.

The sharper edge showed up in review. sluice's contract is that NULL representation must be declared, never sniffed: --csv-null='' adopts the COPY convention, --csv-null='\N' declares that literal, and with no declaration an unquoted empty field refuses loudly rather than guessing. The pre-land review asked what happens in a one-column file — and found that the near-universal skip-blank-lines convention (which encoding/csv also bakes in) fired first. In a one-column CSV, a legitimate record whose single field is empty is a blank line, byte for byte. The skip consumed it before any NULL logic ran: under --csv-null='' a NULL row was silently dropped, and with no declaration the promised ambiguity refusal was silently bypassed. Exit 0, one row short per NULL.

## Why (the mechanism)

Three facts stack:

- The format has no NULL, so NULL semantics live in producer convention — and the dominant convention hangs on quoting.

- A widely used parser layer collapses the quoting distinction, so the convention is unimplementable on top of it.

- &ldquo;Skip blank lines&rdquo; is safe at every record width except one. At width &ge; 2 a blank line can't be a record (it would be ragged). At width 1, an empty line is exactly a one-empty-field record, and skipping it is a silent row drop.

The fix keys blank-line handling on the established record width: at width 1, an empty line is a record and flows through the declared NULL contract like any other field (a blank line before the first record, when width is not yet established, is still skipped). Everything else in the contract stays strict: a quoted field is always data ("NULL" is a four-character string), the representation must be declared by the operator, and an undeclared ambiguity is a coded refusal naming the record and column.

## Where the class generalizes

The same bare-token-versus-quoted-string line shows up wherever a text format smuggles typing through quoting: in SQL dumps, NULL the keyword is SQL NULL while 'NULL' is a string, and sluice's dump reader draws exactly the same line. Any layer that normalizes the two spellings — a parser, a pretty-printer, a well-meaning cleanup script — destroys the only bit that distinguishes absence from empty.

## Reproducing it

The whole class fits in a five-byte-wide file. Save this as one.csv — a one-column file: header, a row, a blank line, a row (under the COPY convention that blank line is a NULL row, not filler):

    a
    1

    2

Then run the flag matrix against sluice &ge; v0.99.250 (any target):

    sluice migrate --source-driver csv --source ./one.csv --csv-header --csv-null='' ...
    # 3 rows land: '1', NULL, '2'  — the blank line is a record

    sluice migrate --source-driver csv --source ./one.csv --csv-header ...
    # refused: SLUICE-E-CSV-NULL-AMBIGUOUS naming the record — no declaration, no guess

    sluice migrate --source-driver csv --source ./one.csv --csv-header --csv-null='\N' ...
    # 3 rows land: '1', '' (empty string), '2' — declared repr resolves the ambiguity

A reader built on Go's encoding/csv cannot pass the first case: it both collapses a,"",b into a,,b at width > 1 and skips the blank line here before any NULL logic runs — the row silently vanishes.

## The transferable lesson

Two lessons, one per half. First: when a format leaves a semantic undefined, make the operator declare it — sniffing NULL conventions from data is guessing with confidence, and the honest posture for an undeclared ambiguity is a loud refusal. Second: every &ldquo;obviously skippable&rdquo; input shape deserves the question at what record width does this stop being skippable? Degenerate widths — one column, zero rows, a single field — are where whitespace conventions and record semantics collide, and the collision is silent precisely because both interpretations are byte-identical.

## Primary sources

- RFC 4180 — Common Format and MIME Type for CSV Files (note the absence: no NULL representation).

- PostgreSQL documentation — COPY &hellip; CSV: NULL as unquoted empty by default, quoted empty as empty string.

- Go encoding/csv — quoted and unquoted fields are returned identically; blank lines are skipped.

- sluice ADR-0163 — the flat-file CSV/TSV/NDJSON source drivers; the declared-never-sniffed NULL contract and the width-1 finding.

---
Canonical page: https://sluicesync.com/field-notes/csv-has-no-null/ · Full docs index: https://sluicesync.com/llms.txt
