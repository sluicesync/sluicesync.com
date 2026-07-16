# The index that shares only a name

> Idempotent index builds are detect-then-skip: if an index with the intended name already exists on the target, skip the build. But a name is not a definition — and index names live in a tiny convention-driven namespace (idx_email, uq_name). The sharpest cell is uniqueness: when the source's UNIQUE index name-matches a plain INDEX on the target, the existing definition silently decides which duplicate writes the target accepts or refuses. Every step exits green.

Observed — the 2026-07-15 repo audit (MED-D0-8) against sluice's MySQL index-build paths, both the direct build and the deploy-request fallback; then exhibited both-sides on real MySQL by the v0.99.260 regression cycle (the differential below). This was sluice's own skip logic trusting a name; the advisory WARN shipped in v0.99.260. It's the index-level twin of the table-shape gate that shipped two releases earlier (ADR-0166): &ldquo;already exists&rdquo; is not &ldquo;already correct.&rdquo;

## What happened

Migration tools re-run. Resume flows, retries, and pre-provisioned targets all mean the index-build phase routinely finds indexes already present — so every tool's build is detect-then-skip: probe the target catalog for the intended name, skip if found. sluice's probe checked existence by name only. A pre-existing index that merely shares the intended name — different columns, different prefix lengths, or crucially different uniqueness — was silently accepted as &ldquo;already built.&rdquo;

For most definition drift the consequence is query plans that don't match what the operator thinks they migrated. Uniqueness is the cell with teeth, and it cuts both directions:

- Source has UNIQUE KEY uq_name(name), target has a plain KEY uq_name(name): the target now accepts duplicate names the source could never hold. The divergence surfaces later as data the application assumes impossible.

- The inverse — plain on the source, UNIQUE pre-created on the target — means the target rejects inserts the source legally performed, as constraint violations during sync or a later write.

Either way, the migration exits green: the copy is exact, the index build reports success (it skipped), and the difference is invisible until data exercises it.

## The live differential

The v0.99.260 regression cycle ran it on real MySQL: source table with UNIQUE KEY uq_name(name), target pre-created from sluice's own captured DDL with the index demoted to a plain KEY uq_name(name).

    binary       outcome (same rc=0, same exact data md5 both sides)
    ---------    -----------------------------------------------------------
    v0.99.259    silent skip — zero WARN lines; the target index stays
                 non-unique with no signal anywhere
    v0.99.260    dedicated WARN: "an index with this name already exists
                 with DIFFERENT UNIQUENESS — the build skips it, so the
                 EXISTING definition decides which duplicate writes the
                 target accepts or refuses" with index=uq_name
                 existing_definition=(name) intended_definition="UNIQUE (name)"

A different-column collision gets the general WARN naming both definitions; the same-name-same-definition control stays silent on both binaries (no WARN noise on the healthy path). Deliberately a WARN and not a refusal: a differing definition can be intentional operator tuning — a wider covering index, an adjusted prefix — which is exactly what detect-then-skip exists to respect. The advisory costs one information_schema.statistics read per table that had skips, and a probe failure degrades to DEBUG rather than failing a build the existence check already green-lit.

## The compare is a tour of MySQL catalog quirks

Deriving &ldquo;is the existing definition the one I would have built?&rdquo; from information_schema.statistics turned out to be its own field trip, ground-truthed on real MySQL during the fix:

- A SPATIAL index reports a SUB_PART of 32 nobody asked for — catalog noise, not part of any buildable definition; compare it literally and every spatial index false-drifts.

- FULLTEXT/SPATIAL indexes silently shed UNIQUE and per-column prefixes at DDL-emit time (insist and you get Error 1089) — so the intended side of the compare has to drop them too, mirroring the emitter's rules rather than the raw schema.

- DESC key parts don't appear as a direction flag: they hide in COLLATION='D'.

- Functional key parts surface as NULL COLUMN_NAME and can only be matched positionally — MySQL normalizes the expression text, so a byte-compare false-flags spellings that are equal.

Every one of those is a way an honest definition compare either misses drift or invents it. The namespace being conventional is what makes the class common; the catalog being quirky is what makes the fix nontrivial.

## Reproducing it

Any MySQL, two minutes (this is the regression-cycle fixture):

    -- source
    CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(50), val INT,
                    UNIQUE KEY uq_name (name), KEY idx_val (val));

    -- pre-create the target table identically EXCEPT the index clause:
    --   UNIQUE KEY uq_name (name)  ->  KEY uq_name (name)

    sluice migrate --source-driver=mysql --source '<src>' --target-driver=mysql --target '<dst>'
    # <= v0.99.259: rc=0, no signal; SHOW INDEX FROM t on the target: uq_name NON_UNIQUE=1
    # >= v0.99.260: rc=0, same data, plus the DIFFERENT-UNIQUENESS WARN naming both definitions

    -- then demonstrate the consequence the WARN names:
    INSERT INTO t VALUES (100,'alice',1),(101,'alice',2);   -- target accepts; source never could

## The transferable lesson

This is the third member of a family: existence checks that answer a different question than the one you asked. CREATE &hellip; IF NOT EXISTS answers &ldquo;did a create race me?&rdquo; without atomicity; a platform's statement-class gate answers &ldquo;is this statement allowed?&rdquo; rather than &ldquo;is this effect safe?&rdquo;; and a name probe answers &ldquo;does something called this exist?&rdquo; when the build needs &ldquo;does this definition exist?&rdquo;. Whenever idempotency is implemented as detect-then-skip, the detection must compare what the skip is trusting — and for indexes specifically, uniqueness is a data-integrity property wearing a performance object's clothes: it decides what writes are legal, so drifting it silently is a correctness bug, not a tuning difference. &ldquo;Already exists&rdquo; is not &ldquo;already correct.&rdquo;

## Primary sources

- sluice v0.99.260 changelog — the index definition-drift WARN (columns, prefix, direction, uniqueness; direct build and deploy-request fallback alike); the 2026-07-15 audit finding MED-D0-8.

- sluice-testing session report v0.99.260 (F1) — the live both-sides differential and exact WARN wording on real MySQL.

- MySQL documentation — information_schema.statistics (SUB_PART, COLLATION, NULL COLUMN_NAME for functional key parts) and Error 1089; the catalog quirks above were ground-truthed on real MySQL including prefix+DESC, functional, and spatial indexes.

- sluice ADR-0166 — the table-shape gate (&ldquo;already exists &ne; already correct&rdquo; one level up); companion field note CREATE IF NOT EXISTS is not a lock (the family's atomicity member).

---
Canonical page: https://sluicesync.com/field-notes/index-that-shares-only-a-name/ · Full docs index: https://sluicesync.com/llms.txt
