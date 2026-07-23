# pgoutput won't tell you a column's DEFAULT — and the obvious fix drops every default on your target

> pgoutput's Relation message carries each column's name, type OID, typmod, and key flag. No DEFAULT. No NOT NULL. So the obvious fix for 'a source SET DEFAULT is silently skipped' — add DEFAULT to the schema-diff classifier — was implemented, found to be simultaneously dangerous and ineffective, and reverted: it would emit DROP DEFAULT across the whole target at the first seed→CDC boundary of every sync, while a real mid-stream SET DEFAULT still went undetected. A shape classifier can only classify what the change stream actually carries.

Observed &mdash; closing sluice's DDL-forwarding gap audit against the Supabase etl announcement's change list. The classifier extension was implemented, ground-truthed, and reverted the same day; the design of record is ADR-0179. To be plain about the current state: sluice does not forward a source ALTER COLUMN &hellip; SET DEFAULT mid-sync &mdash; sluice schema diff detects the drift, and the divergence materialises at cutover, when the application's DEFAULT-omitting INSERTs start landing on the target.

## What the Relation message actually carries

Logical replication doesn't send your schema; it sends pgoutput's projection of it. Per column, a Relation message carries exactly: name, type OID, type modifier, and whether the column is part of the replica identity key. That is the whole list. No default expression, no NOT NULL flag, no identity/generated markers. sluice's CDC-side schema for a Postgres source is built from this projection, so every column's default is &mdash; structurally, always &mdash; empty on the wire side.

## Why the obvious fix is both dangerous and ineffective

The gap looks like a one-line classifier fix: the schema-shape differ compared only type and nullability, so teach it to compare Default too. Implemented, it fails in both directions at once:

    seed -> CDC boundary:   pre  = real catalog read   (defaults POPULATED)
                            post = pgoutput projection  (defaults nil)
      => EVERY column-bearing table classifies as a "default change"
      => the applier emits DROP DEFAULT across the whole target
         on the first boundary of every sync.

    CDC -> CDC boundary:    pre = nil, post = nil
      => a real SET DEFAULT still classifies as "no change".

Dangerous on the boundary every sync crosses once, ineffective on the boundary the feature exists for. The corroborating evidence was already in-tree: sluice's schema-forward path keeps a source catalog prober for defaults precisely because the CDC-side schema never has them, and the Postgres writer force-sets Nullable=true on forwarded ADD COLUMN for the sibling omission (attnotnull isn't on the wire either). MySQL is the same story from the other side: the binlog table map carries types, not defaults.

## The design that actually works pushes the catalog into the WAL

Supabase's etl hit the same wall, and their machinery is the correct shape: a ddl_command_end event trigger reads pg_attribute &#8904; pg_attrdef, builds a JSONB catalog snapshot, and emits it via pg_logical_emit_message(true, &hellip;) &mdash; the leading true (transactional) being the load-bearing bit, because it makes the schema fact arrive in the stream exactly where the DDL happened, ordered against the Relation and DML messages around it. Their code even avoids PL/pgSQL exception handlers in that function specifically to preserve that ordering. The tempting cheap alternative &mdash; probe the catalog from the client when a schema change is suspected &mdash; is rejected on ordering grounds: a probe result has no position in the change stream; by the time it returns, the source may have moved on, and you cannot say which changes it applies to. The reason sluice records this design rather than shipping it: CREATE EVENT TRIGGER requires superuser, which a wide managed-provider matrix doesn't grant &mdash; so it can only ever be an opt-in capability, never the default path.

## The transferable lesson

A shape classifier can only classify what the change stream actually carries. Before extending a DDL-forwarding catalog with a new column attribute, confirm the attribute survives into the stream-projected schema on every source that would use it &mdash; and if it doesn't, know that the fix is not client-side cleverness but getting the fact into the stream, in order, where it happened.

## Primary sources

- sluice ADR-0179 (PG DDL catalog capture via transactional logical messages) &mdash; includes the reverted-implementation record and the rejected client-probe analysis.

- PostgreSQL documentation &mdash; logical streaming replication protocol (Relation message fields), pg_logical_emit_message, CREATE EVENT TRIGGER (superuser).

- supabase/etl (read at commit 6d21f3f) &mdash; the ddl_command_end trigger migration emitting transactional catalog snapshots, credited as the known-correct design.

---
Canonical page: https://sluicesync.com/field-notes/pgoutput-carries-no-defaults/ · Full docs index: https://sluicesync.com/llms.txt
