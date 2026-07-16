# The dump reader skipped what it couldn't lex — and the verifier rode the same reader

> A statement-splitting dump reader dispatched on the first token and let anything that lexed empty fall through as "comment-only." A UTF-8 BOM glued to the first INSERT made it lex empty: the whole statement vanished at exit 0. And verify --depth count counted through the identical blind spot, so the safety net confirmed the loss instead of catching it. Then the fix's own third act: the refusal reached verify's report but not its exit code.

Observed — the 2026-07-15 repo audit's CRITICAL-1 finding against sluice's mydumper source engine, exhibited live on the shipped binary by the v0.99.257 regression cycle (both scenarios, exact row counts below). This is a confession note: the exposure window was v0.99.247&ndash;v0.99.256, the engine's entire published life. The reader fix shipped in v0.99.257; the verify exit-code half (Bug 190) followed in v0.99.258.

## What happened

A mydumper-format dump is a directory of .sql chunk files, each a stream of statements. sluice's reader split each chunk into statements, lexed the leading keyword, and switched on it: INSERT streams rows, SET hits the session-header gates, and — the load-bearing default — any other statement refuses loudly. Except one arm: a statement whose keyword lexed to the empty string was treated as a comment-only fragment and skipped, without verifying it actually was one.

Two mundane inputs weaponize that posture:

- A UTF-8 BOM (EF BB BF) at the start of a chunk. mydumper itself never writes one — but PowerShell and plenty of Windows editors prepend it on re-save. The BOM glues itself to the first statement, its keyword lexes empty, and the entire first INSERT — up to ~1 MiB of rows at mydumper's default statement size — silently vanishes. &ldquo;Bulk copy complete,&rdquo; exit 0.

- A severed INSERT tail — (2,'b'),(3,'c');, the classic torn-dump shape. Digits don't lex as a keyword; the fragment's rows vanish the same way.

The knife-twist is the verifier. sluice verify --depth count counted source rows through the same processChunk dispatch as the copy path — so it re-counted through the identical blind spot and reported the short counts as matching. The audit's phrasing stuck: the safety net confirms the loss instead of catching it.

Note the irony in the design: the engine's default branch was &ldquo;ANY other statement refused loudly&rdquo; — but that refusal was unreachable for exactly the statements that don't lex to a keyword. The loud-failure posture existed; the skip arm sat in front of it.

## The live differential

The v0.99.257 regression cycle ran both shapes on real mydumper v1.0.3 dumps (10-row table), shipped binaries both sides:

    scenario                      v0.99.256                     v0.99.257
    ------------------------      --------------------------    -----------------------------
    BOM on header-less chunk      rc=0, 5 of 10 rows land;      BOM WARN, all 10 rows, md5
                                  verify --depth count rc=0     exact, verify clean
                                  CONFIRMS the loss
    severed fragment spliced      rc=0, 8 of 10 rows;           migrate refuses rc=1 naming
    between INSERTs               verify confirms               the chunk file + a quoted
                                                                head of the offending bytes
    pure-comment fragment         clean                         clean (no false refusal)

One more shape from the same cycle: a BOM on a chunk with headers glued to the leading /*!40101 SET NAMES&hellip;*/ line — no row loss there, but a session header silently vanishing is the same skip class.

## The third act — loud in the text, silent in the exit code

The v0.99.257 fix made the verify door inherit the refusal — and the same cycle found that on the torn dump, verify printed the refusal in its table row (t SKIPPED (source count error: &hellip; does not begin with a SQL keyword &hellip;)) and still exited 0. Verify's exit policy counted only count mismatches; any per-table count error landed as an informative skip. An rc-gated verify — a script, a CI job — passed while a table was never verified. That was filed as Bug 190 and fixed as a class in v0.99.258: every table verify could not examine (count error either side, sample-hash error, missing-on-target) now counts toward a tables_unverified failure class and the run exits 2, with the summary trailer stating &ldquo;an unverified table is not a pass; non-zero exit code follows.&rdquo; Mismatches keep exit 1; deliberate --exclude-table exclusions stay exit-neutral.

## What sluice does about it

Since v0.99.257: a leading BOM is stripped losslessly with a WARN (matching the flat-file engines' posture; data-chunk and schema paths both), any other keyword-less non-comment fragment refuses loudly naming the file and a quoted 40-byte head of the bytes, and unterminated /*!NNNNN versioned comments refuse instead of silently skipping. The skip arm is now reserved for provably-inert content — pure comments and whitespace. Since v0.99.258, verify's exit code tells the truth about what it couldn't check.

## Reproducing it

Seconds to observe, on any mydumper dump (real ones via docker run mydumper/mydumper:v1.0.3-1). Splice a fragment into a data chunk:

    printf '(999,"x");\n' >> dump/mydb.t.00000.sql   # or splice mid-file

    # sluice <= 0.99.256: migrate rc=0, fragment rows silently absent;
    #                     verify --depth count rc=0 confirms the short count
    # sluice  = 0.99.257: migrate refuses rc=1 naming the file + bytes;
    #                     verify PRINTS the refusal but exits 0  (Bug 190)
    # sluice >= 0.99.258: verify exits 2 — "1 could not be verified"
    sluice migrate --source-driver=mydumper --source ./dump --target-driver=mysql --target '<dsn>'
    sluice verify  --depth count --source-driver=mydumper --source ./dump --target-driver=mysql --target '<dsn>'; echo $?

For the BOM half: re-save any chunk through PowerShell's default Set-Content, or printf '\xef\xbb\xbf' | cat - chunk.sql > bom.sql.

## The transferable lesson

Two, one per act. In a statement stream, &ldquo;skip what you don't recognize&rdquo; is the silent-loss posture: a skip must be reserved for content you can prove inert, and everything else refused naming the bytes — otherwise your loud-failure default is unreachable for exactly the inputs that need it. And a verifier that shares its reader with the copy path inherits every one of the reader's blind spots — it can only catch loss introduced downstream of the shared parse. After you fix the reader, check the verifier's exit-code contract too: &ldquo;loud in the text, silent in the rc&rdquo; is the same confirming-not-catching failure one layer up. A detector that cannot examine a table must not report overall success.

## Primary sources

- sluice v0.99.257 changelog (the fragment refusal + BOM strip) and v0.99.258 changelog (Bug 190, the tables_unverified exit-2 class).

- The 2026-07-15 repo audit, finding CRITICAL-1 — observed via the shipped binary, three independent end-to-end repros.

- sluice-testing session reports v0.99.257 (F1, the live differential table above) and v0.99.258 (F2, Bug 190 closed on every door).

- Unicode/UTF-8 — the byte-order mark EF BB BF; mydumper writes none, Windows tooling adds them on re-save.

---
Canonical page: https://sluicesync.com/field-notes/verifier-rode-the-same-reader/ · Full docs index: https://sluicesync.com/llms.txt
