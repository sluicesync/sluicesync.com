# A long-open transaction anywhere freezes your trigger-CDC

> Gap-free trigger-CDC on Postgres emits only provably-settled rows: txid below the current snapshot's xmin. Any open write transaction anywhere on the server — any table, captured or not — pins that xmin and prefix-cuts the entire poll window: zero rows, healthy-idle logs, replication lag growing without bound. It resumes the moment the transaction ends and loses nothing; until v0.131.3, nothing said it was happening.

Observed &mdash; sluice's postgres-trigger gap-free reader, the fallback for managed Postgres that won't grant a logical-replication slot. The v0.131.3 change is observability only &mdash; a paced WARN naming the pinned xmin and where to look. Over-holding was always safe: a stall, never a loss.

## The ordering problem the ceiling solves

Trigger-based CDC polls a change-log table, and the poll has a genuinely hard ordering problem: a change-log row's id is allocated when the trigger fires, but its txid at the transaction's first write &mdash; so id order is not commit order, and a naive WHERE id > last can step permanently over a row whose transaction simply hasn't committed yet. sluice's gap-free reader closes that hole with a settled ceiling: emit only rows whose txid is below the current snapshot's xmin &mdash; pg_snapshot_xmin(pg_current_snapshot()) &mdash; rows no in-flight transaction could still be writing behind. Provably settled, never a gap.

## What pins the ceiling

The trap is what holds that xmin down: any open write transaction anywhere on the server. Any table, captured or not &mdash; it only needs an assigned xid. A forgotten idle in transaction session, a long analytics job that took one write lock, a stuck migration: the snapshot's xmin stays at that transaction's xid, every change written after it sits at-or-above the ceiling, and the poll window is prefix-cut to nothing. The poll returns zero rows, the pump takes its no-work path, and the stream logs healthy-idle while replication lag climbs without bound &mdash; from the consumer's side, a pinned-xmin stall is byte-identical to a source where nothing is changing. The moment the pinning transaction commits or rolls back, everything held flows through: a stall, never a loss. But &ldquo;zero rows, no error&rdquo; is not the same claim as &ldquo;nothing changed,&rdquo; and until v0.131.3 nothing distinguished them.

## The fix is a sentence, not a behavior change

sluice now runs a paced probe when the stream looks idle &mdash; built on the same not-settled predicate as the ceiling, shared as one constant so the two cannot drift &mdash; counting rows that are committed but held. When it finds them, it WARNs with the held-row count, the first held id, the pinned snapshot xmin, and the query that finds the session to go settle:

    SELECT pid, state, xact_start, query
    FROM pg_stat_activity
    WHERE xact_start IS NOT NULL
    ORDER BY xact_start;

No correctness change anywhere &mdash; the honest fix for a safe-but-invisible state is to make it visible.

## The transferable lesson

Postgres DBAs know the xmin-horizon cliff as vacuum bloat and replication-slot lag; a poll-based CDC ceiling is the same cliff's third face, one layer up. Any consumer that holds rows back behind a snapshot bound inherits it: the predicate that guarantees you never emit an unsettled row is the predicate a single idle transaction can pin at zero progress. And this exact predicate has already failed in the opposite direction &mdash; the xid-wraparound note is the same hold-back comparing a 32-bit xid against a 64-bit bound, going permanently wrong past 232 lifetime transactions and silently skipping an in-flight transaction's rows. One line of SQL, both failure modes: under-hold and you lose rows silently; over-hold and you stall silently. So instrument the distance between the ceiling and the newest committed change &mdash; zero rows is an answer with two meanings, and only a probe can tell them apart.

## Primary sources

- PostgreSQL reference &mdash; system information functions &mdash; pg_current_snapshot() / pg_snapshot_xmin(): the snapshot's xmin is the oldest transaction id still in flight.

- PostgreSQL reference &mdash; routine vacuuming &mdash; the xmin horizon's better-known faces: bloat held by long-running transactions.

- sluice v0.131.3 changelog &mdash; the ceiling-stall WARN (held_rows, first held id, pinned xmin, the pg_stat_activity hint).

- Related field notes: Comparing 32-bit transaction ids breaks after four billion of them &mdash; the same predicate failing the opposite way; Your trigger-based CDC can't see replicated writes &mdash; another structural blind spot of the trigger lane.

---
Canonical page: https://sluicesync.com/field-notes/long-open-tx-freezes-trigger-cdc/ · Full docs index: https://sluicesync.com/llms.txt
