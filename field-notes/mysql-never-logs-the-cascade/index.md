# MySQL never binlogs the cascade

> Delete a parent row with ON DELETE CASCADE children and MySQL's binlog carries exactly one event: the parent's. The cascaded child changes are never logged — MySQL's replication design makes re-running the cascade the replica's job, through its own FK definitions. But virtually every heterogeneous replication tool disables FK enforcement on apply, precisely to be free of row-ordering constraints — which switches off exactly the mechanism MySQL delegated the cascade to. Postgres answers the same design question the opposite way: it WAL-logs cascaded DML, so the child changes stream as ordinary messages.

Observed &mdash; the 2026-08-26 capture-completeness sweep, on a real mysql:8.0.46 wire: a parent-key DELETE/UPDATE produced parent-table row events only, in all three referential-action shapes tested (ON DELETE CASCADE, ON DELETE SET NULL, ON UPDATE CASCADE) &mdash; the child table absent from the binlog in every case. The contrast cell ran on real Postgres: pgoutput decoded the same parent DELETE as two messages, parent plus cascaded child. A census WARN shipped in sluice v0.132.0 on both MySQL lanes (binlog and VStream). The WARN is a detector, not a fix: the capture gap is MySQL's documented replication design, wire-level and permanent.

## The cascade is the replica's job

When an InnoDB foreign key carries a referential action and a parent-key DELETE or UPDATE fires it, the engine changes the child rows &mdash; but those changes are performed below the binlog layer, and MySQL deliberately does not log them. The binlog carries the parent event alone; the documented expectation is that the replica holds the same FK definitions and its own InnoDB re-runs the cascade locally when the parent event applies. Inside a homogeneous MySQL→MySQL replica set, that design is coherent and saves binlog volume: why ship rows the receiving engine will derive anyway?

The design only works while both of its halves hold: the target must have the FK definitions, and the target must actually enforce them at apply time.

## Your FK bypass is the other half of the bug

Here is the inversion: virtually every CDC applier and heterogeneous replication tool deliberately breaks the second half. Applying a change stream under full FK enforcement means every batch must be ordered parent-before-child and delete child-before-parent &mdash; a constraint that fights batching, retries, and concurrent apply. So appliers switch enforcement off: foreign_key_checks=0 on a MySQL target, session_replication_role=replica on a privileged Postgres target, the foreign_keys pragma off on SQLite and D1. sluice does all three (its Bug 164 fix &mdash; out-of-order apply was poison-pilling batches). Standard applier hygiene, in other words, is the disabling of the exact mechanism MySQL delegated the cascade to.

Net effect: the source cascades, the wire never says so, and the target &mdash; forbidden from cascading on its own &mdash; keeps the child rows. They silently survive a parent's delete, or hold stale foreign-key values after a parent-key update, at exit 0. Which target postures diverge is decided by privilege, not intent:

Target posture · FK enforcement during apply · Cascade outcome ·

MySQL / MariaDB · foreign_key_checks=0 · Diverges &mdash; child rows survive / go stale ·

Postgres, privileged applier · SET LOCAL session_replication_role = replica · Diverges &mdash; same silent survival ·

SQLite / Cloudflare D1 · foreign_keys pragma off · Diverges &mdash; same silent survival ·

Postgres, unprivileged applier · Stays ON &mdash; the role can't set replica mode · Converges &mdash; the translated FK carries the action and the target re-runs the cascade itself ·

The one converging posture converges by accident of privilege: the tool wanted the bypass, couldn't get it, and the denied permission preserved correctness. That is the same dev-versus-prod inversion as the trigger-capture note, from the other side of the wire: the better-credentialed deployment is the one that loses.

## Two engines, opposite answers

Postgres made the opposite design call. A cascaded DELETE or UPDATE is executed as real DML on the child table, WAL-logged like any other write, and logical decoding emits it as an ordinary change message &mdash; on the observed wire, one parent-key DELETE decoded as two D messages, parent then child. A consumer of pgoutput never faces this class at all: disabling FK enforcement on the target is correct there, because the stream itself carries the cascade. The identical applier hygiene is harmless downstream of Postgres and silently lossy downstream of MySQL &mdash; the hazard lives in the pairing, not in either engine alone.

## What a tool can honestly do about a permanent gap

Capture-side, nothing: the child changes never reach the wire, on either MySQL lane &mdash; Vitess's VStream re-serves the tablet's own binlog, where the cascaded rows are equally absent. Re-enabling target-side enforcement is not the remedy either; it re-opens the ordering failures the bypass exists to prevent. What sluice v0.132.0 ships is a detector: at every CDC open, on both lanes, a census of the in-scope tables' foreign keys logs a FK-REFERENTIAL-ACTION-CAPTURE-GAP warning naming each constraint whose referential action would cascade invisibly &mdash; scoped to the child table, since that is where the divergence lands, and silent for plain FKs and RESTRICT/NO ACTION, which block on the source rather than cascading. A probe error warns too, rather than silently skipping. Past the warning, sluice verify is the only independent catch, because it compares actual rows rather than trusting the stream.

## The transferable lesson

&ldquo;Whose job is the cascade?&rdquo; is a replication design decision, and the two major engines answered it in opposite directions: MySQL delegates it to the receiving side's FK definitions; Postgres materializes it into the log. Any tool that moves changes between engines inherits the mismatch &mdash; and the standard, correct-looking applier hygiene of disabling FK checks quietly assumes the Postgres answer. When you take a bypass on the target, enumerate what that mechanism was doing for you, not just what it was doing to you: on a MySQL-family source, FK enforcement wasn't only validation &mdash; it was the delivery mechanism for half the write stream.

## Primary sources

- MySQL reference &mdash; InnoDB and MySQL Replication &mdash; cascading FK actions are performed by the storage engine and not written to the binary log; replicas need the same FK definitions to reproduce them.

- PostgreSQL documentation &mdash; logical decoding &mdash; the contrast side: cascaded DML is ordinary WAL-logged DML and decodes as ordinary change messages.

- sluice v0.132.0 changelog &mdash; the FK-REFERENTIAL-ACTION-CAPTURE-GAP census on both MySQL lanes, the per-target divergence analysis, and why target-side enforcement stays off (Bug 164).

- Related field notes: Your trigger-based CDC can't see replicated writes &mdash; the same session_replication_role bypass seen from the capture side; You can't filter a parent table without orphaning its children &mdash; another case of FKs coupling what looks like a per-table decision.

---
Canonical page: https://sluicesync.com/field-notes/mysql-never-logs-the-cascade/ · Full docs index: https://sluicesync.com/llms.txt
