# Migrating from Supabase with sluice

> Session vs transaction Supavisor pooler modes, the IPv6-only free-tier direct endpoint and what it means for CDC, float display vs float identity, and the platform schemas sluice already scopes out.

Supabase is managed Postgres, so sluice drives it with the vanilla postgres engine. It has been live-validated as a bulk-migration source (2026-07-15) with bit-exact fidelity through both Supavisor pooler modes, and as a continuous-CDC source (2026-07-16) over the direct endpoint. Unlike Neon, wal_level=logical is on out of the box — the thing that gates CDC on Supabase is not a setting but network reachability of the direct endpoint. That's the first thing to understand.

## The IPv6-only direct endpoint (the thing that bites first)

Supabase free-tier direct endpoints (db.<ref>.supabase.co) have only an AAAA record — IPv4 connectivity to the direct endpoint is a paid add-on. From an IPv4-only machine the connection fails in about a second with the platform resolver's cryptic no-data error. sluice detects this class: on a resolve failure it probes for an AAAA record and, when the host is IPv6-only, extends the error with the remedy — the coded SLUICE-E-CONNECT-IPV6-ONLY.

- Bulk migrate: use the pooler endpoint (aws-<n>-<region>.pooler.supabase.com — it has an A record). Validated bit-exact.

- CDC: the direct endpoint is required — a pooler cannot proxy the replication protocol — so from an IPv4-only network you need Supabase's IPv4 add-on or an IPv6-capable network. sync start through Supavisor fails at slot creation with the coded SLUICE-E-CDC-POOLER-ENDPOINT refusal explaining exactly this.

## Session vs transaction pooler modes

Supavisor exposes two ports on the pooler hostname, and they behave differently under sluice's parallel copy:

Mode · Port · Behaviour under sluice ·

Session · :5432 · Bulk migrate works, including parallel copy. Validated bit-exact. ·

Transaction · :6543 · Server connections rotate per transaction, which trips pgx's statement cache (SQLSTATE 42P05, &ldquo;prepared statement already exists&rdquo;). sluice WARNs and falls back to the single-reader copy path — correct, but parallel copy is unavailable in this mode. ·

Prefer session mode (or the direct endpoint) for large copies. sluice's pooler-host preflight WARN fires for both modes — the hostname matches the pooler.supabase.com pattern either way:

    # Bulk migrate through the session pooler (IPv4-friendly)
    sluice migrate \
        --source-driver postgres --source 'postgres://postgres.abcdefghijkl:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --dry-run

    # CDC needs the DIRECT endpoint (IPv6-only on the free tier)
    sluice sync start \
        --source-driver postgres --source 'postgres://postgres:pass@db.abcdefghijkl.supabase.co:5432/postgres?sslmode=require' \
        --target-driver postgres --target 'postgres://user:pass@target-host:5432/app?sslmode=require' \
        --stream-id supabase-app

CDC readiness. wal_level=logical is Supabase's default — nothing to enable (contrast Neon's project toggle). CDC is validated end-to-end against the direct endpoint (2026-07-16): cold-start snapshot → logical-slot CDC → INSERT/UPDATE/DELETE convergence, a clean stop, and exactly-once warm-resume — with no slot leaked on the managed instance. The only prerequisite is reaching the direct endpoint: the free-tier default is IPv6-only, so from an IPv4-only host enable Supabase's IPv4 add-on (it swaps the endpoint's AAAA record for an A record while enabled, and reverts about ten seconds after you disable it — so don't disable it under a running stream from an IPv4-only host). A read replica is not a CDC source — sluice refuses a Supabase -rr- standby with SLUICE-E-CDC-STANDBY-SOURCE and steers you to the primary; see Migrating from a Supabase read replica for that recipe plus the CDC-preflight facts (slot budget, WAL-retention, PITR). See Prepare a Postgres source for the slot checklist.

## Float display is not float identity

Supabase servers default extra_float_digits=0, so text-level float comparisons against a Supabase source mislead: a value can print rounded while the stored bits are exact. sluice's copy was proven bit-exact via float8send ground truth. If you diff sluice's output with external tooling that compares text, pin the session first — or better, compare the send-function bytes:

    SET extra_float_digits = 1;              -- make text output round-trip-exact
    SELECT md5(string_agg(float8send(col)::text, ',' ORDER BY id)) FROM t;   -- or compare bits directly

A &ldquo;mismatch&rdquo; that disappears under extra_float_digits=1 was never a data difference.

## Platform schemas

Supabase ships its platform schemas (auth, storage, realtime, …) alongside public. sluice's default public scoping ignores them — there is nothing to exclude manually, and your migrated target gets your tables, not the platform's.

## What sluice checks for you

- SLUICE-E-CONNECT-IPV6-ONLY — a resolve failure against an IPv6-only host (the free-tier direct endpoint, from an IPv4-only network) is diagnosed with an AAAA probe and refused with the remedy: pooler endpoint for bulk migrate, IPv4 add-on or IPv6 network for CDC.

- SLUICE-E-CDC-POOLER-ENDPOINT — slot creation through Supavisor is recognized by its SQLSTATE 42601 signature and refused with the direct-endpoint remedy, instead of surfacing as a bare syntax error.

- Pooler-host preflight WARN — both Supavisor ports match the pooler.supabase.com pattern and warn before the copy starts.

- Transaction-mode fallback WARN — the SQLSTATE 42P05 statement-cache signature on :6543 triggers a WARN and a correct single-reader fallback rather than a failed copy; the WARN is your signal to switch to :5432 for parallelism.

## Next steps

- Migrating from a Supabase read replica — the bulk-from-replica recipe, the CDC-standby refusal, and the corrected CDC-preflight facts.

- Prepare a Postgres source — the CDC checklist once the direct endpoint is reachable.

- Managed Postgres (slot-less) — the trigger-CDC path for tiers whose roles can't create slots.

- Verify & reconcile — sluice's own verification, which compares values (not display text).

---
Canonical page: https://sluicesync.com/docs/migrate-from-supabase/ · Full docs index: https://sluicesync.com/llms.txt
