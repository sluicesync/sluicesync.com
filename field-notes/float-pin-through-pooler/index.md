# The one-line fix that unpinned itself through the pooler

> A server that ships extra_float_digits=0 rounds every float Postgres renders as text, and sluice renders floats as text in four different sessions. The fix reads like one line — SET extra_float_digits = 3 before you read. It is four pins and a transaction, because a bare SET followed by a COPY silently lands on two different backends under a transaction-mode pooler, the fix's own error hint was steering users onto that pooler, and one of the four sessions is the verifier — which had been blessing the corruption it exists to catch.

Observed — hardening sluice against the extra_float_digits float-rendering class (Bug 194, filed against a Supabase-sourced validation; the class fix and its four review findings shipped in v0.99.265). The unpinned-through-the-pooler shape was caught in pre-land review and was never in any released version; the shipped v0.99.265 pins are transaction-scoped from day one. This is the engineering companion to a shorter note on the reader-facing fact — your floats are fine; your diff tool is comparing two renderings.

## What the setting does, and why it's a data bug not just a display bug

A float8 has one binary identity and, historically, more than one text rendering. Since PostgreSQL 12 the default extra_float_digits is 1, which selects shortest-round-trip output: the fewest digits that parse back to exactly the same double. At 0 — the pre-12 default, which some managed providers (Supabase among them) still ship server-wide — Postgres renders through the legacy ~15-significant-digit path, which can round away the low bits of the printed form.

The comfortable assumption is that this is only a display concern: the stored bits are untouched, so a binary copy is safe. That assumption was wrong for sluice, because sluice does not always move floats in binary. Its raw-copy lane can move them as server-rendered text; its CDC paths render tuple text server-side; and its verifier hashes server-rendered text. Every one of those is a session in which extra_float_digits governs the bytes that actually cross the boundary — so at 0, a float could be rounded in transit, a genuine value corruption, not a cosmetic one. On the Supabase run, pi drifted through a green stream; only DBL_MAX was loud enough to fail visibly.

## Four faces, four reasons the obvious pin can't reach them

The fix is to pin SET extra_float_digits = 3 (maximum precision) in every session that renders a float as text. There turned out to be four, and each resisted the naive placement for its own reason:

- The raw-copy TEXT lane. The COPY reads floats as text; pin the session before the COPY. This is the one that looks trivial and is the subject of the pooler trap below.

- The pgoutput CDC stream. Tuple text is rendered in the walsender's session, not the applier's. A logical replication=database walsender accepts a plain SQL SET — verified live — so the pin goes there.

- The trigger-CDC capture function. The change image is built by to_jsonb() in the firing application's session — a session sluice never opens and can never pin from the outside. The only surface that survives arbitrary application sessions is the trigger function itself, so the pin becomes a per-function SET extra_float_digits = 3 clause on the capture function's definition.

- The verifier. Its server-side ::text sample hashes were the quiet horror. Two endpoints with different extra_float_digits render the same stored float differently, so verify reported false mismatches on identical data — and, worse, a source at 0 renders a true value byte-for-byte the same as a target holding that value's rounded corruption, so verify reported a false clean, blessing the exact corruption it exists to catch. A verifier that reads through the setting under test cannot adjudicate it.

## The pin that unpinned itself

The raw-copy pin looked like the easy one, and it hid the sharpest finding. The first instinct — pin the GUC as a startup parameter on the connection — cannot work here: Supabase's pooler names this exact GUC in its ignore_startup_parameters list, and pgbouncer refuses startup packets carrying parameters it does not track. So the pin has to be a SQL statement issued after connect.

But a bare autocommit SET followed by a COPY is also not pooler-proof. Under transaction-mode pooling — Supabase's recommended :6543 endpoint, and the default shape of pgbouncer's busiest mode — a server backend is assigned per transaction. Two separate autocommit statements can land on two different backends: the SET pins backend A, the COPY reads from backend B, still at the default rounding. Result: rc=0, stream green, bug fully alive. And the cruelest detail — the fix's own IPv6-only remediation hint had been telling users to reach for the transaction-mode :6543 endpoint, i.e. steering them directly onto the one path where the pin evaporates.

The resolution is an explicit transaction with SET LOCAL. A transaction is precisely what pins one backend for its duration under transaction-mode pooling, so the SET LOCAL and the COPY are guaranteed to share a backend; LOCAL scopes the pin to that transaction so nothing leaks back into the shared pool. This was pinned against a real pgbouncer 1.25 in pool_mode=transaction with a Supavisor-shaped ignore_startup_parameters, not a mock.

One more trap lived inside that transaction. sluice's snapshot reader already runs its COPY inside the exported-snapshot transaction that pins consistency across parallel readers. Wrapping the pin in a fresh BEGIN there would warn (a transaction already open) and a COMMIT would destroy the exported snapshot, breaking every other reader. So the pins detect the ambient transaction via the connection's TxStatus and join it — issuing SET LOCAL inside the snapshot transaction — rather than opening a nested one.

## What sluice does about it

Since v0.99.265, all four faces are pinned, transaction-scoped, and proven through a real pooler. There is one operational step the release notes flag as action-required: trigger-CDC users must re-run sluice trigger setup after upgrading, because the capture-function pin lands via CREATE OR REPLACE — installed triggers keep capturing rounded floats until the function is replaced. Nothing here is an upstream bug to file: Supavisor stripping the GUC and pgbouncer's transaction-mode backend assignment are documented, intended pooler behavior. The lesson is entirely about building on top of them correctly.

## The transferable lesson

A session-GUC fix is only as strong as the session model underneath it. Before you trust SET x = y; <do work>, ask three questions: can a pooler strip it (then it can't be a startup parameter); can the pooler put the SET and the work on different backends (then it must be one transaction with SET LOCAL); and are you already inside a transaction whose semantics a naive BEGIN/COMMIT would wreck (then join, don't nest). Then find every session that renders the value, not just the one you were looking at — including the verifier, because a checker that reads through the setting under test will confirm both the false mismatch and the false clean, and the false clean is the one that ships.

## Primary sources

- PostgreSQL documentation — extra_float_digits (shortest-round-trip at the default of 1 since PG 12) and the streaming-replication protocol (replication=database walsenders accept SQL).

- pgbouncer documentation — pool_mode=transaction (per-transaction server assignment) and ignore_startup_parameters; Supabase's Supavisor docs for the stripped GUC and the transaction-mode :6543 endpoint.

- sluice Bug 194 and CHANGELOG v0.99.265 — the four-face pin, the F1 pooler-unpin finding, the SET LOCAL + ambient-snapshot-transaction resolution against real pgbouncer 1.25, and the trigger-setup re-run action-required note.

- sluice field notes — your floats are fine; your diff tool is comparing two renderings (the reader-facing GUC fact), and the verifier rode the same reader (the false-clean kinship).

---
Canonical page: https://sluicesync.com/field-notes/float-pin-through-pooler/ · Full docs index: https://sluicesync.com/llms.txt
