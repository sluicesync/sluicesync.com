# The type that migrates clean and corrupts under CDC

> MariaDB's native uuid/inet6/inet4 round-trip perfectly under a bulk migrate, because the driver hands them back as formatted text. Turn on CDC and the same columns can corrupt: the binlog carries the raw storage bytes, and the loudness is target-dependent — a Postgres target rejects the garbage string, a MySQL-family CHAR(36) silently accepts it. Bulk copy and the binlog are different transports with different representations.

Observed — landing continuous CDC for sluice's MariaDB flavor (v0.99.271, ADR-0170). Phase 2 had already proven these types round-trip under bulk migrate; Phase 3's CDC path is where the representation split bites, and it is why sluice now refuses these columns loudly rather than stream them.

## Clean under migrate

MariaDB grew native network types over several releases: uuid (10.7+), inet6 (10.5+), and inet4 (10.10+). Under a bulk migrate they round-trip perfectly, because the query driver hands them back as formatted text — a CHAR(36) UUID string, a VARCHAR(45) address — which sluice maps to Postgres native uuid/inet or to a MySQL-family target's CHAR(36)/VARCHAR(45). Nothing to see; the value is lossless.

## Corrupt under CDC

Turn on CDC and the same columns can silently corrupt. The binlog does not carry the formatted text — it carries the raw storage bytes: 16 bytes for uuid and inet6, 4 for inet4. sluice's value-decoder was written for MySQL, where these values live in a VARCHAR column and the binlog bytes are the text. Point that decoder at MariaDB's raw storage bytes and it stringifies them into garbage.

The trap is that the loudness is target-dependent. Feed the garbage string to a Postgres target and it rejects it — invalid input syntax for type uuid, SQLSTATE 22P02, loud and honest. Feed the same string to a MySQL-family target's CHAR(36)/VARCHAR(45) and it is silently accepted. So mariadb → mysql (or → mariadb, → planetscale) CDC was a reachable silent-corruption path while the Postgres direction failed cleanly. A type's loudness under one target is not its loudness under all.

## The honest close: refuse, pre-data, on every target

sluice's fix is a flavor-gated, source-side, coded refusal fired before any data moves, at all three points a native uuid/inet column could enter a stream: CDC stream start, cold-start snapshot open, and mid-stream schema add-table. It is the same refusal on every target — SLUICE-E-CDC-MARIADB-NATIVE-TYPE-UNSUPPORTED — because &ldquo;Postgres would have caught it&rdquo; is not a reason to let a MySQL-family target silently accept it. The steer is to bulk migrate those columns (unaffected) or exclude them from CDC scope.

## Why not just decode the bytes?

Because faithful decode is itself a value-fidelity hazard, not a formality. MariaDB's native uuid storage reorders the timestamp fields relative to string order, so a straight big-endian decode produces a valid-looking but wrong UUID — a corruption you only catch by ground-truthing the byte order on a live server. That work is a filed follow-up precisely because getting it wrong would trade a loud refusal for a silent, plausible-looking error. A loud refusal is the honest interim close.

## The transferable lesson

&ldquo;It migrated fine&rdquo; tells you nothing about the CDC path. Bulk copy and the replication log are different transports with different representations of the same column — one may hand you formatted text while the other hands you raw storage bytes — and a decoder proven on one is not proven on the other. And when a decode error's loudness depends on the target type, the safe design is a source-side refusal that does not depend on the target catching it: pin the class, refuse on all targets, and treat &ldquo;a plausible wrong value&rdquo; as worse than a stop.

## Primary sources

- sluice ADR-0170 (MariaDB flavor Phase 3 — CDC; native uuid/inet through CDC), CHANGELOG 0.99.271, and the coded error SLUICE-E-CDC-MARIADB-NATIVE-TYPE-UNSUPPORTED. Validated mariadb → mysql with the coded refusal and zero rows on the target; ground-truthed on mariadb:11.4 and mariadb:10.11.

- MariaDB Knowledge Base — UUID, INET6, and INET4 data types (storage widths; UUID internal byte order).

- Related field note: BIT crosses the wire as bytes, and the engines disagree on layout — another value whose wire representation is not its text.

---
Canonical page: https://sluicesync.com/field-notes/mariadb-native-type-cdc/ · Full docs index: https://sluicesync.com/llms.txt
