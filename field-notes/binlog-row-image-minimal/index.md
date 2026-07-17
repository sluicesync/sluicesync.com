# The platform default that eats every UPDATE

> Point a MySQL CDC pipeline at Azure Database for MySQL and the cold copy is exact, the stream stays green, the counts stay equal — and every UPDATE silently vanishes. The cause is a one-line server default nobody set on purpose: Azure ships binlog_row_image=MINIMAL, and under MINIMAL an UPDATE's before-image carries only the primary key. Azure is the first major managed platform to make MINIMAL the out-of-box posture.

Observed — a live probe of a throwaway Azure Database for MySQL Flexible Server (8.0.45-azure, defaults, 2026-07-16) on the shipped v0.99.263 binary; filed as Bug 193, fixed and closed in v0.99.266. The silent-loss half was demonstrated end to end: twelve source UPDATEs, zero target changes, on a stream that reported healthy the whole time. This is the MySQL sibling of an earlier Postgres note — same class, different engine, different knob.

## What happened

binlog_row_image controls how much of a row MySQL writes into a ROW-format binlog event. Under the stock default, FULL, an UPDATE logs the complete before-image (every column's old value) and the complete after-image. Under MINIMAL, the server logs only the columns it needs: the primary key in the before-image, and only the changed columns in the after-image. It is a bandwidth optimization, and for MySQL-to-MySQL replication where both ends agree on the row identity, it is harmless.

For a CDC applier that reconstructs an UPDATE as UPDATE target SET ... WHERE <old row>, it is not harmless. sluice built its WHERE clause from the full before-image. Under MINIMAL every non-PK column in that before-image arrives as nil — not &ldquo;NULL the value,&rdquo; but &ldquo;absent from the event&rdquo; — and the applier turned each absent column into a col IS NULL predicate. The resulting WHERE matched no real row. And here the second mechanism closes the trap: a CDC applier must tolerate an UPDATE that affects zero rows, because on a warm resume it may replay a change already applied, and refusing zero-row updates would wedge every resume. So the zero-row miss was swallowed by design, logged at DEBUG and nowhere else. The stream stayed green, the lifetime row counts stayed equal, and the content quietly diverged.

The live numbers make the shape concrete: twelve UPDATEs on the source produced zero changes on the target, while INSERTs and DELETEs in the same batches applied fine. Eleven rows of 4997 ended up diverged — about 0.2%. verify --depth sample at its default 100-row draw passed over that divergence; only full-table sampling named the diverged primary keys. A safety net calibrated for 5%-scale corruption cannot see a 0.2% one.

## The irony inside our own code

sluice had already fixed this exact class — for DELETE. An earlier bug (Bug 88) taught the DELETE path that a MINIMAL before-image is PK-only, and its narrowing helper carries a comment that spells out the whole nil → IS NULL → zero-match → silent-divergence chain. The narrowing lived one switch-case above the UPDATE arm and never reached it. Fixing the instance and not the class, inside the same function: the DELETE path knew the danger by name while the UPDATE path a few lines down walked straight into it.

## The trap waiting for the fixer

The naive fix — narrow the UPDATE's WHERE to the primary key, the way DELETE was fixed — converts a silent skip into a silent corruption. MINIMAL's after-image also omits unchanged columns. So a PK-narrowed UPDATE would SET every after-image column, and the columns MINIMAL left out would be written as NULL, nulling out data the UPDATE never touched. &ldquo;Nil because absent from the event&rdquo; and &ldquo;nil because the value is NULL&rdquo; are different facts that look identical in a decoded row, and telling them apart requires the binlog's present-columns bitmap, not the value. The fix has to restrict the SET list to columns actually present in the event.

## Same class, one variable over: PARTIAL_JSON

Setting binlog_row_image=FULL is not the end of the family. A sibling option, binlog_row_value_options=PARTIAL_JSON (MySQL 8.0.3+), makes the server log in-place JSON updates as diffs — PARTIAL_UPDATE_ROWS_EVENTs carrying JSON_SET/JSON_REPLACE/JSON_REMOVE deltas — rather than whole column values. An applier that writes whole values silently drops the update, even under FULL row images. Proven live: an in-place JSON_SET under PARTIAL_JSON left the target at its old value on a green stream — the identical symptom as MINIMAL, one knob to the left of the headline knob. The lesson generalizes: any server option that lets MySQL log less than a whole value is a silent-loss surface for a value-reconstructing applier, and the row-image knob is only the loudest member of the set.

## What sluice does about it

Since v0.99.266, a coded preflight (SLUICE-E-CDC-ROW-IMAGE-PARTIAL) reads @@GLOBAL.binlog_row_image at every CDC start — the sync snapshot opener, so a cold start refuses before the bulk copy rather than after; warm resume; and backup incremental. When it is not FULL, the run refuses loudly and names the remedy: SET GLOBAL binlog_row_image=FULL, or on Azure az mysql flexible-server parameter set --name binlog_row_image --value FULL (dynamic, about 19 seconds, no restart, after which UPDATEs converge exactly). NOBLOB refuses too. The PARTIAL_JSON option gets its own preflight, read tolerantly — the variable does not exist before MySQL 8.0.3, and a read failure must not itself refuse — with the SET GLOBAL binlog_row_value_options='' remedy.

Behind the preflight sits a defense-in-depth belt keyed on the present-columns bitmap, for any partial image that slips a session-level override the global preflight couldn't see. The belt carries one more subtlety worth stating, because it is where identity and visibility diverge. It refuses a partial image that skipped a column — but on DELETE it must fire only on the PK-less case. With a real primary key the before-image always carries the PK, so MINIMAL images are correct by construction and belting there would regress the working replay of MINIMAL-era DELETE segments. The trap is a table with a UNIQUE NOT NULL column but no declared primary key: MySQL keys its MINIMAL before-image on that unique index (the &ldquo;primary key equivalent&rdquo;), which a WHERE index_name = 'PRIMARY' catalog lookup cannot see — so the applier thinks the table is keyless, keeps the nil-filled columns, and zero-matches silently. A truly keyless table's MINIMAL before-image, by contrast, carries every column (there is no PKE to minimize toward), skips nothing, and must still replay. The belt is placed exactly where the identity MySQL logged is not the identity a PRIMARY-only lookup can reconstruct.

## Reproducing it

Requires a MySQL 8.0+ server you can set globals on (any local container works; Azure Database for MySQL reproduces it out of the box with no configuration at all):

    SET GLOBAL binlog_row_image = MINIMAL;   -- Azure's default; stock MySQL default is FULL
    -- cold-copy a table, start CDC, then on the source:
    UPDATE t SET note = 'changed' WHERE id = 200;
    -- the before-image carries only the id column; every other column is absent (nil)
    -- a WHERE built from the full before-image emits note IS NULL, matches nothing,
    -- and a zero-rows-affected UPDATE is tolerated for resume idempotency -> silent drop

On Azure specifically: SELECT @@binlog_row_image; returns MINIMAL on a fresh Flexible Server. Watch a handful of UPDATEs apply as zero target changes while INSERT/DELETE in the same run land correctly, and confirm verify --depth sample passes over the divergence at its default draw. Setting binlog_row_image=FULL (dynamic, no restart) makes subsequent UPDATEs converge.

## The transferable lesson

The row image decides whether your UPDATEs can be matched on the target, and replay tolerance — the thing that makes resumes safe — is exactly what hides the miss when they can't. When a managed platform's default differs from stock, treat that default as part of the wire contract, not an operator choice you can assume away: Azure's out-of-box MINIMAL means every Azure-MySQL sync source hits this on the first run. And when you fix a silent-match class, fix it for every statement kind that reconstructs a row, not the one that crashed — the DELETE arm knowing this by name while the UPDATE arm a few lines down did not is how a fixed bug reappears under a different verb.

## Primary sources

- MySQL Reference Manual — binlog_row_image (FULL/MINIMAL/NOBLOB) and binlog_row_value_options (PARTIAL_JSON, 8.0.3+); the ROW-format before-image/after-image semantics.

- Azure Database for MySQL Flexible Server — server-parameter defaults (binlog_row_image=MINIMAL) and az mysql flexible-server parameter set (dynamic parameter changes without restart).

- sluice Bug 193 and the Azure Flexible Server probe report — the twelve-UPDATE/zero-change differential, the verify-sampling-power finding, the present-columns-bitmap fix, and the PARTIAL_JSON and PKE-visibility beats.

- sluice field note — REPLICA IDENTITY FULL ate our UPDATEs (the Postgres analogue: the row image, not the engine, decides whether your UPDATEs match).

---
Canonical page: https://sluicesync.com/field-notes/binlog-row-image-minimal/ · Full docs index: https://sluicesync.com/llms.txt
