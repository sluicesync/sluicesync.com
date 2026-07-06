# Verify & reconcile after a migration

> Confirm every row landed and no structural drift crept in — then know exactly what to do when it didn't.

Preview & validate is the pre-migration companion to this guide: it shows the DDL and steers translation before a row moves. This guide is the post-migration half — after migrate finishes, or after a sync has caught up, you want proof that the data actually landed and that the target's shape still matches what sluice would produce. Two read-only commands give you that proof: verify compares the rows, schema diff compares the structure. Both exit non-zero on a discrepancy, so either one drops straight into a cron job or a CI gate.

## 1. Verify the rows landed

verify compares the data itself, on a depth ladder — start cheap, escalate only when you need a stronger guarantee. It never writes to the target.

Depth · What it does ·

--depth count (default) · Per-table row-count comparison. Fast, works across engines, and catches whole-table loss and bulk-row loss. ·

--depth sample · Counts plus per-table sampled-row content hashes — ~99% confidence of catching a 5%+ corruption rate at the default 100 rows/table. Same-engine only (see below). ·

For a cross-engine migration (MySQL → Postgres and the like), count is the mode you run. Server-side row hashing renders values in each engine's own text format, so a cross-engine sample would report false mismatches; sluice refuses --depth=sample loudly when the source and target engines differ rather than hand you a misleading result. Sample mode is for same-engine checks (MySQL → MySQL, Postgres → Postgres).

    # cross-engine: row-count parity, the everyday post-migrate check
    sluice verify --source-driver mysql    --source "$SLUICE_SOURCE" \
                  --target-driver postgres --target "$SLUICE_TARGET" \
                  --depth count

    # same-engine: escalate to sampled content hashing
    sluice verify --source-driver postgres --source "$SLUICE_SOURCE" \
                  --target-driver postgres --target "$SLUICE_TARGET" \
                  --depth sample --sample-rows-per-table 500

Tune sample mode with --sample-rows-per-table (raise it for tables with rare anomalies), --sample-seed (deterministic — the same seed picks the same rows on both sides; change it to reshuffle), and --strict-hash (SHA-256 instead of MD5, for an extra confidence margin or a compliance posture that requires it). Scope any run with --include-table / --exclude-table (glob-aware, mutually exclusive).

Full per-row hashing is planned, not yet shipped. Today the ladder stops at sample; count plus a well-sized same-engine sample is the strongest check available.

## 2. JSON output and cron-friendly exit codes

Both depths accept --format json and -o FILE, so verify pipes cleanly into a CI gate or an alertmanager pipeline. The JSON carries per-table deltas — source vs target counts, sampled-row count, and the mismatched primary keys when sample mode finds drift — so you get the offending rows, not just a red/green.

    sluice verify --source-driver mysql    --source "$SLUICE_SOURCE" \
                  --target-driver postgres --target "$SLUICE_TARGET" \
                  --depth count --format json -o verify.json

The exit code is the contract for automation:

Exit · Meaning ·

0 · Clean — every checked table matched. ·

1 · Mismatch — at least one table differs (a count delta, or a sampled-row hash mismatch). ·

2 · Operational error — couldn't connect, unsupported engine, bad flags. Distinct from 1 so a gate never conflates "the data differs" with "the check couldn't run". ·

Redacted migrations. If you migrated with --redact, the target values differ from the source by design — so a same-engine --depth=sample run will report those rows as content mismatches. Verify redacted migrations with --depth=count (row parity is still meaningful), or scope the sample to unredacted tables with --include-table.

## 3. Confirm no structural drift

Row parity doesn't prove the shape is right — an index that failed to build, a column that came back with the wrong type, a constraint that never applied. schema diff reads the live target and compares it against what sluice would produce from the source, then prints the delta with copy-paste DDL suggestions to reconcile it. It's read-only — there is no --apply flag by design (ADR-0029); the DDL is for you to review and run. Like verify, it exits non-zero on any difference.

    sluice schema diff --source-driver mysql    --source "$SLUICE_SOURCE" \
                       --target-driver postgres --target "$SLUICE_TARGET"

Its exit codes mirror verify: 0 clean, 1 drift detected (the gate fails; a one-line summary goes to stderr, the full diff to stdout or -o FILE), 2 operational error. Trim the noise when part of the target is managed out-of-band: --ignore-charset-collation suppresses MySQL charset/collation diffs, --ignore-extras hides tables/columns/indexes that exist only on the target, and --skip-views drops view comparison entirely. --format json is available for CI. If you steered any types at migrate time with --type-override, pass the identical flags here so the diff compares against the schema you actually intended.

## 4. What to do on a mismatch

A non-zero exit tells you where — the table, and (in sample mode) the mismatched primary keys. From there:

- Structural drift (schema diff flagged it). Read the suggested DDL. If it's a missing index or constraint on an otherwise-correct table, applying the suggestion is often enough. If a column type is wrong, fix it with a --type-override and re-migrate that table rather than hand-patching.

- A count shortfall on a fresh migration. Re-run migrate. A plain re-run is idempotent for tables that copied cleanly and fills the gap. If the target table is in a partially-written state you want to discard, migrate --reset-target-data is the destructive recovery: it deletes the migrate-state row, drops every source-schema table on the target, and runs a fresh cold-start (it prompts for confirmation — type reset, or pass --yes in automation). See ADR-0023.

- A drift that appears on a running sync. The equivalent recovery is sync start --reset-target-data — drop the target, restore, then transition back to live polling. Don't reach for it on a transient lag; let the sync catch up and re-verify first.

- The mismatch is on the source side. If verify reports the target has more rows, or the counts drift on every re-run, suspect the source: rows written after the copy started, a source table still taking writes without a sync, or a filter (--include-table) that differs between the migrate and the verify. Re-verify with the same table scope you migrated.

## 5. Symptom → first look

Symptom · First look ·

verify --depth=count exits 1, target has fewer rows · Re-run migrate; if partially written, migrate --reset-target-data. ·

Target has more rows than source · Source took writes after the copy — reconcile the window, or move to continuous sync before cutover. ·

--depth=sample exits 1 on a redacted migration · Expected — redacted target content differs. Use --depth=count. ·

verify exits 2 (not 1) · Operational, not data: connectivity, engine name, or flags. Check the DSNs and --*-driver values. ·

schema diff exits 1, missing index/constraint · Apply the suggested DDL from the diff output. ·

schema diff flags a wrong column type · Re-migrate the table with a --type-override; don't hand-patch. ·

--depth=sample refused for a cross-engine pair · By design — use --depth=count across engines. ·

## Next steps

- Preview & validate before you migrate — the pre-migration half: DDL preview and type steering.

- Command reference: verify and schema preview / diff — every flag in one place.

- Zero-downtime migration (continuous sync) — when the source keeps taking writes, verify after the sync catches up.

---
Canonical page: https://sluicesync.com/docs/verify-reconcile/ · Full docs index: https://sluicesync.com/llms.txt
