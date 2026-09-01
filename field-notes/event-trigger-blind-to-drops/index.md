# Your event trigger fires for the DROP and sees zero rows

> An event trigger on ddl_command_end fires for a DROP, and the loop body never executes: pg_event_trigger_ddl_commands() returns zero rows for object removal, because dropped-object information is reachable only from the sql_drop event through a different context function. So a WHEN TAG list naming DROP TABLE reads as coverage while being incapable of producing a row — the trigger fires, records nothing, and a dropped table streams on at exit 0.

Observed &mdash; sluice's own ADR-0066 asserted this coverage and shipped it wrong: through v0.134.x the DDL-capture arm's WHEN TAG list named DROP TABLE and DROP INDEX, and the ADR text claimed both paths refused. They could not. Found by the 2026-08-31 audit (finding D-1), corrected in the ADR and given a dedicated sql_drop capture arm in sluice v0.136.0 (fix commit 28edd160). Every row count below was re-measured for this note on stock PostgreSQL 16.14 and 17.11.

## Two events, two context functions, no overlap

PostgreSQL's event-trigger surface looks like one mechanism with a couple of entry points. It isn't. An event trigger on ddl_command_end fires after a DDL statement completes, and its function reads what happened through pg_event_trigger_ddl_commands(). An event trigger on sql_drop fires for statements that removed objects, and its function reads pg_event_trigger_dropped_objects(). These are not two views onto one payload &mdash; they are two separate collections, populated for two separate events, and object removal is reported to the second one only.

So the sentence that matters: an event trigger on ddl_command_end does fire for a DROP. The function is entered. And FOR r IN SELECT &hellip; FROM pg_event_trigger_ddl_commands() LOOP iterates zero times. No error, no warning, no log line. Measured on both versions, counting the rows the context function returned per statement:

    ALTER TABLE t ADD COLUMN c int   ->  1 row
    CREATE INDEX t_a_idx ON t(a)     ->  1 row
    CREATE TABLE t (a int, b text)   ->  1 row   (2 when the table has a PRIMARY KEY:
                                                  the table, plus its implicit index)
    DROP INDEX t_a_idx               ->  0 rows
    DROP TABLE t                     ->  0 rows

## The tag filter that reads as coverage

The sharp part is what an inspection sees. Write WHEN TAG IN ('ALTER TABLE', 'CREATE TABLE', 'DROP TABLE') and PostgreSQL honors it exactly: the trigger really does fire for a DROP TABLE. Every artifact you would check to answer &ldquo;do we capture drops?&rdquo; says yes. The event trigger exists. Its tag list names the command. The function is bound to it. The statement fires it. The single thing that does not happen is the recording &mdash; and it is the only thing that isn't written down anywhere.

For anyone building change capture on event triggers, the consequence is the quiet kind. A synced table is dropped on the source; the capture log gets nothing; the stream keeps running and reporting healthy; the target holds that table's last-synced rows forever, and no door anywhere refuses. Exit 0. The tag list is not a lie about what fires &mdash; it is a claim about what is captured that the tag list has no authority to make.

## The asymmetry, and which half is the quiet one

The two context functions are not interchangeable, and the direction that bites is the one that doesn't complain. Call pg_event_trigger_dropped_objects() from a ddl_command_end function and PostgreSQL raises immediately:

    ERROR:  pg_event_trigger_dropped_objects() can only be called in a
            sql_drop event trigger function

Call pg_event_trigger_ddl_commands() from a sql_drop function and it does not raise. It returns zero rows, cleanly, on both 16.14 and 17.11. So the mistake that costs five seconds is asking for dropped objects in the wrong place; the mistake that ships is asking for commands in a context that has none &mdash; which is the same shape as the original defect, one event over. Moving the arm to sql_drop without also changing the context function you call would have produced an identically silent zero.

## Filter on the objects, not on the tag

Once you are on sql_drop, the obvious next move is to re-create the tag list there &mdash; fire only for DROP TABLE. sluice's fix deliberately leaves that arm unfiltered and puts the predicate on the dropped-object set instead: it records a drop when the cascade also carried that table's own capture trigger &mdash; i.e. a table this install was demonstrably capturing, derived from the install's own artifacts rather than from a table roster.

That distinction is the design detail worth borrowing, because a captured table can die by a statement whose tag is not DROP TABLE. Measured on 17.11, one DROP SCHEMA s1 CASCADE over a schema holding one table reports four rows to pg_event_trigger_dropped_objects() &mdash; the schema, the table, and the table's two implicit composite/array types &mdash; and its command tag is DROP SCHEMA. DROP OWNED BY is the same shape. A tag list on the new arm would have re-created the blind spot exactly one level down, and it would have looked like coverage again. One residual is stated rather than implied: DROP INDEX is still not captured, because there is no table row in its dropped set &mdash; deliberate, since index DDL is never forwarded over the change stream and refusing on it would halt a sync for nothing.

## The transferable lesson

A trigger's filter constrains when the function runs; it says nothing about what the function can see once it does. Those are two different questions answered by two different parts of PostgreSQL, and nothing stops you writing a tag your context function can never report on &mdash; the system will accept the statement, fire the trigger, and return an empty set. So the check that establishes DDL capture is not &ldquo;is the tag in the list?&rdquo; but &ldquo;run the DDL and count the rows the context function returned.&rdquo; It is one query, and it is the only thing that separates fires and records from fires and records nothing.

The second half is about how long this survived. The wrong claim lived in a design document for many releases, in the form &ldquo;both code paths refuse&rdquo; &mdash; true-sounding, never executed. An invariant nobody checks is indistinguishable from one that holds. The correction ships the measurement as a test that re-runs on every integration pass and, before asserting the fix, disables the new arm to reconstruct the old install &mdash; so its first assertion is the shipped defect, reproduced, rather than a claim about it.

## Primary sources

- PostgreSQL documentation &mdash; Event Trigger Firing Matrix, the event-trigger information functions &mdash; pg_event_trigger_ddl_commands() is defined for ddl_command_end; pg_event_trigger_dropped_objects() for sql_drop.

- Measured for this note on stock postgres:16 (16.14) and postgres:17 (17.11) containers &mdash; the per-tag row counts, the one-directional raise, and the DROP SCHEMA &hellip; CASCADE dropped-object set.

- sluice ADR-0066 (docs/adr/adr-0066-postgres-trigger-engine-variant.md) &mdash; carries the correction in place, including the reconstructed-defect premise pin; the fix landed in v0.136.0 as commit 28edd160.

- Related field note: An ALTER with no rows behind it is invisible to Postgres CDC &mdash; the other way a DDL leaves no trace for a change stream to find.

---
Canonical page: https://sluicesync.com/field-notes/event-trigger-blind-to-drops/ · Full docs index: https://sluicesync.com/llms.txt
