# Documentation

> Migrate and continuously sync MySQL and Postgres — including PlanetScale Neki, sharded Postgres — and import SQLite / Cloudflare D1. Correctness-first, loud failure by default.

sluice is an open-source tool for moving and keeping databases in sync between MySQL and
Postgres, in all four directions. SQLite files (and a wrangler d1 export .sql dump),
live Cloudflare D1 databases, CSV / TSV / NDJSON files, and mydumper / pscale dump
directories also import into Postgres or MySQL, and SQLite is itself a migrate target —
14 engines are registered today (run sluice engines to list them). It is built around three surfaces you can
use independently or end to end:

- Migrate — a one-shot schema + data copy, with deferred indexes/constraints for fast bulk load and per-table resume.

- Sync — change-data-capture streaming with a snapshot → CDC handoff and resumable checkpoints.

- Operate — run as a long-lived service behind /readyz and /metrics, or as one-shot jobs.

## Start here

- Getting started — install, connect, and run your first migration and sync.

- Command reference — every command, its key flags, and worked examples.

- Configuration — connection strings, environment variables, the YAML config file, and global flags.

## PlanetScale Neki — sharded Postgres

Neki is PlanetScale&rsquo;s horizontally-sharded PostgreSQL, and sluice reaches it with the ordinary postgres driver &mdash; there is no neki engine, no --target-driver neki, and nothing to configure. sluice detects it from the server&rsquo;s own version() and adapts the handful of behaviours that differ.

Measured against live clusters, not inferred: migrate and sync into it including into an already-sharded database, across a live reshard with no loss or duplication, and through a MoveTables cutover &mdash; where the stream halts loudly with its position intact rather than drifting. Migrate out of it works too, including from a sharded database. Continuous sync out of Neki does not: the router refuses a replication connection outright, measured even on an unsharded database.

Sharding changes what your schema guarantees, and sluice refuses the shapes that would silently corrupt rather than letting them through &mdash; a UNIQUE constraint is only unique within a shard, and an upsert whose conflict key does not contain the shard key inserts a duplicate instead of updating. Migrate PlanetScale Postgres to Neki is the tested step-by-step procedure, and supported directions has the full matrix.

New here? The fastest path is Getting started → run a --dry-run migration against a copy of your data → then read the migrate and sync start references.

---
Canonical page: https://sluicesync.com/docs/ · Full docs index: https://sluicesync.com/llms.txt
