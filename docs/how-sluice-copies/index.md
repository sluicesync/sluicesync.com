# How sluice copies your data

> Same-engine vs cross-engine: which internal path a copy takes, and why the fast path never trades correctness for speed.

Every migration and sync moves rows through one of two internal paths. Which one runs is automatic — you don't pick it — but the distinction explains sluice's performance profile and, more importantly, why it never trades correctness for speed.

## The IR path — the default, and the only path for cross-engine

Everything cross-engine — MySQL → Postgres, Postgres → MySQL, SQLite → anything — flows through sluice's internal representation (IR): a typed, dialect-neutral model of your schema and values. The source reader decodes each row into IR; the target writer encodes IR into the target's wire format. The IR is where every cross-engine capability lives: type translation (MySQL TINYINT(1) ↔ PG BOOLEAN; PG UUID / INET / ARRAY ↔ their MySQL equivalents), PII redaction, --type-override / --expr-override, and the value-fidelity checks that refuse loudly rather than silently coerce. That generality is the point of sluice — but it has a cost: every value is decoded and re-encoded, even when source and target are the same engine and nothing needs to change.

## Postgres → Postgres — the fast lane that skips the round trip

When both sides are Postgres and there is no transformation to apply, the bytes the source emits are exactly the bytes the target wants, so the decode → IR → re-encode round trip buys nothing. sluice detects this and byte-pipes the server's native COPY stream straight from source to target (COPY (SELECT …) TO STDOUT → COPY … FROM STDIN), never materializing an IR row. This is the same tactic pgcopydb uses, and it closes most of the per-stream throughput gap against it. It composes with sluice's parallel copy — each table, and each primary-key-range chunk of a large table, byte-pipes independently.

## MySQL → MySQL — no translation to do, plus a native loader

A same-engine MySQL copy still flows through the IR (there is no raw byte-pipe for MySQL today), but with source and target identical there is nothing to translate — every type round-trips exactly — and sluice writes through MySQL's native bulk loader (LOAD DATA LOCAL INFILE) on the parallel copy path, the fastest ingest MySQL offers. (PlanetScale blocks LOAD DATA LOCAL, so a PlanetScale target falls back to batched multi-row INSERT.)

## SQLite and Cloudflare D1 — always the IR path, with a lossless read projection

A SQLite file, a wrangler d1 export .sql dump, or a live Cloudflare D1 database imports into Postgres or MySQL (and SQLite is itself a migrate target). These always take the IR path — there is no raw byte-pipe for SQLite or D1, and there doesn't need to be: the copy is cross-engine, so every value is being translated anyway. The engineering that matters here is on the read side, because SQLite's dynamic typing and D1's HTTP-only access each make "read the value exactly" the hard part.

- Dynamic types, read losslessly. SQLite stores a storage class per value, not a declared column type. sluice reads each column through a (typeof(col), CAST(col AS TEXT) / hex(col)) projection, so an integer above 253 keeps every bit and a BLOB round-trips byte-for-byte instead of going through a lossy float or UTF-8 coercion. A decimal written into a SQLite target lands byte-exact as TEXT.

- Declared temporal types are an explicit decode, never a guess. SQLite has no native date/time storage, so a column declared DATE / DATETIME is decoded per --sqlite-date-encoding (iso default, or unixepoch / unixmillis / julian). A stored value whose storage class doesn't match the chosen encoding is refused loudly — never silently turned into a wrong date.

- Live D1 stays online. The d1 engine reads over D1's HTTP query API (token via CLOUDFLARE_API_TOKEN) using the same lossless projection; the read doesn't take the database offline (ADR-0132).

This is the one-shot migrate copy path. Continuous sync from SQLite or D1 is a separate, trigger-based mechanism — the sqlite-trigger / d1-trigger CDC engines — not this cold-copy lane. See Import SQLite or Cloudflare D1 for the full walkthrough, and Supported directions for which SQLite/D1 pairs are one-shot vs continuous.

## The fast lane is not "more accurate" — it is the same fidelity, less work

Worth stating plainly: the Postgres byte-pipe is not a more exact copy than the IR path. Both are exact. It is faster precisely because it only runs when there is provably nothing to change — so it can move bytes instead of re-deriving them.

## The safety gate — why speed never costs you correctness

The Postgres byte-pipe is guarded by one auditable check that proves there is no transform to skip. The moment any of these is present, sluice falls back to the IR path automatically — per table, without you configuring anything:

- --redact (PII redaction)

- --type-override or --expr-override

- shard-column injection (--inject-shard-column)

- an OID / wire-format-sensitive type — extension types like pgvector / hstore, bit, or PostGIS geometry — whose per-type codec must run

Add a redaction rule to a Postgres → Postgres migrate and the raw lane silently steps aside for exactly the tables that need it; drop the rule and it re-engages. The fast lane is opportunistic and conservative by construction.

Scope today. The Postgres byte-pipe runs on the cold-copy phase of migrate (not the sync cold-start or a resume yet). Format is text by default (safe across Postgres major versions); binary is opt-in on matched server majors.

    # same-engine PG->PG migrate; the raw COPY lane engages automatically
    sluice migrate \
        --source-driver postgres --source 'postgres://user:pass@src:5432/app?sslmode=require' \
        --target-driver postgres --target 'postgres://user:pass@dst:5432/app?sslmode=require' \
        --raw-copy-format auto      # text (default) | binary | auto (binary when majors match)

## Next steps

- migrate reference — the parallelism flags (--table-parallelism, --bulk-parallelism) and --raw-copy-format.

- Redact PII — the transforms that route a copy onto the IR path.

- Preview & validate — see the plan before you run it.

---
Canonical page: https://sluicesync.com/docs/how-sluice-copies/ · Full docs index: https://sluicesync.com/llms.txt
