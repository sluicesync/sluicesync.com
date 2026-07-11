# A CDC position isn't a universal coordinate

> A change-stream gives you a position token to resume from and to reason about order — but engines disagree, non-obviously, on whether that token sits before or after the rows it names. Postgres and MySQL put a schema/DDL position ahead of the rows it introduces; Vitess stamps its commit token after them. Any “did we reach the boundary?” check written against one engine silently false-negatives on the other.

Observed — hardening logical-backup restore against a manifest-tamper silent-loss. The completeness guard asked “was this incremental's data fully applied?” by testing whether a schema-history snapshot was anchored exactly at the window's end position — sound on Postgres and MySQL-binlog, a false negative on Vitess/PlanetScale.

## What happened

A backup incremental records an end_position — the change-stream coordinate its replay must reach — and a list of change chunks carrying the row events. To catch a store-level adversary who deletes the chunks (an unsigned backup), restore asserts the replay actually reaches end_position: either the last replayed change lands exactly there, or a schema-history snapshot is anchored exactly there. That second clause exists for a legitimate DDL-only window (a schema change, no row writes) — such a window advances end_position to the schema snapshot's own position, so a snapshot sitting at the boundary means “nothing was dropped, this window was always schema-only.”

On Postgres and MySQL that reasoning holds. On Vitess it is a silent false negative: an emptied data window — chunks deleted, rows lost — whose final transaction happened to first-touch a table leaves that table's routine schema snapshot sitting exactly at end_position, so the guard reads “boundary reached” and waves the data loss through.

## Why (the mechanism)

The three engines stamp their positions on different sides of the same rows:

- Postgres logical replication — a RelationMessage (the schema/relation descriptor) carries its own WAL position, and that WALStart strictly precedes the LSNs of the rows it introduces. The schema anchor leads the rows.

- MySQL binlog — a DDL Query event's log position precedes the row events that follow it. Again the schema/DDL position leads the rows.

- Vitess / PlanetScale VStream — the resumable coordinate is the VGTID, and VStream emits it per transaction commit, after the rows the commit covers. The token trails its rows. So a table's first-touch schema snapshot and the row changes in the same transaction are handed to you carrying one and the same position.

Because Postgres and MySQL put the schema anchor before the rows, a routine data-window snapshot is always anchored below the window's last row — so a snapshot found at the end position can only be a genuine DDL-only window, and the heuristic is exact. On Vitess the snapshot and the rows share a position, so “snapshot at the end position” no longer distinguishes “schema-only window” from “data window whose rows were deleted.” Same code, same manifest shape — a different answer purely because the engine writes the coordinate on the other side of the rows.

## What sluice does about it

sluice records the source engine's ordering as a capability, CDCPositionCommitsAfterRows (declared for the VStream flavors), and stamps it on every incremental manifest at backup time. When restore or the live broker sees it set, it refuses to treat a schema anchor at the boundary as proof of applied data — on those engines only an actually-replayed change-chunk tail counts, so an emptied-data window is refused loudly instead of restored short. Postgres and MySQL-binlog, whose anchor strictly precedes its rows, keep trusting the anchor, so a legitimate schema-only window still restores. The trust decision is gated on a declared property of the engine, not hard-coded per engine name.

## The transferable lesson

A CDC position is not a universal coordinate. Whether the commit/GTID/LSN token an engine hands you sits before or after the rows it's associated with is an engine-specific property of the wire protocol — Postgres and MySQL lead with the schema position, Vitess trails with the commit token — and any “did we reach the boundary?” or event-ordering assumption you write against one engine is silently unsound the moment you point it at another. If a completeness or ordering check compares a position to “where the rows are,” it has to know which side of the rows that engine stamps the position on; anything else passes its tests on the engine you wrote it against and false-negatives on the one you didn't.

## Primary sources

- Postgres logical replication protocol — the Relation message and its position, ahead of the row messages it describes.

- Vitess VStream / VGTID — the VStream API delivers a VGTID at each transaction boundary, after the row events it covers.

- How sluice replays a backup chain and its recorded positions — Sync from a backup chain.

---
Canonical page: https://sluicesync.com/field-notes/cdc-position-leads-or-trails/ · Full docs index: https://sluicesync.com/llms.txt
