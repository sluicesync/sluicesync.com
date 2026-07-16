# Your dump reader is quadratic in a knob somebody else set — twice

> A dump reader's cost was quadratic in statement size — and statement size isn't the reader's variable, it's the --statement-size flag chosen by whoever took the dump. We found it, fixed it, benchmarked the fix, shipped "order-of-magnitude on the giant chunk" — and the same-day regression cycle measured no end-to-end difference at all, because the same complexity class lived one layer down, in a buffer sized to the statement tail. Two acts: the quadratic, and the quadratic that survived its own fix.

Observed — sluice's mydumper source engine, in two rounds: the statement splitter (2026-07-15 repo audit, MED-P1, measured; fixed v0.99.259) and the value decoder beneath it (Bug 191, filed by the v0.99.259 regression cycle the day the splitter fix shipped; fixed v0.99.261). Both were sluice's own bugs, and the second one is the reason this note exists: fidelity was byte-exact throughout — this is purely a wall-clock/complexity story, but one that crossed into a loud failure cliff before it was done.

## Act one: the carry-rescan splitter

A block-based statement splitter is the natural way to read a dump file: consume 1 MiB blocks, find statement boundaries, emit complete statements. The catch is that a boundary can't be recognized without lexer context — quotes, backtick identifiers, comments, and two-character delimiters (--, /*) all straddle block boundaries — so the easy correctness answer is: keep the unfinished statement tail (the &ldquo;carry&rdquo;), and on the next block, re-lex carry+block from byte 0.

That makes cost quadratic in statement size, not file size. And statement size belongs to the producer: mydumper's --statement-size flag (default ~1 MiB, raisable to tens of MiB by anyone chasing fewer round trips at load time). The audit measured it on identical bytes: 64 MiB as 64 default-sized statements read in 165 ms; as one statement, 2.52 s; double the statement and it quadruples (128 MiB = 9.86 s); ~40 s at the reader's named 256 MiB ceiling. A dump taken with --statement-size 64M read ~15&times; slower per byte than its default-sized sibling — no error, nothing to see but a slow restore.

The v0.99.259 fix persists the lexer state across blocks: a small state machine whose pending one-byte lookaheads replace the re-scan, so the trajectory — and every statement boundary — is independent of where reads fall, and each byte is examined exactly once. The fix commit's own benchmark: 2.23 s → 128 ms on the 64 MiB statement (~17&times;, 524 MB/s, on par with the 148 ms the same bytes cost as 64 statements). The verification craft is worth stealing: the old whole-input splitter stays in the codebase as a differential oracle, and the incremental lexer is pinned byte-identical against it for every token family spanning a block boundary at every offset (block sizes 1 through 8), plus a seeded-random backstop.

## Act two: the quadratic below the quadratic

The release notes said &ldquo;order-of-magnitude on the giant chunk.&rdquo; The same-day regression cycle built exactly that shape — a 49 MiB, 12,010-row single-statement dump — and measured: migrate 340.8 s on v0.99.259 vs 348.9 s on v0.99.258. verify --depth count, which isolates the source read: 354&ndash;377 s vs 334&ndash;369 s across three runs each. No differential. The splitter really was linear as claimed — its re-lex accounted for only ~2&ndash;3 s of the ~350 even on the old binary.

Bisection fit the remaining cost to rows &times; statement_size at ~1.8 GB/s effective: 750 rows &times; 49 MiB → 20.4 s; 12,000 rows &times; 3 MiB → 22.5 s; the same rows split into 12 &times; 4 MiB statements → 29.1 s. One layer below the splitter, the quoted-string value decoder allocated each value's output buffer as make([]byte, 0, len(s)) — where s was the remaining statement tail from the value's opening quote. Roughly 25 MiB of capacity, zeroed, for every ~4 KiB value: about 300 GB of large-object allocation churn per chunk. Same class, same producer-owned knob, different layer.

Fixing it (v0.99.261) surfaced two things the first act had framed too narrowly:

- The default shape paid the tax too. Generalizing the scanner over the quote character exposed a worse same-class sibling in the double-quote path — which is mydumper &ge;1.0's default emit shape — copying the entire tail into a fresh allocation per value. Even default ~1 MiB statements paid rows &times; ~0.5 MiB average; the &ldquo;only raised --statement-size dumps are affected&rdquo; framing was itself a layer-one conclusion.

- The perf class had crossed into a correctness cliff. The decode stall starved the in-flight LOAD DATA stream past the target's net_read_timeout (30 s on the rig): v0.99.258 failed deterministically — 2 of 2 runs — on the gzipped twin of the same dump with Error 1159 (08S01): Got timeout reading communication packets. v0.99.259's splitter work moved the stall back under the cliff at that size; only v0.99.261 bounds the gap by value size instead of statement size (the changelog honestly says &ldquo;plausibly closed&rdquo; — larger values still cost what they cost).

The v0.99.261 decoder pre-scans to the closing quote with the same escape grammar, then sizes the buffer to the value. And this time the benchmark is at the pipeline level: end-to-end row reads on a 16 MiB statement went 1.81 s / 34.4 GB allocated → 75 ms / 139 MB, linear through 48 MiB. Byte-exactness is pinned by a million-input differential fuzz against the old decoder as oracle, plus the delimiter &times; escape-shape matrix — and the regression cycle's fidelity oracle for the whole path was the MySQL server itself parsing the same statements (a three-way digest match, both binaries against server truth).

## Reproducing it

Take the same data twice with real mydumper and time the reads:

    docker run --rm --network host mydumper/mydumper:v1.0.3-1 \
      mydumper -h 127.0.0.1 -u root -p secret -B mydb -o /dump-default          # ~1 MiB statements
    docker run --rm --network host mydumper/mydumper:v1.0.3-1 \
      mydumper -h 127.0.0.1 -u root -p secret -B mydb -o /dump-64m -s 64000000  # one giant statement per chunk

    time sluice verify --depth count --source-driver=mydumper --source ./dump-64m \
      --target-driver=mysql --target '<dsn>'   # isolates the source read

On a table with &ge;5k normal-size rows and a 16 MiB+ single statement: sluice &le; v0.99.258 is quadratic at both layers; v0.99.259/260 shows little end-to-end change on many-row giant statements (the act-two shape); &ge; v0.99.261 reads both dumps at the same per-byte rate. To see the cliff, gzip the giant dump's chunks and load into a MySQL with net_read_timeout at its 30 s default — v0.99.258 aborts with Error 1159.

## The transferable lesson

Two, one per act. Any incremental parser that re-scans its carry — or sizes work against its remaining input — is quadratic in its largest token, and the largest token's size may be a flag somebody else set at dump time; your complexity class has an owner, and it might not be you. And a complexity-class fix needs an end-to-end measurement, because the same class can live at more than one layer of the same path: we fixed the layer, benchmarked the layer, and the pipeline stayed quadratic. Benchmark the pipeline. (The write-side twins of this class are already published: rewriting a whole manifest per chunk, and re-encoding a growing state blob per checkpoint — those grow an object once per write; this one re-paid a growing tail once per value.)

## Primary sources

- sluice v0.99.259 changelog (the linear splitter, with the oracle-pin methodology) and v0.99.261 changelog (Bug 191: the value-decoder fix, the pipeline-level 1.81 s → 75 ms numbers, the double-quote sibling, the million-input differential fuzz).

- The 2026-07-15 repo audit, MED-P1 — the measured 165 ms / 2.52 s / 9.86 s quadratic confirmation.

- sluice-testing Bug 191 and session report v0.99.259 (F1/F5) — the no-differential measurement, the rows &times; statement_size bisection, the ~300 GB allocation figure, and the deterministic Error 1159 cliff.

- mydumper documentation — --statement-size (-s).

- Companion field notes — backup-manifest-quadratic and migrate-state-quadratic-blob (the write-side quadratic twins), mydumper-format-family (--statement-size as one more producer axis).

---
Canonical page: https://sluicesync.com/field-notes/quadratic-in-a-knob-somebody-else-set/ · Full docs index: https://sluicesync.com/llms.txt
