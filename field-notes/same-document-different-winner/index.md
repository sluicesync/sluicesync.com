# Same document, different winner — SQLite reads the FIRST duplicate JSON key, Postgres jsonb keeps the LAST

> RFC 8259 declines to define what a duplicate object key means, and two mainstream engines quietly picked opposite answers. So "this text column validated as JSON, promote it to jsonb" silently changes which value every future query reads — at exit 0, with the stored bytes looking fine in any spot check. The sharpest edge: the promotion's validator was SQLite's own json_valid, a validator that happily accepts exactly what the target type destroys.

Observed — the 2026-07-15 repo audit (MED-D0-3) against sluice's --infer-types jsonb promotion, with the Postgres half verified on a real PG 16.14 and the value flip exhibited live on the shipped v0.99.257 binary by the v0.99.258 regression cycle. Fixed in v0.99.258: a column holding any duplicate-key document is never promoted. Both engine behaviors are documented or by-design — there is nothing to file upstream; the bug was ours, in assuming &ldquo;valid&rdquo; meant &ldquo;preservable.&rdquo;

## What happened

JSON's spec has a deliberate hole: RFC 8259 says object names &ldquo;SHOULD be unique&rdquo; and leaves the behavior for duplicates undefined. Every implementation picked something:

- SQLite says {"a":1,"a":2} is valid (json_valid(&hellip;) returns 1) and json_extract(&hellip;, '$.a') returns 1 — the first duplicate wins.

- Postgres jsonb parses the same bytes and stores {"a": 2} — the last duplicate wins, documented behavior, verified on PG 16.14 (nested objects included).

sluice's --infer-types path (auto-engaged for CSV/TSV/NDJSON sources, which stage through SQLite) offered an innocuous-looking upgrade: if every value in a JSON-hinted text column validates as JSON, promote the target column to jsonb. The validator was SQLite's json_valid. So a document with duplicate keys sailed through validation, landed in jsonb, and Postgres silently rewrote which value the document carries — while the disclosure sluice printed affirmatively described the transform as mere &ldquo;whitespace/key-order&rdquo; normalization. Most documents carry no duplicates, so any spot check looks clean; the one that does is precisely the one the promotion corrupts.

## The live differential

The v0.99.258 regression cycle ran a CSV with a jsonb-hinted payload column carrying {"a":1,"a":2} (plus a clean settings control column) through --infer-types on both shipped binaries:

    binary       payload column    stored value
    ---------    --------------    ------------------------------------------
    v0.99.257    jsonb             {"a": 2} — the first duplicate silently
                                   dropped, rc=0, no signal
    v0.99.258    text              {"a":1,"a":2} byte-exact; the disclosure
                                   names the dup-key class and the column;
                                   the clean sibling still promotes to jsonb

The gate is per-column: one poisoned column doesn't demote the rest.

## Why &ldquo;is it valid?&rdquo; was the wrong question

The two predicates look interchangeable and aren't:

- Is this valid JSON? — what json_valid answers. Duplicate keys: yes.

- Does the target's JSON type preserve this document? — what a promotion actually needs. Duplicate keys under jsonb: no. (jsonb is a parsed binary representation; last-wins is the price of key deduplication. Postgres's plain json type, which stores text verbatim, would preserve it — jsonb does not.)

Duplicate keys are the one place the same document legally means two different things in two engines: a reader pointed at the SQLite staging copy sees a = 1; a reader pointed at the promoted Postgres column sees a = 2. Nothing errored anywhere. The fix therefore had to be a scan, not a validator swap: sluice now runs a json_tree per-parent duplicate-key aggregate over every nesting depth (escaped key spellings included) and refuses to promote any column holding even one duplicate-key document — it stays text, source bytes intact, and the promotion disclosure names the collapse instead of calling it normalization.

## Reproducing it

No sluice required to see the engine disagreement:

    -- SQLite
    SELECT json_valid('{"a":1,"a":2}');              -- 1 (valid)
    SELECT json_extract('{"a":1,"a":2}', '$.a');     -- 1 (FIRST wins)

    -- Postgres (verified on 16.14)
    SELECT '{"a":1,"a":2}'::jsonb;                   -- {"a": 2} (LAST wins)
    SELECT '{"x":{"a":1,"a":2}}'::jsonb;             -- {"x": {"a": 2}} (nested too)

And the migration-shaped consequence, with sluice (this is the regression-cycle fixture):

    cat > docs.csv <<'EOF'
    id,payload,settings
    1,"{""a"":1,""a"":2}","{""ok"":true}"
    EOF

    sluice migrate --source-driver csv --source ./docs.csv --csv-header \
      --target-driver postgres --target '<dsn>'
    # <= v0.99.257: payload promoted to jsonb, PG stores {"a": 2}, rc=0
    # >= v0.99.258: payload stays text, byte-exact; settings still promotes;
    #               the disclosure names the duplicate-key column

(Column names matter: the promotion only considers JSON-hinted names — settings, metadata, payload, attributes, *_json.)

## The transferable lesson

&ldquo;Is it valid X?&rdquo; and &ldquo;does the target's X type preserve it?&rdquo; are different predicates, and the gap between them is exactly where a format's undefined corners live. When a spec says SHOULD and stays silent on the consequences, every engine's answer is a coin flip you have to look up — and any pipeline that upgrades a value into a parsed representation (jsonb, a binary protobuf, a normalized XML store) needs to scan for the inputs where parsing is lossy, not just the inputs where parsing fails. Validate with the destroyer, and you will bless exactly what it destroys.

## Primary sources

- RFC 8259 §4 — object names &ldquo;SHOULD be unique&rdquo;; behavior for duplicates is explicitly implementation-defined.

- PostgreSQL documentation — jsonb: &ldquo;duplicate object keys&hellip; only the last value is kept.&rdquo;

- SQLite json1 documentation — json_valid and json_extract (first-key behavior observable directly).

- sluice v0.99.258 changelog — the duplicate-key non-promotion and the corrected disclosure; the 2026-07-15 audit finding MED-D0-3; sluice-testing session report v0.99.258 (F5, the live value flip).

- Companion field notes — mysql-json-where-cast (cross-engine JSON surprises) and int64-json-boundary (another of JSON's unspecified corners biting databases).

---
Canonical page: https://sluicesync.com/field-notes/same-document-different-winner/ · Full docs index: https://sluicesync.com/llms.txt
