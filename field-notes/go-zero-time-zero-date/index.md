# Go's zero time.Time is a live wire against MySQL

> In Go, var t time.Time is the real instant 0001-01-01 00:00:00 UTC — and Postgres happily stores year-1 dates, which decode to exactly that value. go-sql-driver/mysql serializes any IsZero() instant as MySQL's invalid '0000-00-00' sentinel, so a legitimate year-1 date either false-refuses under strict sql_mode — with an error naming a value the source never held — or is silently stored wrong under a relaxed one. The fix is to take the encoding away from the driver.

Observed &mdash; sluice's adversarial value-fidelity corpus (2026-08-22), which pushes each type family's worst-case value through migrate, CDC and backup in both directions: a Postgres DATE/timestamp of '0001-01-01' was mangled on write to MySQL. Fixed v0.131.1, ground-truthed on mysql:8.0 under full-strict sql_mode.

## A valid date that equals the zero value

Go's time.Time zero value is 0001-01-01 00:00:00 UTC &mdash; a real, representable instant, and also what var t time.Time gives you. Postgres stores year-1 dates without complaint (its date range starts at 4713 BC), so a Postgres DATE of '0001-01-01' decodes in a Go program to exactly time.Time{}, indistinguishable from &ldquo;never set.&rdquo; go-sql-driver/mysql resolves that ambiguity in the worst direction: when it binds a time.Time whose IsZero() is true, it serializes MySQL's invalid zero-date sentinel '0000-00-00' &mdash; on both the text and binary protocols. A legitimate value from one engine becomes an invalid value at the other engine's wire, and the value the driver sends is one the source never held.

## Loud or silent, depending on sql_mode

Under a strict sql_mode &mdash; sluice forces one on its writer sessions &mdash; MySQL rejects the sentinel with Error 1292: a false refusal whose message names '0000-00-00', sending the operator hunting for a zero-date that exists nowhere in the source. Under a relaxed sql_mode MySQL accepts it, and the wrong date is stored silently. Two failure modes, one root: a valid domain value collided with a library's in-band sentinel for &ldquo;no value.&rdquo;

## What sluice does about it

Take the encoding away from the driver: the value-bind seam now encodes Go's zero instant as its explicit string literal &mdash; '0001-01-01' into DATE columns, '0001-01-01 00:00:00' otherwise &mdash; so the driver never sees an IsZero() time.Time to rewrite, and MySQL stores the literal faithfully. It's the same string-encoding dodge sluice already uses for negative-zero floats, another value a library round-trips lossily. Three scope caveats, stated plainly: genuine MySQL '0000-00-00' zero-dates are untouched &mdash; they keep flowing through the existing --zero-date policy, this fix is only about a real year-1 date being turned into the sentinel. The &ldquo;stores faithfully&rdquo; claim is DATE/DATETIME only &mdash; a MySQL TIMESTAMP column still refuses '0001-01-01' loudly, since its floor is 1970-01-01 00:00:01, but the refusal now names the true value instead of the sentinel, the honest outcome for a value the type genuinely cannot hold. And the fix sits at the one seam every MySQL write lane funnels through &mdash; batched INSERT, CDC apply, LOAD DATA &mdash; so no lane keeps the old behavior.

## The transferable lesson

time.Time's zero value is not neutral: it is a specific date a well-behaved source can legitimately produce, and at least one very widely used driver treats it as a magic sentinel on the way out. If you bind time.Time toward MySQL, decide what happens to 0001-01-01 before the driver decides for you &mdash; and treat any library that overloads a legal domain value as &ldquo;unset&rdquo; as a value-corruption hazard, not a convenience.

## Primary sources

- go-sql-driver/mysql &mdash; the zero-time.Time → '0000-00-00' serialization.

- MySQL reference &mdash; DATE, DATETIME, TIMESTAMP &mdash; TIMESTAMP's 1970-01-01 00:00:01 floor; strict sql_mode and zero dates.

- PostgreSQL reference &mdash; date/time types &mdash; the date range that makes year-1 a first-class value.

- sluice v0.131.1 changelog &mdash; the string-literal encoding and the corpus cells that pin it.

- Related field notes: parseTime governs the query protocol, not the binlog &mdash; the same driver's temporal handling differing by path; MySQL TIME is a duration, not a time of day.

---
Canonical page: https://sluicesync.com/field-notes/go-zero-time-zero-date/ · Full docs index: https://sluicesync.com/llms.txt
