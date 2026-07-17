# The heartbeat aged seven hours at write time

> A concurrent-run guard refuses to start a second backfill walk while the state row's heartbeat is fresher than five minutes. The heartbeat was a bare timestamp written with CURRENT_TIMESTAMP — which Postgres renders in the server's timezone before storing — while the reading driver scans a bare timestamp back as UTC. Two individually defensible behaviors compose into an age reading wrong by exactly the server's UTC offset, and the sign of that offset picks your failure mode. It shipped because every CI container runs UTC, where the bug is arithmetically invisible.

Observed — a 2026-07-16 audit of sluice's backfill concurrent-run guard, differential-verified live in the fix (v0.99.263): pre-fix, a heartbeat read +7h old on America/Los_Angeles and -2h old on Europe/Berlin. The affected guard shipped in v0.99.260, so the live-bug window was v0.99.260–262 on non-UTC PostgreSQL servers. The MySQL side was already correct (the connection forces its session time_zone).

## Two defensible behaviors, composed

The guard is textbook: don't start a second backfill walk while the state row's heartbeat is newer than five minutes, so a live walk isn't joined by a duplicate. The heartbeat column was a bare timestamp (no time zone), written with CURRENT_TIMESTAMP. Each half is reasonable on its own:

- PostgreSQL's CURRENT_TIMESTAMP is a timestamptz; assigning it into a bare timestamp column converts it to the server's TimeZone and drops the offset. So the stored wall-clock digits are in the server's local zone.

- The reading driver (pgx) scans a bare timestamp back as a time.Time in UTC — it has no zone to attach, so it labels the naive value UTC.

Compose them and the age computation — time.Now() minus the scanned heartbeat — is wrong by exactly the server's UTC offset, because the value was written in one frame and read in another. Nothing in the code path is individually incorrect; the bug lives in the seam between the write's zone and the read's assumption.

## The sign of the offset picks your failure

Which way it breaks depends on which side of UTC the server sits:

- Server behind UTC (e.g. America/Los_Angeles, -7h): a heartbeat written one second ago reads seven hours old. The guard believes the previous walk is long dead, so a second walk starts and the two interleave — the exact hazard the guard exists to prevent. Silent: no error, just a guard that has quietly stopped guarding.

- Server ahead of UTC (e.g. Europe/Berlin, +2h): a crashed run's genuinely-stale heartbeat reads two hours in the future, i.e. perpetually fresh, so a legitimate resume is falsely refused until the offset drains.

Both were reproduced live in the fix — +7h of phantom age on Los Angeles, -2h on Berlin.

## Why it shipped

Every CI container runs in UTC, where the server offset is zero and the two zone assumptions cancel exactly. A naive-timestamp freshness bug is arithmetically invisible under UTC and arms itself the moment someone's managed instance defaults to a regional zone — which many do. A test suite that never leaves UTC cannot see it; a single non-UTC container in the matrix would have.

## What sluice does about it

The fix is one expression: write the heartbeat as timezone('utc', now()) so the stored naive value is UTC, matching what pgx assumes on read (storing a timestamptz outright works too). The codebase had already solved the identical class once — the shard-consolidation control table compares its lease against timezone('utc', now()) — which is the tell that this is a recurring class, not a one-off: freshness math breaks wherever a client clock meets a server-written naive timestamp.

## The transferable lesson

Never compare time.Now() against a bare TIMESTAMP the server filled in with its own local-zone function. A timestamp without a time zone is a value whose meaning depends on who reads it, and a freshness computation puts the writer and the reader on opposite sides of that ambiguity. Either store an explicit timestamptz, or write the naive column through timezone('utc', now()) and read it as UTC — and put at least one non-UTC server in your test matrix, because the whole failure class is invisible at offset zero.

## Primary sources

- PostgreSQL documentation — date/time functions (CURRENT_TIMESTAMP is timestamptz; conversion into timestamp without time zone uses the session TimeZone) and the timezone() AT TIME ZONE construct.

- pgx documentation — scanning a timestamp without time zone yields a UTC time.Time.

- sluice v0.99.263 changelog (M1.3) and the 2026-07-16 audit finding — the live +7h/-2h differential and the timezone('utc', now()) fix, plus the pre-existing control-table sibling.

---
Canonical page: https://sluicesync.com/field-notes/heartbeat-aged-seven-hours/ · Full docs index: https://sluicesync.com/llms.txt
