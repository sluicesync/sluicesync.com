# "mydumper format" is a family, not a spec

> pscale database dump produces "mydumper format" — same metadata file, same schema files, same ~1 MB extended-INSERT chunks, byte-compatible enough that one reader serves both. The shared layout hides three producer forks: binary travels differently, string quoting differs, and TIMESTAMP semantics hinge on a header one producer always writes and the other never does.

Observed — building and validating sluice's mydumper-family source engine (ADR-0161, v0.99.247): real mydumper v1.0.3 dumps (including a probe against a +08:00 server), a survey of the planetscale/cli dumper source, and a live pscale database dump of a seeded corpus verified byte-identical end to end against the live server (2026-07-15).

## What happened

There is no mydumper spec — there is mydumper's output, and there are other tools that produce &ldquo;the same format.&rdquo; PlanetScale's pscale database dump is the important sibling: same directory layout, same file naming, same statement shapes. One reader can serve both, and ours does. But calibrating that reader surfaced three places where &ldquo;the same format&rdquo; quietly forks by producer.

Fork one: binary encoding. Vanilla mydumper can emit binary columns as hex-blob literals (0x&hellip;) — unambiguous, escape-free. The pscale writer has no hex path at all: every BLOB byte rides on backslash-escape fidelity through a quoted string. A reader tested only against hex-blob dumps has never exercised the code that pscale dumps depend on entirely — and escape decoding is exactly where the subtle bugs live (see our companion note on the two MySQL escapes that keep their backslash). Same format on the label; disjoint fidelity paths underneath.

Fork two: string quoting. mydumper emits single-quoted string literals; the pscale writer double-quotes, with backslash escapes for quotes. Both are valid MySQL literal spellings (barring ANSI_QUOTES servers), and a reader must decode both — we found this fork only by probing a real pscale dump.

Fork three, the one with instant-shift stakes: TIMESTAMP semantics are per-chunk, not per-format. mydumper v1.0.3 unconditionally converts TIMESTAMPs to UTC and stamps every file with /*!40103 SET TIME_ZONE='+00:00' */ — probed against a +08:00 server to be sure. The format, however, merely permits that header. The pscale dumper emits no TIME_ZONE header anywhere — no SET statements at all, and its metadata file is literally empty, zero bytes. A chunk with no header carrying server-local instants is byte-indistinguishable from one carrying UTC instants: the same digits, a silent hours-wide shift, wearing the same file extension.

For real pscale dumps the story ends well: PlanetScale sessions are UTC-pinned, so the header-less chunks do carry UTC and an assume-UTC reader is correct — our end-to-end probe (dump → sluice → MySQL, all 18 corpus columns, five rows, byte-identical against the live oracle, including the escape and binary edge cases) confirms it. But that correctness is a fact about one producer's server configuration, not about the format.

## What sluice does about it

Trust only what the file declares. The reader decodes both binary shapes and both quoting shapes through one decoder pinned against both producers. A TIME_ZONE header other than UTC refuses loudly — in every spelling MySQL accepts (SESSION/GLOBAL/LOCAL, @@time_zone, @@session.time_zone), so no qualified form slips the gate. And a table with TIMESTAMP columns whose chunks declared no time zone gets a once-per-table WARN naming the columns: on a pscale dump that WARN is the normal case and the assumption is right; on an unknown producer's dump it's the only signal the operator will ever get that an instant shift is possible.

(The family forks on the consumer side too: the vendor's own restore tool executes statements verbatim, silently skips compressed and csv/json data files, and hard-errors on real mydumper output — a story for another note.)

## Reproducing it

The producer forks are directly observable by diffing the two tools' output over the same table (mydumper: any MySQL + the mydumper/mydumper image; pscale dump: a PlanetScale account):

    $ mydumper -B db -o ./md-dump            # vanilla mydumper v1.0.3
    $ pscale database dump <db> <branch> --output ./ps-dump

    $ grep -r "TIME_ZONE" md-dump/ | head -1
    md-dump/db.t.00000.sql:/*!40103 SET TIME_ZONE='+00:00' */;
    $ grep -rc "TIME_ZONE" ps-dump/          # 0 matches, every file
    $ wc -c ps-dump/metadata                 # 0 bytes — literally empty

    $ grep -o "VALUES.*" md-dump/db.t.00000.sql | head -1    # single-quoted strings
    $ grep -o "VALUES.*" ps-dump/db.t.00001.sql | head -1    # double-quoted strings

For the TZ stakes specifically, run mydumper against a server with time_zone set to +08:00 and confirm the dumped TIMESTAMP values converted to UTC under the stamped header — that's the probe that established the flagship's behavior the header-less sibling can't declare.

## The transferable lesson

A dump format defined by a flagship tool's output forks per producer, in exactly the places the layout doesn't show: binary encoding, literal quoting, and session-dependent semantics like time zones. A reader that generalizes from one producer's dumps has tested a sibling format, not the family. Calibrate against every producer you claim to read, with real output from each; refuse loudly what a file declares and you can't honor; and where the file declares nothing, warn rather than silently inherit the flagship's behavior — the absence of a header is information about the producer, not permission to assume.

## Primary sources

- mydumper — output layout and the SET TIME_ZONE='+00:00' header (v1.0.3, ground-truthed including a non-UTC server probe).

- planetscale/cli — internal/dumper (the writer surveyed: escape-only binary, double-quoted strings, no SET headers, empty metadata).

- sluice ADR-0161 — the mydumper-family source engine: both-shape binary decode, the all-spellings TIME_ZONE gate, and the missing-header WARN.

---
Canonical page: https://sluicesync.com/field-notes/mydumper-format-family/ · Full docs index: https://sluicesync.com/llms.txt
