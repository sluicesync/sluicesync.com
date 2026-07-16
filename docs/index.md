# Documentation

> Migrate and continuously sync MySQL and Postgres, and import SQLite / Cloudflare D1 — correctness-first, loud failure by default.

sluice is an open-source tool for moving and keeping databases in sync between MySQL and
Postgres, in all four directions. SQLite files (and a wrangler d1 export .sql dump),
live Cloudflare D1 databases, CSV / TSV / NDJSON files, and mydumper / pscale dump
directories also import into Postgres or MySQL, and SQLite is itself a migrate target —
13 engines are registered today (run sluice engines to list them). It is built around three surfaces you can
use independently or end to end:

- Migrate — a one-shot schema + data copy, with deferred indexes/constraints for fast bulk load and per-table resume.

- Sync — change-data-capture streaming with a snapshot → CDC handoff and resumable checkpoints.

- Operate — run as a long-lived service behind /readyz and /metrics, or as one-shot jobs.

## Start here

- Getting started — install, connect, and run your first migration and sync.

- Command reference — every command, its key flags, and worked examples.

- Configuration — connection strings, environment variables, the YAML config file, and global flags.

New here? The fastest path is Getting started → run a --dry-run migration against a copy of your data → then read the migrate and sync start references.

---
Canonical page: https://sluicesync.com/docs/ · Full docs index: https://sluicesync.com/llms.txt
