# The round-trip test that cannot see symmetric bugs

> Write false, the file says NULL, read it back as false — green. A writer bug whose read-back is symmetric is invisible to every round-trip test, and the general condition is worse than one bug: if your writer and every test pin read through the same library, the entire format boundary is self-consistent, and a symmetric regression ships files the rest of the world can't read while your suite stays green. The fix isn't another test; it's an outside reader. And the checker we built to be that reader promptly demonstrated the class inside its own harness.

Observed — sluice's Parquet export boundary, flagged by the 2026-07-15 repo audit (MED-T3): the writer and every read-back pin were the same parquet-go v0.30.1, with the advertised consumer (DuckDB) appearing in no gate. The class it guards against is prospective — an independent DuckDB probe run during the audit verified today's compatibility exact — but the shape had already fired once for real: the published parquet-zero-value-null note, where the library nulled every Go zero value and the round-trip read it back as the zero value, green. The external-reader gate shipped in v0.99.259.

## What happened

sluice's backup export-as-parquet had, by the audit's count, a model test suite at the value level: every type family &times; shape pinned, the zero-value wart pinned from both sides, refusals coded. And all of it — writer and every reader in every pin — went through parquet-go v0.30.1. That's self-consistency, not correctness. A future library upgrade that broke the format symmetrically — a logical-type annotation dropped on write and ignored on read, an encoding both directions misinterpret identically — would keep every pin green while shipping files DuckDB and Spark can't decode.

One concrete stake makes it vivid: if the UINT_64 logical-type annotation stopped surviving, uint64 max (18446744073709551615) reads back as -1 in any reader that honors the physical int64 without the annotation. sluice's own round trip would never notice; both sides would agree on the annotation's absence.

## The structural fix: something else does the reading

v0.99.259 added a CI gate that is deliberately not another parquet-go test: a deterministic family &times; shape matrix — uint64 max, &minus;0.0 (signbit), NaN/&plusmn;Inf, denormals, all three DECIMAL physical tiers, microsecond temporals, JSON, empty-vs-NULL, array element families, row-group placement, footer metadata including the GeoParquet CRS — is generated through the real export codec and read back with real DuckDB, comparing values exactly. At gate-landing time: 15/15 checks under DuckDB v1.5.4, including DuckDB-spatial auto-decoding the GeoParquet column to POINT (1 2).

One deliberate choice inverts normal CI hygiene: the workflow runs duckdb/duckdb:latest, unpinned. A pinned reader would freeze the gate at today's ecosystem; unpinned, the ecosystem's reader drifts into the gate instead of past it — if a future DuckDB stops accepting something sluice writes, the gate goes red, which is exactly the news it exists to deliver. (The cost — an upstream DuckDB regression can redden sluice's CI — is why it's a non-required workflow.)

## The recursive kicker

The checker compares DuckDB's output against expected values stored in a JSON file. Its first cut decoded that file with encoding/json's default path — where every number is float64 — so 18446744073709551615 became 18446744073709552000 inside the verification harness itself: the exact mangling class the gate exists to catch on the DuckDB side, reproduced in the tool built to catch it. Fixed with UseNumber, then pinned with a test asserting that the float64-rounded near-miss must fail the comparison — the harness now proves it can distinguish the values it was built to protect.

That beat is the note's thesis in miniature: every comparison harness is one more codec, and a codec can be wrong. (It's also the uint64 twin of our published int64-json-boundary class.)

## Reproducing it

The harness bug is four lines of Go, no database required:

    var v []map[string]any
    json.Unmarshal([]byte(`[{"u":18446744073709551615}]`), &v)
    fmt.Println(v[0]["u"])   // 1.8446744073709552e+19 — float64, exactness gone
    // json.NewDecoder(...).UseNumber() preserves it as the literal "18446744073709551615"

The boundary check itself, against any sluice Parquet export (DuckDB CLI):

    SELECT typeof(u), u FROM read_parquet('export/native.parquet') LIMIT 1;
    -- want: UBIGINT, 18446744073709551615 — a reader that lost the UINT_64
    -- annotation reports BIGINT and -1

    SELECT DISTINCT row_group_id, row_group_num_rows
    FROM parquet_metadata('export/native.parquet');
    -- one row group per source chunk: the alignment contract as an external reader counts it

And the class demonstration needs no bug at all: write any value your library round-trips through a lossy representation (the published zero-value case: false → NULL → false), and observe that a write-then-read-with-the-same-library test is green by construction.

## The transferable lesson

A format boundary is only tested when something on the other side does the reading. Round-trip tests through one library verify that library's self-consistency — necessary, and structurally incapable of seeing symmetric bugs, which are exactly the bugs a library upgrade introduces. If a file format is your product's interface, put a reader you don't ship into the gate, feed it your worst values (the extremes, the annotations, the metadata — not the happy middle), and consider leaving its version unpinned so the ecosystem drifts into your tests rather than past them. Then apply the same skepticism to the checker: its own deserialization path is a codec too, and the first value it mangles will be one of the extremes you chose it to protect.

## Primary sources

- sluice v0.99.259 changelog — the DuckDB parquet-compat CI workflow (matrix contents, exact-value comparison, unpinned latest).

- The 2026-07-15 repo audit, MED-T3 — the self-consistent-boundary finding, including the audit's own independent DuckDB probe verifying today's compatibility.

- sluice's duckdbverify harness — the UseNumber comment and the uint64-near-miss-must-fail pin (TestWant_Uint64SurvivesTheJSONRoundTrip: &ldquo;the first cut decoded checks.json with plain Unmarshal and 18446744073709551615 became &hellip;552000&rdquo;); the UBIGINT stake (&ldquo;without the UINT_64 annotation surviving, uint64 max reads as -1&rdquo;).

- Companion field notes — parquet-zero-value-null (the symmetric-bug shape observed for real; this note is its constructive sequel), int64-json-boundary (the checker's own bug is that class's uint64 twin), verifier-rode-the-same-reader (the same independence principle at the dump-reader boundary).

---
Canonical page: https://sluicesync.com/field-notes/round-trip-cannot-see-symmetric-bugs/ · Full docs index: https://sluicesync.com/llms.txt
