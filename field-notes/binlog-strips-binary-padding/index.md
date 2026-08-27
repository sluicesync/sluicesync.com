# Two MySQL replication wire formats disagree about padding

> MySQL right-pads a fixed BINARY(N) column to exactly N bytes, and a SELECT returns all N. The classic binlog's ROW image strips the trailing 0x00 padding, so BINARY(8) holding 0xDEAD000000000000 traveled the CDC wire as 2 bytes — snapshot 8 bytes, every later change 2, at exit 0. Vitess's VStream doesn't strip: full width on both its COPY and CDC legs, verified on a real cluster. The same tool needed opposite handling on its two MySQL replication lanes.

Observed &mdash; sluice's MySQL binlog CDC lane, caught by an adversarial value-fidelity corpus and fixed in v0.131.1. The loss was confined to the classic-binlog CDC lane &mdash; the bulk-copy/snapshot and flat-file lanes carry the full padded width &mdash; and only values with trailing 0x00 bytes strip visibly: 0xDEAD00&hellip; collapses, an all-non-NUL value survives untouched.

## The per-lane loss

MySQL's BINARY(N) is fixed-width: the server right-pads every inserted value to exactly N bytes with 0x00, and a SELECT hands back all N. You would expect a change-data-capture stream of the same column to carry N bytes too. The classic binlog does not: the ROW image serializes a fixed BINARY column as MYSQL_TYPE_STRING in length-prefixed form with the trailing NUL padding stripped, so BINARY(8) holding 0xDEAD000000000000 travels as the two bytes 0xDEAD. On a MySQL → Postgres continuous sync that produced an exit-0 divergence between the two legs of the same migration &mdash; the initial snapshot landed all 8 bytes, every later CDC change landed 2 &mdash; with no error anywhere. One code path corrupts a value family its sibling path round-trips: the per-lane shape that no green test on the other lane will ever catch.

## Why the reconstruction is safe &mdash; and exactly where it stops

The fix re-pads a short fixed-BINARY value back to its declared width, and it is worth being precise about why that is reconstruction rather than guessing: a BINARY(N) column's semantic value is by definition exactly N bytes &mdash; MySQL right-padded it at INSERT &mdash; so appending 0x00 up to N restores what the server stores, byte for byte. (Debezium applies the same re-pad for the same reason.) The boundary matters just as much: VARBINARY and BLOB are never padded, because there a short value is a real short value and padding would be the corruption. Even the degenerate edge behaves: an all-zeros BINARY(8) arrives fully stripped &mdash; an empty, non-NULL value &mdash; and re-pads to eight zero bytes.

## The twist: VStream never stripped

The sharper half came from testing the fix's sibling lane on a real PlanetScale cluster: Vitess's VStream does not strip. A trailing-zeros BINARY(8) inserted mid-CDC arrived byte-exact at full width on both the COPY leg and the CDC leg &mdash; and it did so on the pre-fix binary too, so VStream never had the loss. Vitess did not share this bug; the defensive width-guard sluice added on that lane is a confirmed no-op. Which means the same tool, reading &ldquo;MySQL&rdquo; replication, needed opposite handling on its two lanes: re-pad on the classic binlog, hands off on VStream &mdash; a padding convention one wire format strips and the other preserves.

## The transferable lesson

&ldquo;It's all MySQL replication&rdquo; is a trap. The classic binlog ROW image and Vitess's VStream are different wire formats with different value-encoding decisions, even when they describe the same server storing the same bytes &mdash; and a green corpus on one lane says nothing about the other. Test each replication lane against the real server it reads, with values chosen to expose the encoding (trailing NULs here), and when you patch one lane, run the probe on the sibling before assuming it needs the same patch: the answer here was that it demonstrably didn't.

## Primary sources

- MySQL reference &mdash; BINARY and VARBINARY &mdash; fixed-width 0x00 right-padding on INSERT.

- Debezium MySQL connector documentation &mdash; the same re-pad applied to fixed BINARY columns from the binlog.

- sluice v0.131.1 changelog &mdash; the corpus finding (BINARY(8): 8 bytes via snapshot, 2 via CDC), the re-pad, and the real-PlanetScale verification that VStream delivers full width on both legs.

- Related field notes: The identical code path that flattened numeric[][] &mdash; the founding member of the per-lane / per-family divergence class; parseTime governs the query protocol, not the binlog &mdash; another value-encoding decision the binlog makes on its own.

---
Canonical page: https://sluicesync.com/field-notes/binlog-strips-binary-padding/ · Full docs index: https://sluicesync.com/llms.txt
