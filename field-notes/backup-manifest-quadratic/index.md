# Rewriting the whole manifest, once per chunk

> Every backup checkpoint re-wrote the entire manifest.json, schema included. Since the manifest grows with table count, the total was quadratic — a measured ~78 hours of pure manifest rewriting at 100k tables. And the two obvious ways to fix it are the same quadratic in disguise.

Observed — sluice backup full of a many-table database; per-chunk and per-table checkpoints. Internally ADR-0086.

## What happened

Every per-chunk and per-table checkpoint during a backup re-marshaled the entire manifest — the full embedded schema along with it — and re-wrote the whole manifest.json. The manifest grows linearly with table count, and it was rewritten a number of times that also grows with table count, so the total checkpoint work was quadratic. A scale probe put a number on it: roughly 0.018·N + 2.77e-5·N² seconds over N tables — about 78 hours of pure manifest rewriting at 100,000 tables, ~322 days at a million. Every other part of the backup path is linear; this was the one super-linear wall.

## Why (the mechanism)

It is the textbook O(grows with N) × (done N times) = O(N²), hiding in plain sight because it is invisible at small scale: a backup of a few dozen tables rewrites a small file a few dozen times and finishes instantly, so nothing in local testing flags it. The checkpoints themselves can't just be thinned out — the crash contract (a crash leaves at most tableParallelism tables to redo) and the content-addressed upload-skip both depend on durable per-event progress. The work is load-bearing; the full rewrite per event is the waste.

## What sluice does about it

Split the in-progress manifest into a base written once (schema, anchor, encryption header, the pre-staged table entries — the heavy immutable parts) plus an append-only manifest.progress.jsonl sidecar — one compact JSON line per checkpoint, O(1) per event — folded back into a byte-identical self-contained manifest.json at success. That's the easy half. The instructive half is what they didn't do:

- The sidecar append is a single O_APPEND write plus fsync — deliberately not the usual write-to-temp-then-rename. Append-then-rename re-copies the whole growing file on every call: the exact quadratic being removed, wearing the costume of a safe atomic write.

- Object stores (S3/GCS/Azure) have no append primitive, and emulating one with read-modify-write re-copies the object every call — quadratic again. So the blob-store path keeps the legacy full-rewrite behavior, as a named, WARN-logged wart rather than a silent one.

## The transferable lesson

A metadata object that grows with your work and is rewritten once per unit of progress is silently O(n&sup2;), and it will pass every test you run at small scale and only surface as days at 100k. The fix is append-only rather than rewrite — but the trap has a second floor: the two most natural ways to make an append "safe" (write-to-tmp-and-rename, or read-modify-write on a store with no native append) each re-copy the whole file per call and quietly reintroduce the exact quadratic you set out to kill. When you replace an O(n&sup2;) rewrite, verify the replacement is genuinely O(1) per step and not an O(n) copy in disguise — and where the substrate can't give you a true append (object storage), say so out loud instead of shipping the quadratic silently. The same "stop rewriting the whole growing thing per checkpoint" lesson bit this project's migration state store too, there through MVCC and TOAST.

## Primary sources

- POSIX O_APPEND atomic appends — open().

- Why object stores aren't append-friendly — S3 objects are immutable (replace-whole-object).

- sluice's backup format & checkpoints — Take encrypted backups.

---
Canonical page: https://sluicesync.com/field-notes/backup-manifest-quadratic/ · Full docs index: https://sluicesync.com/llms.txt
