# Sync from managed Postgres without a replication slot

> Heroku Postgres, RDS without grants, Supabase / Crunchy starter tiers — managed Postgres that forbids logical replication still streams via sluice's trigger-based postgres-trigger engine. No slot, no REPLICATION attribute.

sluice's default Postgres CDC engine reads the write-ahead log through a logical replication slot — which needs the connecting role to be a superuser or carry the REPLICATION attribute. Plenty of managed tiers forbid exactly that. For those, sluice ships a deliberate slot-less path: the postgres-trigger engine captures changes with per-table triggers instead of a slot. This guide covers when you need it, the explicit setup → run → teardown lifecycle, and the flagship Heroku Postgres → PlanetScale move.

## When you need slot-less CDC

A one-shot migrate from Postgres needs only SELECT and runs anywhere, including the most locked-down tiers. Continuous sync is where the slot requirement bites: creating a logical replication slot requires the REPLICATION role attribute, and these managed tiers don't grant it:

- Heroku Postgres — no rolreplication, no CREATE_REPLICATION_SLOT, no event-trigger creation. The canonical case.

- AWS RDS without the right grants — logical replication is off unless the parameter group and role grants are set up for it.

- Supabase / Crunchy Bridge starter tiers — the starter roles don't carry the attribute.

- PlanetScale Postgres custom pscale_api_* roles — these API roles lack REPLICATION; slot-based CDC into PS-PG needs the Default postgres role. (Full detail in the PlanetScale Postgres guide.)

sluice does not silently degrade to polling when the slot path is unavailable. The slot-based reader runs a preflight probe before it opens — reading the world-readable pg_roles.rolsuper OR rolreplication — and refuses loudly, naming the role and pointing straight at this engine, rather than letting slot creation fail opaquely mid-cold-start with a raw ERROR: permission denied to create replication slot:

    the source connecting role "app_user" is not a superuser and lacks the
    REPLICATION attribute. Slot-based Postgres CDC (--source-driver=postgres) creates
    a logical replication slot at cold start ... Recovery: (a) grant the attribute:
    ALTER ROLE app_user REPLICATION; (b) re-run with a superuser or replication-enabled
    role; (c) on managed Postgres that forbids the REPLICATION attribute (Heroku
    Postgres Essential, Render Basic, Supabase free), use --source-driver=postgres-trigger

There is deliberately no --allow-missing-replication escape hatch: the role genuinely cannot create a slot, so the honest choices are to grant the attribute, swap roles, or take this slot-less path. The postgres-trigger engine installs per-table plpgsql AFTER triggers that write every change into a capture table (sluice_change_log); the engine tails that log — Bucardo-style CDC with no slot and no REPLICATION attribute (ADR-0066). The lifecycle is explicit, so the source-side DDL is visible at the CLI, never silently applied on first sync.

## 1. Install the capture triggers

sluice trigger setup installs the change-log table, the capture function, and the per-table triggers. --tables is required — name every table you want captured:

    sluice trigger setup \
        --source-driver postgres-trigger \
        --dsn 'postgres://user:pass@host:5432/app' \
        --tables orders,customers,line_items \
        --allow-polled-fingerprint

On a tier that also denies event-trigger creation (Heroku is one) automatic DDL detection can't use an event trigger, so add --allow-polled-fingerprint to opt into the weaker polled schema-fingerprint fallback. The command refuses loudly without it, so you explicitly acknowledge the trade-off rather than silently getting the degraded DDL-detection mode. The connecting role needs CREATE on the target schema, TRIGGER on each replicated table, and INSERT on sluice_change_log — a much smaller ask than REPLICATION. Preview the exact DDL without touching the source with --dry-run; the full set of objects it installs is listed under Objects sluice creates.

Tune how much of each changed row the capture writes with --capture-payload (full, the default, keeps the full before- and after-image; changed trims the after-image to PK + changed columns; minimal reduces the apply to a last-write-wins PK match — safe for one-way CDC with no concurrent target writers, and it reaches toward roughly 2× source-write overhead instead of more).

## 2. Stream with the trigger engine

The source driver is postgres-trigger; everything else is an ordinary sync start — cold-copy first, then CDC tailed off the trigger log, with the same value fidelity, warm-resume, and encryption as any sluice sync:

    sluice sync start \
        --source-driver postgres-trigger --source 'postgres://user:pass@host:5432/app' \
        --target-driver postgres         --target 'postgres://user:pass@target:5432/app?sslmode=require' \
        --stream-id app

Cross-engine directions. A postgres-trigger source can stream to a Postgres target and to a MySQL / PlanetScale-MySQL target — PG ↔ MySQL is sluice's supported cross-engine direction, and the trigger engine counts as a Postgres source for that purpose. Set --target-driver mysql (or planetscale) and the target DSN accordingly. The PG-native shapes that have no clean MySQL form — pg_trgm operator-class indexes, EXCLUDE constraints, Z/M-dimensional PostGIS columns — refuse loudly before any data moves, exactly as they do for the vanilla postgres source (2D geometry itself carries as WKB since ADR-0035). One trigger-lane specific: trigger setup refuses tables with PostGIS spatial columns outright since v0.124.0 (postgis-spatial-column) — the trigger capture cannot carry them faithfully; use the vanilla postgres engine for spatial tables, or --exclude-table.

The source change-log grows for the life of a continuous sync; reap durably-applied rows while the sync runs with sluice trigger prune (it reads the target's durably-applied frontier as the only safe lower bound and refuses to prune blind). See the trigger reference for its flags.

## 3. Tear down cleanly

When the stream is finished, sluice trigger teardown drops every per-table trigger and (by default) the sluice_change_log table, leaving zero residue on the source:

    sluice trigger teardown \
        --source-driver postgres-trigger \
        --dsn 'postgres://user:pass@host:5432/app' --yes

--yes skips the destructive-action confirmation prompt (for scripted/CI use). Pass --keep-data to retain the change-log table for forensics instead of dropping it. Teardown is idempotent — re-running against a partially-uninstalled source proceeds cleanly via DROP ... IF EXISTS.

## Upgrading an existing install (one trigger setup re-run)

The capture side of this engine lives on your source database, not in the sluice binary: the functions, the per-table triggers and the event triggers are objects trigger setup installed there, and CREATE OR REPLACE is the only thing that replaces them. Upgrading the sluice binary does not touch them. So a fix that lands in a capture function body — a GUC pin, a security hardening, a new event-trigger arm — reaches your database only when you re-run setup.

sluice does not leave that implicit. Every CDC open (which is every warm resume, not just a cold start) grades what is actually installed and says so. Four signals arrived across v0.134.1–v0.137.0, and the same single re-run clears all of them:

    sluice trigger setup \
        --source-driver postgres-trigger \
        --dsn 'postgres://user:pass@host:5432/app' \
        --tables orders,customers,line_items

It takes seconds and is non-destructive: the change log, its resume watermark and the consumer registry are all preserved, and the stream resumes where it left off. Name every table the install captures, and add --capture-replicated-writes if the install had it (see the refusal row below).

Signal at CDC open · Which installs · What it means ·

INSECURE-CAPTURE-FUNCTION (warn) · Installed by v0.85.0–v0.134.0, event-trigger tier · The DDL capture function was created SECURITY DEFINER with no SET search_path, and CREATE EVENT TRIGGER requires superuser — so it is superuser-owned and resolves its unqualified calls against the search_path of whichever session fired the DDL. An unprivileged user who can create a function in a reachable schema could shadow a built-in it calls and execute SQL as the superuser by running one CREATE TABLE. Fixed in v0.134.1's renderer; the fix reaches a database only via the re-run. Warns rather than refuses on purpose — this runs at every resume, so refusing would turn a binary upgrade into an immediate outage. ·

DROP-CAPTURE-ABSENT (warn) · Installed before v0.136.0, event-trigger tier · The install has the ddl_command_end event trigger but not the sql_drop one, so DROPping a synced table records nothing and the target keeps that table's last-synced rows forever at exit 0. See the two event triggers for why a drop needs its own arm. Warn, not refusal: the gap is bounded (once the table is gone there are no further writes to miss) and stranding a running sync over it would be the wrong trade. ·

STALE-CAPTURE-FUNCTION (warn) · v0.137.0+ binaries, against an install whose capture-function definitions differ from what the binary renders. v0.140.0 expect this one: that release changed the DDL capture body (it now records only DDL on relations this install captures), so every existing event-trigger-tier install warns until sluice trigger setup is re-run once · The old body keeps capturing through whatever it was written with — including from before the extra_float_digits pin (captured floats silently rounded when the writing session's setting is lower) and the bytea_output pin (captured bytea silently corrupted on the way to a MySQL/SQLite target). Read this row precisely: it fires on a difference, not on a vintage. An install whose definitions are already byte-identical to the binary's render opens silent, even if setup never recorded provenance for it — so "I don't see this warning" does not mean "setup has been re-run". ·

Capture-posture refusal naming sluice_capture_ddl_trg · Installed by v0.133.x/v0.134.x with --capture-replicated-writes · The only one of the four that stops the stream. Those releases made the per-table triggers ENABLE ALWAYS but left the DDL event triggers plain, so replica-role DML was captured while replica-role DDL silently was not — the two capture tiers disagreed under exactly the topology the flag exists to support. v0.136.0 made the posture install-wide and grades every trigger against it. Re-run setup with the flag to restore a coherent install. Installs without the opt-in are unaffected by this one. ·

Two refusals in the same family that a re-run does not clear, because they are not vintage: a capture function whose body no longer writes into the change log at all refuses at any vintage (no released sluice ever rendered one, so it is an edit, not an old install), and on a v0.137.0+ install a definition that disagrees with the digest trigger setup recorded refuses too — something replaced it after setup. Both name the function and tell you to find out who changed it. Re-running setup will overwrite the edit, so investigate first if it wasn't yours.

## Heroku Postgres → PlanetScale

Heroku Postgres forbids replication slots outright, so it's the canonical postgres-trigger scenario. The three commands above work standalone against a Heroku source — read the DATABASE_URL fresh at each invocation (Heroku rotates it under failover) and append ?sslmode=require (Heroku rejects non-TLS connections):

    sluice trigger setup \
        --source-driver postgres-trigger \
        --dsn "$(heroku config:get DATABASE_URL --app myapp)?sslmode=require" \
        --tables users,orders,items \
        --allow-polled-fingerprint

    sluice sync start \
        --source-driver postgres-trigger \
        --source "$(heroku config:get DATABASE_URL --app myapp)?sslmode=require" \
        --target-driver postgres \
        --target 'postgres://...your-target...?sslmode=require' \
        --stream-id heroku-myapp

For a hands-off, dashboard-driven move there's a packaged wrapper: sluice-heroku-migrator — a fork of PlanetScale's heroku-migrator with the replication engine swapped from Bucardo to sluice's postgres-trigger engine. Because sluice is a lightweight Go binary rather than an embedded PostgreSQL daemon, it deploys on a Standard-1x/2x dyno regardless of database size. It packages the same setup → sync → cutover flow this guide runs by hand — with TCP keepalives tuned for cloud NAT and psql-based status/cutover — behind a four-phase dashboard (Setup, Data Sync, Traffic Switch, Complete). You deploy it as a Heroku container app, set the HEROKU_URL, PLANETSCALE_URL, and PASSWORD config vars, and drive the phases from its dashboard. Prerequisites it enforces: every table has a primary key, the required extensions exist on the PlanetScale side, schema migrations are paused during the move, and the target has 1.5–2× the Heroku data size provisioned. The wrapper only automates the manual flow above — nothing it does isn't reproducible with the three sluice commands directly.

The --tables-first, explicit-lifecycle shape is what makes the trigger engine safe to run on someone else's managed database: nothing is installed on the source until you name it, and teardown removes every trace. This is a deliberate operability contrast with trigger tools that install capture state implicitly and leave residue behind.

## Next steps

- Prepare a Postgres source — the slot-based path's required GUCs, the REPLICATION attribute, and slot lifecycle (the engine this guide is the alternative to).

- Getting started: trigger-based CDC — a worked slot-less walkthrough.

- trigger setup / teardown / prune — the slot-less engine's full command reference.

- Verify & reconcile — confirm the target matches the source after the copy, identical to any sluice sync.

---
Canonical page: https://sluicesync.com/docs/managed-postgres-slotless/ · Full docs index: https://sluicesync.com/llms.txt
