# Persist a resume cursor as JSON and it silently teleports

> A resumable keyset walk persists its last-processed PK between runs, and the obvious store is JSON — which quietly rewrites database values on the way through. We saw half the class at design time ([]byte → base64, time.Time → RFC 3339) and normalized it. The half we missed fired live: Go's json.Marshal replaces invalid-UTF-8 bytes with U+FFFD, and numbers ride float64 past 2^53 — so a resumed walk skipped 73,100 of 100,000 rows at exit 0. Resume state is a codec too, and ours had zero coverage.

Observed — in two acts. Act one caught at design time while building sluice backfill's resume path (ADR-0159, v0.99.244) and normalized before ship. Act two found by the 2026-07-15 repo audit (CRITICAL-2 and HIGH-1, both confirmed on live MySQL) and then exhibited on the shipped binaries by the v0.99.257 regression cycle with exact magnitudes — the numbers below are from real differential runs. Fixed in v0.99.257 with a typed envelope. The exposure was sluice's own: backfill resume since v0.99.244, and the migrate copy-resume cursor rode the same store.

## Act one: the halves we saw

A keyset walk — backfill, chunked copy, verify — persists a cursor between runs: the last-processed primary-key tuple, re-bound into the resume predicate WHERE (pk&hellip;) > (cursor&hellip;). The obvious store for a heterogeneous tuple is JSON, and Go's encoding/json rewrites two whole type families on the way through:

- []byte marshals as base64. A binary PK cursor comes back as its base64 text — a syntactically valid comparison value that lands nowhere near the real key.

- time.Time marshals as RFC 3339 (2026-07-14T10:30:00Z). MySQL does not reliably parse the T/Z shape inside a comparison.

Both re-bound values are valid — no parse error, no refusal — just a walk that resumes from somewhere other than where it stopped. A misplaced cursor is the worst failure class for resumable work because the loss shows up as position, not as a message. The v0.99.244 design saw this and normalized at the scan boundary: []byte to its raw string form, time.Time to the engine's own comparable literal, pinned by unit tests in both engines.

## Act two: the halves we missed

The audit's finding was that the normalization itself handed encoding/json a Go string of raw bytes — and json.Marshal silently replaces every invalid-UTF-8 byte with U+FFFD (EF BF BD). A BINARY PK cursor 0x9F8041FE10 round-trips to 0xEFBFBDEFBFBD41EFBFBD10: 5 bytes become 11, and the mangled value sorts bytewise greater — so on live MySQL the resumed predicate (id) > (<mangled>) skips every PK range between the true cursor and the imposter. BINARY(16) UUID keys are mainstream; the run reports success; --verify is optional; and a following contract step (DROP the old column) makes the loss permanent.

The second missed half was the documented one: TableProgress decoded its JSON with a plain decoder — no UseNumber — so every number rode float64. A persisted cursor of 9007199254740995 decoded as &hellip;996 (+1: a row skipped forever); a snowflake-magnitude 1750000000000000123 drifted &minus;123 (float64 granularity &asymp;256 up there), replaying past the documented at-most-one-chunk bound.

The regression cycle put exact magnitudes on all of it, running the shipped binaries against each other:

    shape                          v0.99.256 (before)                    v0.99.257 (after)
    ---------------------------    ----------------------------------    -----------------------------
    backfill, BINARY(16) PKs       resumes its own mangled cursor at     coded SLUICE-E-BACKFILL-
    (every key leading 0x80)       rc=0, marks the run complete —        CORRUPT-CURSOR, rc=3, names
                                   73,100 of 100,000 rows NEVER          --restart + the U+FFFD
                                   visited (exactly 100,000 minus        fingerprint, writes nothing;
                                   the 26,900 persisted as copied)       --restart heals, 100,000 exact
    backfill, PG BIGINT dense      cursor 1152921504606879676 rounds     envelope cursor; resume exact
    near 2^60                      up +68; EXACTLY the predicted 68
                                   rows skipped, row-for-row
    migrate --resume, bytea PK     its own writer persisted base64       WARN "persisted resume cursor
                                   text; resume rc=0, complete,          is not trustworthy; truncating
                                   46,000 of 200,000 rows never          and re-copying" → 200,000
                                   copied                                exact, checksum == source

The float64 row deserves a second look: the skip window matched the drift arithmetic row-for-row. This class isn't flaky — it's deterministic corruption of position, which is why it survives every rerun.

## The part that stings: we already owned the fix

sluice's backup values had been protected from exactly these rewrites since v0.99.159 — Bug 172 introduced a tagged-envelope codec ({"_t":"i64"}-style) precisely because JSON mangles bytes and big integers. The value path also had a year of the family-matrix test discipline: pin every type family, not one representative. The cursor store got neither: it stayed a bare json.Marshal, and its one resume integration pin exercised only INT primary keys. Checkpoint state is a codec with all the same failure modes as the data path — it just corrupts where you are instead of what you have.

The v0.99.257 fix applies the owned remedy: cursor slices persist as typed envelopes ({"_t":"i64"|"u64"|"bytes"|"f64"|"time"}); valid-UTF-8 strings, bools, and nulls stay bare, and a string containing U+FFFD is enveloped as bytes so mangled and legitimate stay distinguishable. Legacy bare cursors parse exact-int64-first (including BIGINT UNSIGNED above MaxInt64), so pre-envelope integer cursors keep resuming losslessly — the cycle proved a v0.99.256-written cursor resumes under v0.99.257 with no refusal. Provably-mangled legacy cursors are handled where the PK types are known: backfill refuses with a coded error naming --restart; migrate self-heals through its existing truncate-and-redo disposition. And resume fidelity is now integration-pinned per orderable PK family — large-int, binary, composite, temporal, multibyte string — on real MySQL and Postgres.

## Reproducing it

The rewrites are visible in a few lines of Go — no database required:

    cursor := map[string]any{
        "pk": string([]byte{0x9F, 0x80, 0x41, 0xFE, 0x10}), // raw bytes as string
        "n":  int64(9007199254740995),
        "ts": time.Date(2026, 7, 14, 10, 30, 0, 0, time.UTC),
    }
    b, _ := json.Marshal(cursor)
    fmt.Println(string(b))
    // "pk" is now U+FFFD-riddled (5 bytes -> 11), "ts" is a T/Z literal MySQL
    // won't compare; decode "n" without UseNumber and it comes back ...996

The end-to-end shape, on sluice: create a table with a BINARY(16) PK whose keys lead with 0x80+ bytes, start sluice backfill (or an interrupted migrate) against v0.99.256, kill it mid-walk, and resume: rc=0, &ldquo;complete,&rdquo; and every row above the true cursor's mangled ghost untouched — the NULL-visible fixture (--set 'new = old + 1' --where 'new IS NULL') makes the skipped rows countable. The same states under &ge; v0.99.257 refuse coded or self-heal.

## The transferable lesson

JSON is a lossy wire format for database values — it base64s or replacement-characters bytes, reformats times, and floats integers — and checkpoint/resume state is where those rewrites do maximum damage, because a corrupted cursor doesn't corrupt a cell you might notice: it relocates the walk, silently, at exit 0. Treat resume state as a codec: give every type family crossing the boundary an explicit representation decision (a tagged envelope beats per-type normalization — our normalization was itself the vector for the missed half), decode integers exactly, and pin the round-trip per PK family on real engines. And when your data path already has a hardened codec and a testing discipline, ask what other stores in the system quietly round-trip the same values without either — ours was the one that decides which rows get processed at all.

## Primary sources

- Go encoding/json — invalid UTF-8 in strings is replaced with U+FFFD on marshal; numbers decode as float64 without UseNumber; []byte marshals as base64; time.Time as RFC 3339.

- The 2026-07-15 repo audit, CRITICAL-2 and HIGH-1 — both observed on live MySQL 8.0, including the 0x9F8041FE10 → 0xEFBFBDEFBFBD41EFBFBD10 round trip.

- sluice v0.99.257 changelog — the tagged cursor envelope, exact-integer-first legacy parse, coded SLUICE-E-BACKFILL-CORRUPT-CURSOR, and the per-PK-family integration pins; ADR-0159 for the act-one normalization.

- sluice-testing session report v0.99.257 (F2, 71/71) — the live differential magnitudes: 73,100/100,000, the exact-68-row float64 window, 46,000/200,000 on the migrate path, and the legacy-trust proof.

- Companion field note — 253 is a database boundary now: the same family where the damage lands on a value instead of a position.

---
Canonical page: https://sluicesync.com/field-notes/json-cursor-teleport/ · Full docs index: https://sluicesync.com/llms.txt
