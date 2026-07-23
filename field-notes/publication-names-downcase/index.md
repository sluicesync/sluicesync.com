# Quoted CREATE PUBLICATION preserves case; START_REPLICATION downcases it

> SQL's quoting rules stop at the replication protocol: a quoted CREATE PUBLICATION name like sluice_MyPub preserves case because it's quoted DDL, but the name passed to START_REPLICATION's publication_names option is parsed as an unquoted identifier and folded to lowercase — so pgoutput looks up sluice_mypub, which doesn't exist. Nothing checks at stream start: the slot creates, the whole bulk copy runs green, and the 42704 fires only inside the first change callback — arbitrarily delayed, or never on a quiet source.

Observed &mdash; the 2026-07-23 blind audit, reproduced on a throwaway postgres:16 with pg_recvlogical. sluice's client-side guard shipped in v0.99.291 (--publication-name existed unvalidated v0.99.287&ndash;v0.99.290).

## Two parsers for one name

Postgres's identifier rules are consistent inside SQL: quote a name and its case is preserved; leave it unquoted and it folds to lowercase. The trap is that a publication name crosses OUT of SQL &mdash; into the replication protocol &mdash; and the parser on the other side is different:

    CREATE PUBLICATION "sluice_MyPub" FOR TABLE t;     -- quoted DDL: case preserved

    START_REPLICATION SLOT s LOGICAL 0/0
        (proto_version '1', publication_names 'sluice_MyPub');
    -- pgoutput parses the option value as an UNQUOTED identifier list
    -- -> folds to sluice_mypub -> which does not exist

The catalog holds sluice_MyPub; pgoutput looks up sluice_mypub. Two objects, one spelling, no error yet.

## The failure geometry: green through the whole bulk copy

&ldquo;No error yet&rdquo; is the nasty part. Nothing validates the publication at stream start &mdash; the slot creates, streaming begins, and the lookup happens lazily, inside the decoding of the first change. So the entire bulk copy runs green, the stream reports healthy for as long as the source is idle, and the SQLSTATE 42704 (publication "sluice_mypub" does not exist) fires minutes, hours, or days later &mdash; naming a lowercase object the operator never created, while their \dRp shows sluice_MyPub sitting right there. On a quiet source it never fires at all: a permanently idle stream, indistinguishable from &ldquo;no changes happened.&rdquo; Loud eventually, but arbitrarily delayed and misleading &mdash; and before the guard, sluice's control-state ratchet even recorded the broken name, so every resume faithfully repeated the mistake.

## The 63-byte sibling, same class

The length limit has the same two-parsers shape: CREATE PUBLICATION silently truncates a >63-byte name to 63 bytes with only a NOTICE &mdash; while publication_names matching at stream time is verbatim, so the over-length spelling you pass never matches the truncated object the DDL actually created. Two spellings of one lesson: the DDL layer and the replication protocol parse the same name differently, and every divergence is a delayed or silent failure.

## Validate client-side, exactly as PG does for slots

The asymmetry that makes this preventable: Postgres already enforces a safe charset server-side for replication slot names &mdash; but publications are ordinary quoted-identifier catalog objects, so they escape that enforcement. The fix is to apply the slot rule yourself before creating anything: validate replication-object names to ^[a-z0-9_]+$, at most 63 bytes. sluice's --publication-name now refuses at resolve time with SLUICE-E-CDC-PUBLICATION-NAME-INVALID &mdash; before the slot, before the copy, before the ratchet can record anything &mdash; turning a green-for-days geometry into an immediate one-line refusal.

## The transferable lesson

When a name you create in one layer is consumed by another layer with its own parser &mdash; SQL to replication protocol, DDL to config file, catalog to wire option &mdash; the safe subset is the intersection of the layers' rules, and you should enforce it at creation time, client-side, even when every individual layer would accept more. A name that only some layers fold, quote, or truncate is a latent lookup miss whose loudness depends on traffic &mdash; the worst kind of delayed failure.

## Primary sources

- The audit's repro: CREATE PUBLICATION "sluice_MyPub" + pg_recvlogical -o publication_names=sluice_MyPub on postgres:16 &mdash; slot creates, streaming starts, zero bytes, healthy while idle; 42704 only in the first change callback.

- sluice v0.99.291: the resolve-time refusal (SLUICE-E-CDC-PUBLICATION-NAME-INVALID, internal/pipeline/streamer_slot_policy.go), pinned through the CLI resolve phase; incl. the recorded-broken-name and 63-byte-NOTICE details.

- PostgreSQL documentation &mdash; identifier folding and quoting; START_REPLICATION / pgoutput plugin options; replication-slot naming rules (the server-side charset enforcement publications escape); NAMEDATALEN truncation.

- Related field notes &mdash; two syncs, one publication (why per-stream publication names exist at all) and the first durable flag (the ratchet that faithfully recorded the broken name).

---
Canonical page: https://sluicesync.com/field-notes/publication-names-downcase/ · Full docs index: https://sluicesync.com/llms.txt
