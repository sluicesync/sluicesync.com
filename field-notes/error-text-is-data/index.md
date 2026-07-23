# Error text is data, error codes are contract

> A retry classifier that text-scans the whole error string for transient wording (reparent, not serving, connection refused, disk full…) can be flipped by the data: server error messages routinely echo row values, key values, and table names. The worst observed chain: a duplicate-key failure on a table named reparent_history classified RETRIABLE, the byte-identical retry hit 1062 again, and a tolerate-on-retry path whose safety proof assumed a first-attempt 1062 stays terminal swallowed the whole batch — silently absent while the migration reported success.

Observed &mdash; the 2026-07-23 blind audit of sluice's apply-path error classifiers, over-match confirmed by throwaway tests on both engines. The MySQL silent-skip chain affected sluice v0.99.92&ndash;v0.99.289; the text-fallback legs date to the v0.42.0 classifier. Fixed in v0.99.290. The servers behave correctly throughout &mdash; this defect class is entirely client-side classification.

## The chain: a table name flips a rollback into a success

Retry classifiers accumulate text patterns for good reasons. A Vitess reparent surfaces as prose; a managed-MySQL failover says &ldquo;not serving&rdquo;; drivers flatten dial failures into bare strings (the reconnect blind spot). So the classifier ends with a fallback leg that scans the error text for transient wording. The problem: a database error message is partly composed of your data. MySQL's duplicate-key error quotes the colliding key value and, through any wrapping layer that names its context, the table. Now walk the observed worst case:

    INSERT batch -> Error 1062 (duplicate key) on table reparent_history
       text scan finds "reparent"            -> classified RETRIABLE
    retry the byte-identical batch -> 1062 again
       tolerate-1062-on-retry: "the prior attempt committed but lost its
       ack -- the rows already landed"       -> batch treated as done
    reality: BOTH attempts rolled back      -> entire batch absent, exit 0

Each link is individually reasonable. The text fallback exists for real reparents. The tolerate-on-retry wart is a genuinely sound idempotence argument &mdash; if a first-attempt 1062 always stays terminal, then a 1062 on the retry of a byte-identical batch proves the rows are durable. The mis-classification broke that premise from underneath: the first 1062 became a &ldquo;retry,&rdquo; the second became &ldquo;proof of durability,&rdquo; and a whole batch vanished behind a green migration. A table named reparent_history, a value like planned-reparent-2026-07, a key echoing connection refused from a log-line column &mdash; user-controlled data, choosing your retry semantics.

## The Postgres sibling, bounded by accident

Postgres contained the blast radius &mdash; not by design of anyone's classifier, but because PgError messages don't echo row data. What remained: a RAISEd trigger error (SQLSTATE P0001) quoting stored text like &ldquo;connection timed out&rdquo; classified retriable, burning the full bounded retry budget on a deterministic failure before failing loudly late. Annoying rather than lossy &mdash; but the same class, and &ldquo;the message can't carry data&rdquo; is a property you got, not one you chose. Any RAISE, any proc that interpolates a value, re-opens it.

## The shield: a structured error means the code decides alone

The fix is not better patterns &mdash; it's a precedence rule. When the error chain carries a structured driver error (*mysql.MySQLError, *pgconn.PgError &mdash; an errno or SQLSTATE the server authored), the server responded, and the code classifies alone: the text legs never run. Free-text scanning is reserved for errors that genuinely have no structure &mdash; transport failures the driver flattened to prose. The few legitimate code+message conjunctions survive as explicit AND-gates (Vitess tunnels reparent states through errno 1105, so 1105 plus vttablet framing stays retriable; similarly 1290 + read-only wording, and PG XX000 + read-only), which is the opposite shape of the bug: a gate narrows a code's verdict with its message; the defect was letting a message widen one. The pin is a cross-product matrix &mdash; every structurally-terminal code &times; every transient substring in the text legs must classify non-retriable, and every previously-pinned transient shape must stay retriable &mdash; so the next pattern added for a real transient can't silently re-open the class.

And that last clause is the quiet irony: every wording added over the releases for a legitimate transient &mdash; reparent for real Vitess failovers, then the Bug 199/200 dial vocabulary (connectex, &ldquo;actively refused&rdquo;) &mdash; had been silently widening the surface a data value could match. Each individually correct fix made the over-match more likely, because the patterns and the shield weren't separated by layer.

## The transferable lesson

Applies to any retry layer over any database, and more broadly to anything that branches on rendered error strings: error text is data &mdash; partially user-controlled, echoing values and identifiers &mdash; and only error codes are contract. Structure the classifier in layers: structured code present &rArr; code decides alone; text heuristics only for unstructured transport errors; explicit, documented AND-gates for the rare code-plus-framing cases. Then pin the cross-product, because the failure mode isn't the classifier you write today &mdash; it's the eleventh pattern someone adds three releases from now. gocloud classifying &ldquo;301&rdquo; by substring is this same class one layer down: a status code fished out of a string that also carries random hex request IDs.

## Primary sources

- sluice v0.99.290 (the terminal-code shield in both engines' applier classifiers, internal/engines/mysql/applier_errors.go / internal/engines/postgres/applier_errors.go, with the cross-product pin matrix and the preserved AND-gates); the ADR-0108 tolerate-1062-on-retry wart and its restored safety premise (row_writer.go).

- The 2026-07-23 audit's observed cells: 1062 + a reparent-bearing value → retriable, 1062 on key reparent_history.PRIMARY → retriable, 1062 + &ldquo;connection refused&rdquo; in the echoed value → retriable; PG P0001 quoting &ldquo;connection timed out&rdquo; → retriable &mdash; all pre-fix, all now pinned terminal.

- MySQL error 1062 message format (echoes the colliding key value); PostgreSQL RAISE / SQLSTATE P0001.

- Related field notes &mdash; gocloud classifies &ldquo;301&rdquo; by substring and your retry loop's blind spot is its own reconnect (why the text legs exist at all).

---
Canonical page: https://sluicesync.com/field-notes/error-text-is-data/ · Full docs index: https://sluicesync.com/llms.txt
