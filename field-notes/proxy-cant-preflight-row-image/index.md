# The row image you can't preflight, because a proxy is in the way

> A self-hosted Vitess running binlog_row_image=NOBLOB drops an unchanged BLOB from an UPDATE's after-image — the same silent-overwrite class as the binlog NOBLOB case, reached through the Vitess door. But the vanilla defense, reading @@GLOBAL.binlog_row_image before the stream starts, cannot exist here: sluice connects to a vtgate, a proxy in front of a fleet of tablets, and there is no single row-image posture to read. The only authoritative signal is the wire itself — and the tablet underneath is loud when the experimental flag is off and goes silent at exactly the setting the guard exists for.

Observed — extending sluice's partial-row-image discipline to the VStream reader (v0.99.272, ADR-0172, roadmap item 74), filed from the Bug-193 review. The proto and tablet semantics below were ground-truthed against the vendored vitess.io/vitess@v0.24.2 (the module version in go.mod) — the bit order matches vttablet's own isBitSet. Honest scope: the belt is unit-pinned to the exact wire shape Vitess produces (the NULL-cell after-image plus its packed bitmap), directly and through the real dispatch path; a full self-hosted Vitess NOBLOB cluster streamed end-to-end is a recommended follow-up, not something this note claims was run.

## The same loss, one door over

A companion note covers the vanilla binlog case: under binlog_row_image=MINIMAL/NOBLOB, an UPDATE's row image omits columns, a value-reconstructing applier writes what it decodes, and the missing columns turn into silent loss on a green stream. Vitess reaches the identical class through a different reader. Vitess 16+ can run its underlying mysqlds under NOBLOB via an experimental flag (AllowNoBlobBinlogRowImage), and when it does, a tablet emits a partial UPDATE after-image that leaves an unchanged BLOB/TEXT column out.

Here is the sharp mechanical detail. For an omitted column, vttablet leaves the zero value in the row, which the wire encoder serializes as a cell of length &minus;1 — and length &minus;1 is the NULL-cell encoding. A VStream reader that has no bitmap to consult (decodeVStreamRow) reads that &minus;1 as a genuine SQL NULL. On UPDATE apply, it writes NULL over the column's real, unchanged value: the same Bug-193 silent corruption, arriving through the Vitess door disguised as a legitimate NULL.

## Why you can't preflight it

The vanilla binlog reader defends this with a stream-start preflight: read @@GLOBAL.binlog_row_image, and if it isn't FULL, refuse before any data moves. That defense is structurally impossible for VStream, and the reason is the proxy. sluice does not connect to a mysqld — it connects to a vtgate. A self-hosted Vitess is a fleet of tablets, each with its own mysqld and its own binlog_row_image, and vtgate exposes no aggregate row-image posture to probe. Route a @@GLOBAL.binlog_row_image query through vtgate and it lands on one arbitrary tablet, answering for that tablet and not the fleet — a global that doesn't exist, reported as if it did. A preflight there would be worse than none: a confident, wrong all-clear.

So the authoritative signal has to be the one Vitess already puts on the wire, per row. Each RowChange carries a DataColumns presence bitmap — one bit per column, set if the column is present in the after-image, unset if it was omitted — and a companion JsonPartialValues bitmap for the PARTIAL_JSON sibling (a JSON column logged as a JSON_SET/JSON_REPLACE/JSON_REMOVE diff rather than the value). On a FULL stream both bitmaps are absent, so the row image is the whole truth. When a bit in DataColumns is unset, that column was dropped — and that unset bit, not the value's length, is the fact you have to key on, because the value's length is lying to you.

## The twist: loud when the flag is off, silent when it's on

The part worth the note is what the tablet does on its own. With the NOBLOB experimental flag off, a partial row image makes vttablet abort the stream loudly — partial row image encountered: ensure binlog_row_image is set to 'full'. That is reassuring, and it is a trap, because it fires in exactly the configuration you don't need help with. Turn the flag on — the one setting under which NOBLOB actually produces partial images through VStream — and vttablet stops aborting. It emits the partial image with its DataColumns bitmap and streams on. The layer underneath is loud at the safe setting and goes silent at precisely the dangerous one, so trusting its self-defense would leave the guarded case unguarded.

## Refuse, not carry-forward — and only self-hosted Vitess reaches it

Given an omitted column, the two faithful options are to carry the prior value forward or to refuse. Carry-forward is impossible from the event alone: NOBLOB omits the unchanged BLOB from the before-image too, so the prior value simply is not in the RowChange. Recovering it would mean reading the target — replica-apply semantics sluice deliberately does not attempt — so the honest close is a loud refusal. (NOBLOB omits columns only from UPDATE after-images; INSERT and DELETE log every column, so refusing on the after-image covers the whole class.) One scoping fact keeps this from touching the managed flavor at all: PlanetScale pins binlog_row_image=FULL, so its DataColumns is never populated and the belt's fast path returns immediately. Only a self-hosted Vitess deliberately running the NOBLOB flag can reach this cell.

## What sluice does about it

Since v0.99.272 a decode-time belt (refuseVStreamPartialRowImage, called per RowChange in dispatchRow before decode) scans the two bitmaps: any unset bit in DataColumns, or any set bit in JsonPartialValues, refuses loudly with SLUICE-E-CDC-ROW-IMAGE-PARTIAL, naming the first offending column. It reuses the same coded error as the vanilla binlog door rather than minting a Vitess-specific one — it is the same silent-loss class, and an operator grepping the code should find one entry covering both doors. On a FULL stream both bitmaps are absent, the belt returns nil, and the decode path is byte-identical to before, so PlanetScale and every FULL stream are unaffected. Recovery on a self-hosted cluster is to set binlog_row_image=FULL on the source tablets and restart (a fresh cold start if the partial-image window's UPDATEs matter).

## The transferable lesson

When the configuration that governs correctness lives behind a proxy, a preflight that reads &ldquo;the&rdquo; setting is reading a fiction — a fleet has no single value, and the proxy will happily answer for one member as though it spoke for all. Prefer the signal the wire already carries per record over a global you have to ask for. And do not lean on a lower layer's own loud failure as your safety net without checking when it fires: here the tablet aborts at the safe setting and falls silent at the dangerous one, so the only defense that holds is the one that reads the per-row truth for itself.

## Primary sources

- sluice ADR-0172 (VStream partial-row-image belt) and CHANGELOG 0.99.272; the coded error SLUICE-E-CDC-ROW-IMAGE-PARTIAL, shared with the vanilla binlog door. Ground-truthed against vitess.io/vitess@v0.24.2 (the RowChange.DataColumns/JsonPartialValues bitmaps and vttablet's isBitSet bit order).

- Vitess — the VReplicationExperimentalFlagAllowNoBlobBinlogRowImage flag (Vitess 16+) and the vstreamer's partial-after-image behavior; the tablet's own &ldquo;partial row image encountered&rdquo; abort that fires only when the flag is off.

- MySQL Reference Manual — binlog_row_image (NOBLOB omits unchanged BLOB/TEXT from the row image) and binlog_row_value_options (PARTIAL_JSON).

- Sibling field note — the platform default that eats every UPDATE (the same silent-overwrite class through the vanilla binlog door; Bug 193).

---
Canonical page: https://sluicesync.com/field-notes/proxy-cant-preflight-row-image/ · Full docs index: https://sluicesync.com/llms.txt
