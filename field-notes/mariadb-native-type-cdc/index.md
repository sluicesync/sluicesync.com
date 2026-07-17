# The type that migrates clean and corrupts under CDC

> MariaDB's native uuid/inet6/inet4 round-trip perfectly under a bulk migrate, because the driver hands them back as formatted text. Turn on CDC and the same columns can corrupt: the binlog carries the raw storage bytes, not the text — bulk copy and the binlog are different transports with different representations. sluice met that first with a loud refusal, then decoded the bytes faithfully one release later — and the real byte layout was not the one the roadmap predicted, which is the richer lesson.

Observed — landing continuous CDC for sluice's MariaDB flavor (v0.99.271, ADR-0170), then decoding these types faithfully one release later (v0.99.272, ADR-0171). Phase 2 had already proven they round-trip under bulk migrate; Phase 3's CDC path is where the representation split bites — v271 met it with a loud, coded refusal, and v272 lifted that refusal by ground-truthing MariaDB's actual binlog byte layout on a live server.

## Clean under migrate

MariaDB grew native network types over several releases: uuid (10.7+), inet6 (10.5+), and inet4 (10.10+). Under a bulk migrate they round-trip perfectly, because the query driver hands them back as formatted text — a CHAR(36) UUID string, a VARCHAR(45) address — which sluice maps to Postgres native uuid/inet or to a MySQL-family target's CHAR(36)/VARCHAR(45). Nothing to see; the value is lossless.

## Corrupt under CDC

Turn on CDC and the same columns can silently corrupt. The binlog does not carry the formatted text — it carries the raw storage bytes: 16 bytes for uuid and inet6, 4 for inet4. sluice's value-decoder was written for MySQL, where these values live in a VARCHAR column and the binlog bytes are the text. Point that decoder at MariaDB's raw storage bytes and it stringifies them into garbage.

The trap is that the loudness is target-dependent. Feed the garbage string to a Postgres target and it rejects it — invalid input syntax for type uuid, SQLSTATE 22P02, loud and honest. Feed the same string to a MySQL-family target's CHAR(36)/VARCHAR(45) and it is silently accepted. So mariadb → mysql (or → mariadb, → planetscale) CDC was a reachable silent-corruption path while the Postgres direction failed cleanly. A type's loudness under one target is not its loudness under all.

## The interim close: refuse on every target (v0.99.271)

The first fix was a flavor-gated, source-side, coded refusal fired before any data moves, at all three points a native uuid/inet column could enter a stream: CDC stream start, cold-start snapshot open, and mid-stream schema add-table. It was the same refusal on every target — SLUICE-E-CDC-MARIADB-NATIVE-TYPE-UNSUPPORTED — because &ldquo;Postgres would have caught it&rdquo; is not a reason to let a MySQL-family target silently accept it. The steer was to bulk migrate those columns (unaffected) or exclude them from CDC scope. A loud refusal is a sound interim close: it trades a feature for a guarantee, and it holds until the faithful decode is proven rather than assumed.

## The real fix, and the byte layout that wasn't what we expected (v0.99.272)

Decoding the raw bytes faithfully is the proper close, and it is a value-fidelity hazard in its own right, which is why it shipped a release later rather than the same day. The roadmap draft anticipated the well-known trap: MariaDB's UUID_TO_BIN(x, 1) folklore says the native uuid storage reorders the timestamp fields relative to string order, so a straight big-endian decode would produce a valid-looking but wrong UUID. The live probe falsified that. MariaDB stores UUID canonical big-endian — no reorder at all; the folklore was wrong.

The real hazards were quieter and elsewhere. MariaDB frames these types length-prefixed and strips trailing 0x00 bytes on the wire, so a nil uuid, 0.0.0.0, or :: arrive as empty — zero bytes, not zero-filled. A decoder that sizes its output from len(raw) would silently shorten every zero-suffixed value; the faithful decoder right-pads to the fixed width and takes that width from the declared data_type, never from the received length. And inet6 text is rendered by MariaDB's BSD inet_ntop6, which diverges from Go's net/netip on the IPv4-compatible ::a.b.c.d forms — so even the text formatter has to match the server's, not the language's. All of it was verified byte-exact against live 11.4 and 10.11 and pinned with a full byte→text family matrix plus same-engine and cross-engine CDC value-fidelity tests. The lesson inside the lesson: the danger was not where the well-known trap said it would be, and only reading the actual bytes off a live server told us so.

## The transferable lesson

&ldquo;It migrated fine&rdquo; tells you nothing about the CDC path. Bulk copy and the replication log are different transports with different representations of the same column — one may hand you formatted text while the other hands you raw storage bytes — and a decoder proven on one is not proven on the other. When a decode error's loudness depends on the target type, the safe interim is a source-side refusal that doesn't depend on the target catching it: pin the class, refuse on all targets, and treat &ldquo;a plausible wrong value&rdquo; as worse than a stop. But a refusal is a placeholder, and closing it properly means reading the actual bytes off a live server — because the well-known trap may be folklore (MariaDB's UUID isn't reordered) while the real hazard sits somewhere quieter (stripped trailing zeros, a text formatter that follows the server's C library and not your language's). The extremes are where you learn the byte layout, so decode the value that's all zeros, not the one in the middle.

## Primary sources

- sluice ADR-0170 (MariaDB flavor Phase 3 — CDC) with the coded error SLUICE-E-CDC-MARIADB-NATIVE-TYPE-UNSUPPORTED, and ADR-0171 / CHANGELOG 0.99.272 (the faithful binlog decode that lifted the refusal: canonical big-endian UUID, stripped trailing 0x00, width from the declared data_type, BSD inet_ntop6 text). Ground-truthed byte-exact on mariadb:11.4 and mariadb:10.11.

- MariaDB Knowledge Base — UUID, INET6, and INET4 data types (storage widths; the actual on-disk byte order).

- Related field note: BIT crosses the wire as bytes, and the engines disagree on layout — another value whose wire representation is not its text.

---
Canonical page: https://sluicesync.com/field-notes/mariadb-native-type-cdc/ · Full docs index: https://sluicesync.com/llms.txt
