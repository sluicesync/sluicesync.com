# Postgres never logically decodes a table rewrite

> Everyone who works with pgoutput knows it streams no DDL; the sharper fact is that a table-rewriting ALTER's row rewrites are invisible too. ALTER COLUMN TYPE numeric(10,1) on a numeric(10,4) column rounds every stored value while the replication slot decodes zero messages — Postgres rewrites into a transient relation that logical decoding deliberately skips. The only wire artifact is one number in the next RelationMessage, invisible to a classifier that compares type OIDs; the same-type USING rewrite leaves no artifact at all and is provably undetectable from the stream.

Observed &mdash; the 2026-08-26 capture-completeness sweep, on real PostgreSQL 16 with sluice's exact slot options: ALTER COLUMN &hellip; TYPE numeric(10,1) on a numeric(10,4) column rounded every stored row (99.9999 → 100.0) while the slot decoded zero messages. Typmod detection shipped in sluice v0.132.0; a v0.132.1 fast-follow refuses the detected-but-unforwardable shapes under both schema-change modes. The same-type USING rewrite remains a documented, permanent gap &mdash; no fix from the stream is possible.

## Beat one: a billion-row rewrite decodes as nothing

Some ALTER TABLE forms rewrite the entire table: Postgres builds a new physical relation, re-evaluates every row into it, and swaps it in. The rewrite's row traffic goes through a transient relation that logical decoding deliberately skips &mdash; reasonably, from Postgres's point of view: the rewrite is not new data, and replaying a billion synthetic row changes at every subscriber would be ruinous. But when the ALTER changes stored values &mdash; a precision shrink that rounds, a USING expression that transforms &mdash; the skipped traffic is precisely the change. On the wire, a value-rewriting ALTER over a billion rows and no change at all are the same stream: silence.

## Beat two: the one number that changed is not an OID

There is exactly one downstream trace of the typmod-shrink case, and it is easy to mishandle. pgoutput re-describes a relation lazily &mdash; one RelationMessage immediately before the next row change &mdash; and after the ALTER, that message carries the column's new typmod (the parenthesized modifier: precision/scale, length). The type OID is unchanged: numeric(10,4) and numeric(10,1) are both just numeric. So the obvious relation-change classifier &mdash; compare each column's type OID against the last known schema &mdash; sees &ldquo;no change,&rdquo; and a consumer with a refuse-on-schema-change policy has no door for the one ALTER that already rewrote every row underneath it. That was sluice's gap through v0.131.5: the v0.132.0 fix is simply that the classifier compares typmods too, so refuse mode refuses loudly and forward mode's convergence (the target re-runs the same deterministic cast) is pinned end-to-end.

## Beat three: the rewrite you provably can't detect

Now remove the typmod change. ALTER COLUMN v TYPE int USING v*10 on an int column rewrites every value &mdash; and its post-rewrite RelationMessage is content-identical to the pre-rewrite one: same OID, same typmod, same everything. Observed directly: zero decoded messages, then a relation descriptor indistinguishable from the old. This class is not hard to detect &mdash; it is impossible from the stream, and only barely visible from the catalog: the rewrite allocates a new relfilenode (observed 16395 → 16402), but VACUUM FULL and CLUSTER allocate new relfilenodes too, without changing a single value, so even that signal can only ever be a heuristic WARN, never a classifier. The honest support statement for value-rewriting ALTERs is the drained model: stop the stream, apply the DDL on both sides, resume.

## Coda: two representations of &ldquo;the column's type&rdquo;

Comparing typmods still isn't the end, because a consumer holds two representations of a column's type &mdash; the raw catalog pair (OID, typmod) and the projected model it maps engines' types into &mdash; and they can disagree about whether anything changed. interval(p) and array-element typmods are visible to the raw compare but vanish in projection (the modeled type has no slot for them), so detection and forwarding split: the change classifies, yet there is no projected schema boundary to forward. sluice's v0.132.1 fast-follow settles this the only honest way &mdash; a detected change whose projected type is unchanged refuses under both modes, per column, with a catalog-derived enumeration gate holding the class closed. The same release closed a final wrinkle the review found: pgoutput coalesces DML-quiet back-to-back DDL into one RelationMessage of final state, so a DROP COLUMN paired with a projection-invisible ALTER classified as just the drop &mdash; and since dropping a middle column shifts every later ordinal, the old/new compare has to key on column name, not position, to see the surviving column's change at all.

## The transferable lesson

On the logical-replication wire, a rewrite of every stored row and no change at all are the same message stream. Every pgoutput consumer's schema-change story has to be built knowing that: classify relation changes from the full descriptor (typmods included, names as keys), treat a detected change you cannot faithfully forward as a refusal rather than a shrug &mdash; and state plainly that the same-type USING class is undetectable, so operators route those ALTERs through a drained window instead of trusting the stream. A companion fact makes the family complete: the RelationMessage is also lazy, so a schema change with no rows behind it emits nothing either &mdash; that note is about when the descriptor arrives; this one is about how much the descriptor can never say.

## Primary sources

- PostgreSQL documentation &mdash; ALTER TABLE &mdash; which forms rewrite the table, and the USING clause's arbitrary value transformation.

- PostgreSQL documentation &mdash; logical replication message formats &mdash; the Relation message: name, OID, typmod, and key flag per column; nothing else, and no DDL messages at all.

- sluice v0.132.0 and v0.132.1 changelogs &mdash; the typmod classifier fix (affected releases v0.99.45&ndash;v0.131.5, refuse mode), the refuse-under-both-modes gate for projection-invisible shapes, and the drained-model guidance for value-rewriting ALTERs.

- Related field notes: An ALTER with no rows behind it is invisible to Postgres CDC &mdash; the emission-timing half of the same family; pgoutput won't tell you a column's DEFAULT &mdash; another thing the relation descriptor can never say.

---
Canonical page: https://sluicesync.com/field-notes/pg-never-decodes-rewrites/ · Full docs index: https://sluicesync.com/llms.txt
