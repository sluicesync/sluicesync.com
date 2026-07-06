# Redact PII while you migrate & sync

> Seed staging, dev, analytics, and vendor handoffs from production without letting personal data leave with the rows.

You need a realistic copy of production in a place production data isn't allowed to go — a staging database, a developer laptop, an analytics warehouse, a vendor's environment. The schema, the row shapes, and the referential structure all have to survive; the emails, card numbers, and national IDs must not. sluice does this inline with --redact: PII is transformed between the source reader and the target writer, so the sensitive value never lands on the target and never touches the backup on disk. There is no separate scrubbing pass to forget to run.

## How --redact works

Each rule names a column and a strategy:

    --redact '[schema.]table.column=STRATEGY[:options]'

The flag is repeatable — pass it once per column. Rules are applied in the bulk-copy hot path and the CDC apply path alike; the strategy's output replaces the source value verbatim at the named column before it reaches the target. When no --redact is configured the pipeline short-circuits before any per-row work, so operators who don't use redaction pay nothing for the feature.

    sluice migrate \
        --source-driver postgres --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --redact users.email=hash:sha256

Every rule also has a YAML form under a redactions: block in the config file (see Configuration). CLI and YAML mix: CLI rules are processed first, YAML appends, and a duplicate on the same schema.table.column is last-write-wins with a WARN. Keep the bulk in version-controlled YAML; reach for the flag for per-environment overrides (--redact users.email=null in staging).

## Where redaction applies

The same rule set is honoured uniformly across every path that moves rows, so a column can't leak through a surface you forgot about:

Command · Behaviour ·

sluice migrate · One-shot bulk copy — every row passes through the redactor. ·

sluice sync start · Both phases honour --redact: the cold-start snapshot copy and the live CDC apply stream. ·

sluice backup full / incremental · Backup chunks are PII-clean on disk; a later restore copies them through unchanged. ·

sluice schema preview · No data moves — it annotates the generated CREATE TABLE DDL with which columns are redacted (see below). ·

## The strategy families

sluice ships 26 strategies across five families. Pick the one that matches the column's shape.

### Constant & foundational

Strategy · Behaviour ·

null · Replace with NULL. Refuses on NOT NULL columns — use static: there instead. ·

static:<value> · Replace every value with one literal constant. ·

truncate:<n> · Keep the first N runes (rune-counted; UTF-8 and emoji safe). ·

hash:sha256 · SHA-256 hex digest — deterministic, no key required. ·

hash:hmac-sha256 · Keyed HMAC-SHA256 hex digest — requires --keyset-source (see below). ·

### Format-preserving masks

Generic masks keep some characters and blank the rest (default mask char X):

Strategy · Behaviour ·

mask:inner:<m1>,<m2>[,<char>] · Keep first M1 + last M2 runes; mask the middle. mask:inner:4,4 on 4111111111111111 → 4111XXXXXXXX1111. ·

mask:outer:<m1>,<m2>[,<char>] · Mask the first M1 + last M2; keep the middle. ·

Country- and format-specific presets validate the input shape and preserve just the non-identifying part:

Preset · Behaviour ·

mask:ssn · US SSN — preserve last 4 (XXX-XX-NNNN). ·

mask:pan / mask:pan-relaxed · Card PAN — preserve first 6 + last 4. mask:pan requires a valid Luhn checksum; mask:pan-relaxed skips the check. ·

mask:email · First char of the local part + masked middle + full @domain. ·

mask:ca-sin · Canadian SIN — preserve last 3 (Luhn-validated). ·

mask:uk-nin · UK National Insurance number — keep prefix letters + suffix, mask the digits. ·

mask:iban · IBAN — preserve country code, check digits, 2 BBAN, and last 4. ·

mask:uuid · UUID — preserve hyphens + first 4 + last 4 hex. See the caveat below. ·

mask:uuid on a native uuid column. The masked output contains X characters that aren't valid hex, so a target column typed uuid (Postgres) refuses at preflight — before any data moves — unless you also map that column to text with --type-override=table.col=text.

### Realistic synthetic values (randomize)

The randomize:* generators produce fresh, valid-shape fake values — ideal when staging needs data that looks real. Output is replay-stable per source row: the same source primary key always regenerates the same target value across CDC resume, cold-start re-apply, and backup → restore (ADR-0039).

Strategy · Output ·

randomize:int:<min>,<max> · Integer in [min, max] inclusive. ·

randomize:email · rand-local@rand-domain.test (IETF-reserved TLD). ·

randomize:us-phone · NANP-valid XXX-XXX-XXXX. ·

randomize:uuid · RFC 4122 UUIDv4 (passes strict UUID column validation). ·

randomize:ssn · US SSN avoiding reserved ranges. ·

randomize:pan[:<brand>] · Luhn-valid card PAN; optional visa / mastercard / amex. ·

randomize:ca-sin · Luhn-valid Canadian SIN. ·

randomize:uk-nin · UK NIN matching the HMRC prefix alphabet. ·

randomize:iban[:<country>] · IBAN with mod-97 check digits; optional DE / GB / FR. ·

Every randomize:* rule needs a primary key on the source table — the replay seed is derived from the row's PK. The pipeline refuses loudly at startup if a randomize:* rule targets a heap (no-PK) table; add a PK on the source, or pick a non-random strategy.

### Dictionary strategies

Dictionary strategies map source values into a named lookup table declared in YAML (ADR-0040):

Strategy · Keyed by · Use case ·

randomize:dict:<name> · Source PK (replay-stable) · Per-row random pick with controlled cardinality. ·

tokenize:dict:<name> · Source value (HMAC) · Stable per-value surrogates — the same input value maps to the same dict entry in every table and column. ·

The distinction is the point: randomize:dict can send two rows with the same value but different PKs to different entries, whereas tokenize:dict guarantees every occurrence of a value (anywhere) maps to the same surrogate — so analytics joins on the redacted column stay coherent. Dictionaries must be declared in YAML; a CLI reference to an undeclared dict name refuses at parse time.

## Determinism

Redaction output is deterministic, which is what makes it safe to re-run — CDC resume and backup → restore reproduce identical surrogates on the same data. There are four contracts:

Semantics · Strategies · Guarantee ·

Stateless · null, static:, truncate:, hash:sha256, all mask:* · Same input → same output on any sluice run, anywhere. ·

Keyed · hash:hmac-sha256 · Same input + same keyset key → same output. ·

PK-keyed replay-stable · randomize:* (incl. randomize:dict) · Same source row (table + column + PK) → same output across re-runs. ·

Input-keyed cross-stream · tokenize:dict · Same input value + same key → same output across tables, columns, and streams. ·

To correlate a redacted column across tables (a join key), use tokenize:dict or hash:hmac-sha256; the other strategies don't carry cross-table consistency on the same source value.

## The operator keyset (--keyset-source)

The two keyed strategies — hash:hmac-sha256 and tokenize:dict — resolve their HMAC secret from an operator-controlled keyset (ADR-0041). Any rule using either strategy requires --keyset-source; sluice refuses loudly at preflight otherwise. The keyset is a small YAML document holding one or more named keys, each with generations so old surrogates keep resolving after a rotation. It resolves from three sources:

    # keyset YAML on disk
    --keyset-source=file:/etc/sluice/keyset.yaml

    # keyset YAML in an env var (container / secret-manager friendly)
    --keyset-source=env:SLUICE_KEYSET

    # sluice-managed sluice_keysets table on a DSN — shared across streams
    --keyset-source=db:postgres://user:pw@host:5432/keysetdb

A rule names which key it uses via the trailing :<keyname> segment (or a YAML key: field); omit it to use the keyset's declared default or its sole entry. Two rules that name the same key produce cross-consistent surrogates:

    --redact users.email=hash:hmac-sha256:customer_pii
    --redact users.first_name=tokenize:dict:first_names:customer_pii

The db: form is the cross-stream stability primitive: two streams pointing at the same keyset DSN turn alice@example.com into the same surrogate on staging-1 and staging-2. For two independent installs to agree (cross-org exchange), install the same file: keyset at both ends.

No hot-reload. The keyset is snapshotted once at process startup; a rotation takes effect only on the next restart. After a rotation, new rows get surrogates under the new active generation while existing target rows keep theirs — a clean rotation means re-running the migration under the new key. The security model is stable hashing, not secrecy: protect the key bytes with your storage layer — sluice does not encrypt them at rest.

## Preview redaction before you run

sluice schema preview annotates the generated DDL so you can eyeball which columns are covered before moving a single row. The annotation is comment-only — the CREATE TABLE itself is unchanged, so the output stays drop-in usable:

    sluice schema preview \
        --source-driver postgres --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --redact users.email=hash:sha256 \
        --redact users.ssn=mask:ssn

    CREATE TABLE users (
      id    SERIAL PRIMARY KEY,
      email TEXT NOT NULL,    -- REDACTED via hash:sha256
      ssn   TEXT,             -- REDACTED via mask:ssn
      ...
    );

## The audit log

Every command that moves rows emits exactly one INFO line at startup recording the configured redaction surface — the scope, the column count, and the distinct strategy names:

    sluice: redaction configured scope=migrate columns=5 strategies=[hash:sha256 mask:pan randomize:email tokenize:dict:first_names truncate:4]

Per-column rules are deliberately not logged — the mapping itself is sensitive (--redact billing.credit_card=truncate:4 reveals which column holds card numbers), and per-row surrogates are never logged. When a keyset loads, a second line records its source scheme and per-key generations, with any DSN credentials redacted.

## Worked examples

### Mask and hash for an analytics copy

    sluice migrate \
        --source-driver postgres --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --redact users.email=hash:sha256 \
        --redact users.phone=mask:inner:3,4 \
        --redact users.ssn=randomize:ssn

### Realistic synthetic data for a live staging sync

Redaction is honoured on the CDC stream too, so staging stays continuously fresh and continuously scrubbed. YAML config plus a stream id:

    # sluice.yaml
    redactions:
      - table: users.email
        strategy: randomize
        form: email
      - table: users.phone
        strategy: randomize
        form: us-phone
      - table: customers.pan
        strategy: randomize
        form: pan
        brand: visa

    sluice sync start -c sluice.yaml \
        --source-driver postgres --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --stream-id staging-refresh

### Cross-table stable surrogates for a vendor handoff

Use tokenize:dict with one shared key so a customer's name is the same token in every table — the vendor can still join, but never sees the real value:

    # sluice.yaml
    dictionaries:
      first_names:
        entries: [Alpha, Bravo, Charlie, Delta, Echo, Foxtrot]

    redactions:
      - table: users.first_name
        strategy: tokenize
        dict: first_names
        key: customer_pii
      - table: orders.customer_first_name
        strategy: tokenize
        dict: first_names
        key: customer_pii

    sluice migrate -c sluice.yaml \
        --source-driver postgres --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --keyset-source=file:/etc/sluice/keyset.yaml

## What redaction is not

- Not a PII discovery scanner. sluice redacts the columns you name; it does not crawl the schema to find which columns hold personal data. Identifying them is your (or your compliance team's) job.

- Not encryption at rest. Redaction transforms values in flight so the sensitive original never reaches the target or the backup. Protecting the keyset secret and the target storage itself is your storage layer's responsibility — sluice does not encrypt the key bytes at rest.

## Next steps

- Configuration — the YAML redactions:, dictionaries:, and keyset blocks in full.

- Command reference — the flag set for migrate, sync, backup, and schema preview.

- Getting started — install sluice and run your first migration and sync.

---
Canonical page: https://sluicesync.com/docs/redact-pii/ · Full docs index: https://sluicesync.com/llms.txt
