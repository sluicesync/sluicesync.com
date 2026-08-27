# The same unsigned primary key is int64 to one reader and uint64 to the other

> sluice's backup float repair matches rows across two readers of the same MySQL table — the exact-scan query reader and the VStream COPY decoder — and they hand back the same unsigned-integer primary key as different Go types. So the type tag you'd reach for to harden the match key is precisely the wrong move: it would split int64 from uint64 and silently miss the repair for every unsigned PK. The collision that did ship was quieter — a NUL-joined composite key merged two distinct rows, writing one row's floats into the other row's archived record, in a backup that verifies green.

Observed &mdash; the 2026-08-14 sluice repository audit (finding M-4), on the VStream float-repair path of backup full from a Vitess/PlanetScale source &mdash; default-on there, latent since the repair path shipped in v0.99.207; fixed v0.127.0. The type-tag half never shipped: the pre-release value-fidelity review caught it in the first cut of the fix.

## Why a backup reads the same table twice

Vitess's VStream COPY leg delivers FLOAT columns display-rounded (its own note), so on a Vitess/PlanetScale source sluice's backup re-reads FLOAT columns exactly over the query protocol and patches the archived rows. That makes one small map the crux of the whole feature: each re-read value must be re-associated with the same row's VStream-decoded record, matched on primary key &mdash; across two independent decoders of the same table.

## Two readers, two type systems

The readers do not agree what a PK value is. The exact-scan side runs MySQL's binary protocol and yields int64 for unsigned TINYINT through INT &mdash; and for BIGINT UNSIGNED up to 263&minus;1; above that it carries a decimal string, the driver-representation switch with its own note. The VStream decode yields uint64 for the same columns at every magnitude. Same table, same rows, same column: int64(42) on one side, uint64(42) on the other.

Which makes the obvious hardening for a value-keyed map &mdash; tag the key with the value's type, so int64(1) can never collide with the string "1" &mdash; exactly backwards here. A %T tag would split int64 from uint64, the key would never match, and the repair would silently skip every row whose PK is an unsigned integer: the MySQL autoincrement norm. The pre-release review caught precisely that regression in the fix's first cut. The shipped key stays deliberately type-blind &mdash; %v renders all of these to the same decimal text, so they match &mdash; and the type-blindness is safe here because a PK column has one fixed schema type per reader: no two rows of one table can present the same column as different type families.

## The collision that did ship

The injectivity bug was elsewhere. The original key rendered a composite PK as %v components joined by a bare NUL byte &mdash; non-injective, because a NUL living inside a PK value shifts the component boundary: under a NUL-admitting collation like utf8mb4_bin (and MySQL VARCHAR admits 0x00), ("a\x00", "b") and ("a", "\x00b") render identically. Two distinct rows collided into one entry, and the repair wrote one row's exactly-re-read floats into the other row's archived record &mdash; a silent wrong value in a backup that verifies green. The v0.127.0 fix length-prefixes every component (<len>\x1e<value>), so every boundary is unambiguous however the payload is spelled.

## The transferable lesson

A key that bridges two independent decoders has to mean &ldquo;same value,&rdquo; not &ldquo;same runtime type&rdquo; &mdash; canonical rendering, deliberately type-blind. A type tag hardens a single-reader key and breaks a cross-reader one, and knowing which kind of key you are holding is the entire game. Injectivity, meanwhile, must come from framing, never from a separator byte you assume the payload can't contain: if the domain admits every byte, length-prefix. The shape to distrust is any map whose keys are built from values that crossed two different drivers &mdash; each driver's Go-type choices are an implementation detail, and they leak straight into your equality.

## Primary sources

- go-sql-driver/mysql &mdash; the query-side representation of unsigned integer columns (int64 within range, switching representation above int64's max).

- sluice v0.127.0 changelog &mdash; the injective length-prefixed patch key, and the review note that removed the type tag before release.

- Related field notes: BIGINT UNSIGNED overflows both bigint and int64 &mdash; the value-overflow boundary on a single reader; this note is the cross-reader divergence at any magnitude. VStream delivers FLOAT display-rounded &mdash; why the float repair exists at all.

---
Canonical page: https://sluicesync.com/field-notes/same-pk-two-go-types/ · Full docs index: https://sluicesync.com/llms.txt
