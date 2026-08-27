# FOR ALL TABLES doesn't mean all tables

> Postgres silently excludes UNLOGGED tables from a FOR ALL TABLES publication — no error, no NOTICE, the table simply never appears in pg_publication_tables — while a scoped FOR TABLE publication refuses the same table loudly. The asymmetry extends mid-sync: ALTER TABLE … SET UNLOGGED on a scoped-publication member errors, but under FOR ALL TABLES the identical flip succeeds and the table silently drops out of the stream. For a sync tool the trap composes with the cold copy, which does include unlogged tables: the target receives the snapshot, then freezes forever while everything reports green.

Observed &mdash; the 2026-08-26 capture-completeness sweep, on real PostgreSQL 16: all four cells &mdash; the scoped refusal (cannot add relation "u" to publication &hellip; not supported for unlogged tables, for both CREATE PUBLICATION and ALTER &hellip; ADD), the silent FOR ALL TABLES exclusion, and the mid-life flip split: SET UNLOGGED refused on a scoped-publication member (cannot change table to unlogged because it is part of a publication) yet succeeding under FOR ALL TABLES. A census refusal (SLUICE-E-CDC-UNLOGGED-TABLE) shipped in sluice v0.132.0; the stated residuals are below.

## Opposite failure modes for the same table

Unlogged tables skip WAL &mdash; that is their entire performance proposition &mdash; and logical replication reads WAL, so an unlogged table can never be streamed. Fair enough. The surprise is that Postgres's two publication forms surface this constraint in opposite directions. Add the table to a scoped FOR TABLE publication and you get a loud, immediate refusal. Create a FOR ALL TABLES publication over a database containing the same table and you get&hellip; success. The unlogged table is silently absent from pg_publication_tables &mdash; no error, no NOTICE, nothing distinguishes &ldquo;excluded by rule&rdquo; from &ldquo;included&rdquo; except a catalog view you'd have to know to check. FOR ALL TABLES quietly means all tables that can be published, and the set difference is invisible at creation time.

## The sharpest beat: refuse versus succeed on the identical ALTER

The asymmetry has a mid-life form, and it is sharper. Run ALTER TABLE t SET UNLOGGED on a table that belongs to a scoped publication and Postgres refuses: cannot change table to unlogged because it is part of a publication. Run the identical statement under a FOR ALL TABLES publication and it succeeds &mdash; the membership rule simply re-evaluates, and the table drops out of the publication mid-stream. So the spanning form &mdash; the one whose name most sounds like a completeness guarantee &mdash; is the one where a persistence flip can silently de-scope a live replication stream, while the explicitly-scoped form gets the engine's own protection. Membership by rule re-evaluates as the world changes; membership by list is defended.

## How a sync tool compounds it

A sync tool's cold copy doesn't read publications &mdash; it censuses information_schema for base tables, and unlogged tables are base tables. So the composition is: the initial copy lands the table's rows on the target, the stream opens green, and every subsequent write to the unlogged table produces no WAL, hence no decoded message, ever. The target holds a plausible-looking snapshot that froze at cold-copy time. And once later logged transactions advance the durable resume position, the frozen window isn't lag that a restart could recover &mdash; it is permanent loss with a green stream over it. (The trigger-CDC lane has its own unlogged twist: capture triggers keep firing after a SET UNLOGGED flip, so live capture continues &mdash; but a crash empties the table via recovery truncation without firing the TRUNCATE trigger, so the change log never hears about the wipe.)

## The doors, and the stated residuals

sluice v0.132.0 turned the catalog check into a coded refusal: a relpersistence='u' census over the in-scope tables runs at spanning cold start and every warm resume (because of the mid-life flip), at backup --chain-slot's publication ensure, and pre-DDL on the scoped lane where PG's own error was previously the backstop; v0.132.2 added the schema add-table registration path. The residuals are stated rather than implied closed: a flip during a live streaming window is undetectable until the next open &mdash; the census cadence bounds the blindness, it cannot eliminate it &mdash; and backup incremental's scope-less CDC open runs no census, so a mid-chain flip is caught only by the next full backup.

## The transferable lesson

A membership rule and a membership list are different promises. FOR ALL TABLES reads like a stronger guarantee than an explicit table list, and it is actually a weaker one: it re-evaluates silently as tables change persistence, and the engine defends only the explicit form against membership-breaking DDL. When a system offers both a spanning rule and a scoped list, ask which one the engine actively protects &mdash; and when you rely on the rule, census the set difference yourself, on a cadence, because nothing will tell you when it grows. The same lesson from another angle: publication membership can change under a healthy stream, and Postgres considers that your problem to notice.

## Primary sources

- PostgreSQL documentation &mdash; CREATE PUBLICATION &mdash; temporary and unlogged tables cannot be part of a publication; FOR ALL TABLES membership is rule-based.

- PostgreSQL documentation &mdash; CREATE TABLE &hellip; UNLOGGED &mdash; no WAL, crash truncation, and the replication exclusion.

- sluice v0.132.0 changelog &mdash; the SLUICE-E-CDC-UNLOGGED-TABLE census and its door roster (v0.132.2 for the add-table door), with the residuals stated at the door.

- Related field note: Two syncs, one publication &mdash; the other way a table silently leaves a publication while every health surface stays green.

---
Canonical page: https://sluicesync.com/field-notes/for-all-tables-except-unlogged/ · Full docs index: https://sluicesync.com/llms.txt
