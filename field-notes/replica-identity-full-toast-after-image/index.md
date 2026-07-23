# REPLICA IDENTITY FULL completes the before-image, not the after-image

> REPLICA IDENTITY FULL is sold as 'the whole row in every change' — and it delivers that for the OLD tuple only. Whenever an UPDATE changes a different column of a row whose large column is TOASTed out-of-line, pgoutput sends that column in the NEW tuple as unchanged-toast-datum, so the decoded after-image simply omits it while the before-image arrives complete. sluice's --where router evaluated the predicate over that partial after-image, classified an in-scope UPDATE as a move-OUT, and DELETEd a row the source still holds — exit 0, sync status green.

Observed &mdash; the 2026-07-23 blind audit of sluice's filtered PG sync, reproduced live on PG 16.14 with a 9.6KB STORAGE EXTERNAL column before fixing. Affected sluice v0.99.276&ndash;v0.99.289 (every release with filtered PG sync); fixed in v0.99.290. Operator guidance at the end of this note.

## The asymmetric promise

REPLICA IDENTITY FULL reads like a completeness guarantee: log the whole row, not just the key. And for the old tuple it is exactly that &mdash; every UPDATE and DELETE arrives with a complete before-image, which is why filtered replication turns it on in the first place (the row-move decision needs the predicate column's OLD value). The trap is that the guarantee is one-sided. Postgres's TOAST machinery stores any column value that stays large after compression (≳2KB) out-of-line, and pgoutput carries a deliberate optimization for it: when an UPDATE does not change a TOASTed column, the NEW tuple does not carry its value &mdash; the column arrives as the one-byte marker 'u', unchanged-toast-datum. REPLICA IDENTITY FULL does not disable this. The before-image is complete; the after-image is complete except for the columns that didn't change and happened to be big.

    UPDATE profiles SET last_login = now() WHERE id = 42;
    -- profiles.bio is 9.6KB, TOASTed out-of-line, UNCHANGED by this statement

    pgoutput UPDATE message (REPLICA IDENTITY FULL):
      OLD tuple:  id=42 | last_login=... | bio=<the complete 9.6KB value>
      NEW tuple:  id=42 | last_login=... | bio='u'   <- unchanged-toast-datum

A decoder that skips 'u' datums &mdash; the natural reading, and what sluice's did &mdash; produces an after-image with the column simply absent.

## How an UPDATE became a DELETE

sluice's filtered sync (sync --where "bio LIKE '%…%'", or any predicate referencing the TOASTed column) classifies every UPDATE by evaluating the predicate over both images: old-in/new-in is an in-scope UPDATE, old-in/new-out is a move-OUT that must become a target DELETE. SQL's three-valued logic did the rest: the predicate read the absent column as NULL, evaluated UNKNOWN, and UNKNOWN routes as false &mdash; so an UPDATE to a sibling column of an in-scope row classified as old-in/new-out. sluice emitted a DELETE for a row the source still holds. Silently: the stream stays green, sync status stays current, exit 0. The trigger is as ordinary as it gets &mdash; touching any other column of a row whose filtered column is big. And the failure is bitter under the row-filter push-down specifically: the server was delivering the UPDATE correctly, and the client's own equivalence belt destroyed it.

## The backfill is exact, not approximate

What makes this one satisfying to fix is that the marker's semantics close the hole completely. 'u' is emitted only when the column is unchanged &mdash; that is PG's contract &mdash; so for every omitted column, old == new is guaranteed, and under REPLICA IDENTITY FULL the old value is right there in the same message. sluice's reader now backfills each omitted after-image column from the complete before-image on filtered tables: zero approximation, no extra round-trip, no heuristic. The applier SETs the backfilled value to itself, which is value-neutral. And because the reader is not the only thing that will ever produce a partial after-image, the router gained a belt: a filtered UPDATE whose after-image is still missing a predicate column stops the stream loudly with SLUICE-E-WHERE-CDC-AFTER-IMAGE (the sibling of the existing before-image completeness refusal) instead of guessing.

## Every after-image consumer has this bug until it proves otherwise

Nothing in this mechanism is specific to filtered replication. Any consumer that acts on the NEW tuple &mdash; an audit or outbox pipeline recording &ldquo;the row is now X,&rdquo; cache invalidation that rebuilds an entry from the after-image, a CDC-fed search index re-indexing the document, a downstream materialized view &mdash; receives an after-image that silently omits large unchanged columns, on every UPDATE that touches their siblings. The mature consumers all carry a scar from it: Debezium, for one, documents an explicit unavailable-value placeholder it stamps into the after-image for exactly these columns, pushing the problem to the reader rather than pretending the column is NULL. Whether you backfill (possible only when the before-image is complete), placeholder, or refuse, the invariant is the same: the after-image is not complete unless you make it complete.

## If you ran filtered PG sync on an affected release

v0.99.276&ndash;v0.99.289, with a --where predicate referencing a large text/varchar/JSON column (values big enough to TOAST out-of-line, roughly ≳2KB after compression): upgrade, then re-verify the filtered tables (sluice verify) &mdash; any UPDATE to a different column of such a row may have deleted that row from the target. If verification finds missing rows, --restart-from-scratch or a targeted backfill restores them. Predicates on small always-inline columns (ints, short strings, dates) were not exposed.

## The transferable lesson

Read a completeness guarantee to its exact scope: REPLICA IDENTITY FULL completes the before-image, and no setting completes the after-image &mdash; that is a property of the wire format, not of your configuration. If your logic evaluates anything over a NEW tuple, enumerate what the stream can omit from it and make the omission either impossible (backfill from a source that carries the truth) or loud (a completeness refusal). Three-valued logic will otherwise convert &ldquo;I don't know this column&rdquo; into whichever branch your router treats as false &mdash; and in a filtered pipeline, that branch deletes data.

## Primary sources

- sluice v0.99.290 (the CRITICAL fix + the operator re-verify guidance): the reader-side backfill (backfillUnchangedToast in the Postgres CDC reader &mdash; exact by the unchanged &rArr; old == new contract), the SLUICE-E-WHERE-CDC-AFTER-IMAGE router belt, and the end-to-end pin where_cdc_toast_pg_integration_test.go (row survives, sibling update applies, TOAST value byte-identical); reproduced live pre-fix on PG 16.14.

- PostgreSQL documentation &mdash; logical streaming replication protocol (TupleData, the 'u' unchanged-toast-datum byte), TOAST storage, ALTER TABLE &hellip; REPLICA IDENTITY FULL.

- Debezium documentation &mdash; the unavailable-value placeholder for unchanged TOASTed columns (the same class, handled by sentinel).

- Related field notes &mdash; the optimization that trimmed away the column a later feature needed (the before-image sibling of this failure) and the platform default that eats every UPDATE / the row image you can't preflight (MySQL's spellings of &ldquo;the image is thinner than you assumed&rdquo;).

---
Canonical page: https://sluicesync.com/field-notes/replica-identity-full-toast-after-image/ · Full docs index: https://sluicesync.com/llms.txt
