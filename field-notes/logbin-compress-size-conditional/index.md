# MariaDB's log_bin_compress makes the binlog size-conditional

> Turn on MariaDB's log_bin_compress and any row image at or above log_bin_compress_min_len (256 bytes by default) is written under compressed event types — MARIADB_WRITE/UPDATE/DELETE_ROWS_COMPRESSED_EVENT_V1 — while smaller rows keep the plain types. A binlog consumer whose event-type switch doesn't enumerate the compressed trio loses rows conditioned on their size: small rows kept, big rows gone, exit 0, with the resume position advanced past the loss. All three DML verbs are affected — a big row's DELETE compresses too, via its before-image.

Observed &mdash; the 2026-08-26 capture-completeness sweep, ground-truthed on a real compressing MariaDB 11.4.12: with log_bin_compress=ON, SHOW BINLOG EVENTS shows sub-threshold rows arriving as plain *_rows_v1 events and every row image &ge; 256 bytes as *_rows_compressed_v1, interleaved in one session. Fixed in sluice v0.132.0 &mdash; the compressed trio is now captured identically to its uncompressed twins. The class was CRITICAL silent loss, affecting v0.99.271 (where MariaDB CDC shipped) through v0.131.5 &mdash; and backup incrementals ride the same reader, so chains from a compressing source carried the same hole.

## One setting, two binlogs

MariaDB's log_bin_compress is pitched as a disk-space knob: compress binlog events, save I/O. What the name doesn't say is that it is thresholded. Only events whose payload is at least log_bin_compress_min_len (default 256, range 10&ndash;1024) are compressed; the rest are written exactly as before. And compression is not a transparent wrapper around the existing event &mdash; it changes the event's type: a compressed INSERT travels as MARIADB_WRITE_ROWS_COMPRESSED_EVENT_V1, a distinct type code from WRITE_ROWS_EVENTv1, with compressed siblings for UPDATE and DELETE.

So one server setting splits the binlog into two dialects, selected per-event by row size. A narrow table's traffic keeps the plain types entirely; a table with a JSON blob or a long text column emits both, mixed in one transaction. All three verbs participate &mdash; a DELETE of a big row compresses too, because its before-image is the payload that crosses the threshold.

## What the consumer sees

A binlog consumer is, at its core, a switch over event types. The compressed trio postdates most consumers' switches &mdash; and an unrecognized event type usually falls into a default arm that skips quietly, on the reasonable-sounding theory that unknown events are metadata the consumer doesn't need. Here that theory fails in the worst available way: the skipped events are the row data itself, and the events a consumer does recognize &mdash; the GTID and XID bookkeeping around them &mdash; still arrive and still advance the durable resume position. The failure signature is precise and nasty: small rows land, rows &ge; 256 bytes vanish, the stream reports green, and a restart resumes cleanly past the loss.

The size condition is what makes this a works-in-dev bug. Dev fixtures and smoke tests lean small &mdash; integer keys, short strings, rows well under 256 bytes &mdash; so a consumer can pass every test against a compressing server and lose precisely the production rows that carry real payloads.

## The bitter detail, and the class sibling

The bitter detail from sluice's own instance: the library layer (go-mysql) had already handled compression correctly. It decompresses the payload before any column is decoded and maps the compressed types onto the same row-image structures as their uncompressed twins &mdash; by the time an event reached sluice's dispatch switch, its rows were shape-identical to plain events. The entire CRITICAL was three missing case labels; the fix routes the three types through the exact same arms, every existing belt applying unchanged, pinned by a family &times; verb &times; shape matrix against a real compressing MariaDB with an anti-vacuity floor proving compressed events were actually on the wire. (The Vitess/PlanetScale lane is unaffected &mdash; Vitess tablets run MySQL, which has no such setting.)

And this is the second member of a class. MySQL 8.0.20+ has transaction-level binlog compression: a whole transaction packed into one TRANSACTION_PAYLOAD_EVENT a naive reader applies nothing from. Distinct mechanism &mdash; per-transaction versus per-event, config-wide versus size-thresholded, one wrapper type versus three new row types &mdash; but the same shape: a server-side setting can mint new event types for verbs you already handle, and it takes exactly one flag flip by a DBA to route production traffic through them.

## The transferable lesson

A binlog consumer's event-type switch is a completeness claim, whether or not it was written as one. Every arm you enumerate asserts &ldquo;this is data I capture&rdquo;; the default arm asserts &ldquo;everything else is safe to ignore&rdquo; &mdash; and that second assertion is falsified retroactively, by server settings that mint new event types for old verbs. The robust posture is to make the default arm loud: refuse, or at minimum count and surface, any unrecognized event type arriving between a transaction's begin and commit. A consumer that had merely counted its skips would have turned this from silent size-conditional loss into a first-day bug report.

## Primary sources

- MariaDB documentation &mdash; Compressing Events to Reduce Size of the Binary Log &mdash; the compressed event types and the transparent-to-replicas design (MariaDB's own replicas decompress natively; the trap is third-party consumers).

- MariaDB documentation &mdash; log_bin_compress and log_bin_compress_min_len &mdash; the 256-byte default and the 10&ndash;1024 range.

- sluice v0.132.0 changelog &mdash; the capture fix, the affected-release range (v0.99.271&ndash;v0.131.5), and the who-needs-this guidance: if a source ever ran log_bin_compress=ON on those releases, run sluice verify and resnapshot &mdash; the missing rows are behind an already-advanced resume position.

- Related field note: A whole transaction in one zstd binlog event &mdash; the MySQL member of the same class.

---
Canonical page: https://sluicesync.com/field-notes/logbin-compress-size-conditional/ · Full docs index: https://sluicesync.com/llms.txt
