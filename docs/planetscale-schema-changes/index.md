# Online schema changes on PlanetScale with sluice

> The expand→migrate→contract pattern as one gated command, the standalone resumable backfill with its verify gate, the deploy-ddl governed channel for safe-migrations branches, and the freshness gates that guard your production schema.

sluice ships a family of schema-change commands that drive the classic expand → migrate → contract pattern against PlanetScale: expand-contract (all three legs, one command), backfill (the data-migration middle step on its own — this one also works on plain MySQL, Vitess, and Postgres), and deploy-ddl + control-tables ddl (the governed DDL channel and bootstrap for branches with safe migrations enabled). Every leg was live-validated against real PlanetScale, and the pattern has been exercised at 131,072-row backfill scale. What sluice deliberately is not: a versioned-migration tool — no history table, no down-migrations. Atlas / Flyway / sqitch own that layer; your migration tool decides what changes, and these commands are a safe way to execute it.

## The full pattern: sluice expand-contract

Add the new column (expand), backfill the data (migrate), drop the old column (contract) — each DDL leg shipped through a PlanetScale dev branch + deploy request, the data leg run as a resumable keyset-chunked backfill, and a verify gate between backfill and the destructive drop:

    export PLANETSCALE_SERVICE_TOKEN_ID='...'   # service token: branch + deploy-request scopes
    export PLANETSCALE_SERVICE_TOKEN='...'      # env, never argv — these never land in shell history

    sluice expand-contract \
        --org myorg --database mydb --branch main \
        --dsn "$PROD_BRANCH_DSN" --table users \
        --expand-ddl   'ALTER TABLE users ADD COLUMN full_name VARCHAR(255)' \
        --set          'full_name = CONCAT(first_name, " ", last_name)' \
        --where        'full_name IS NULL' \
        --contract-ddl 'ALTER TABLE users DROP COLUMN first_name' \
        --yes

The load-bearing semantics:

- --where is required and doubles as the verify gate. Make it self-describing (new_col IS NULL): after the backfill, sluice counts rows still matching it across the whole table, and only a count of 0 authorizes the contract leg. A nonzero count fails with SLUICE-E-BACKFILL-INCOMPLETE — re-run to catch the stragglers, then verify again.

- --yes is the contract confirmation. The contract leg is a DROP COLUMN deploy request against your production branch; without --yes (or without --contract-ddl) the run stops after verify as a success and prints the exact resume command. --dry-run and --yes are mutually exclusive by construction — a plan can never confirm a drop.

- --dry-run prints the full plan — branches, deploy requests, the rendered backfill statement, the gates — with zero control-plane calls and zero writes.

- Interrupted runs resume with --resume-from expand|migrate|contract. The backfill leg is natively resumable via its persisted cursor; verify always re-runs before contract.

- A deploy request that outwaits --deploy-timeout un-deployed keeps its dev branch (deleting the branch would close the still-open deploy request your org's review queue was just asked to approve); the message names the kept branch — delete it yourself once the request closes. Every other failure path cleans up.

## The middle step alone: sluice backfill

When the schema change itself is already handled — or you're not on PlanetScale — the batched, resumable, online-safe in-place data migration stands alone. It is single-endpoint (reads and updates one database) and walks the table's primary key issuing one bounded UPDATE per chunk, so no statement approaches PlanetScale/Vitess's synchronous-transaction wall (errno 3024) or holds long locks on any engine:

    sluice backfill \
        --driver planetscale --dsn "$DSN" \
        --table users \
        --set   'full_name = CONCAT(first_name, " ", last_name)' \
        --where 'full_name IS NULL' \
        --verify

- Engines: --driver is one of mysql, mariadb, planetscale, vitess, postgres; SQLite/D1 refuse with SLUICE-E-BACKFILL-UNSUPPORTED-ENGINE. --set / --where are native SQL for that engine, emitted verbatim; --set splits at the first =, so CASE arms pass through.

- Resume is automatic. The cursor persists in the same database's control tables, keyed by a hash of the spec (--set + --where); a killed run resumes where it stopped, replaying at most one chunk — which is why the --where guard should self-describe doneness, so the replay is a no-op. --restart discards the cursor; --batch-size is excluded from the spec hash, so retuning it never orphans a cursor.

- --verify runs a whole-table remaining-count on --where after the walk: 0 prints the safe-to-contract signal; >0 exits with SLUICE-E-BACKFILL-INCOMPLETE (rows written behind the walk's cursor during the run — re-run, then verify again). --verify-only is the standalone scriptable gate for deploy pipelines: no walk, no UPDATEs, no control-table writes, no primary-key requirement, --set optional.

- The concurrent-run guard. A spec whose state row is still walking with a heartbeat fresher than 5 minutes refuses with SLUICE-E-BACKFILL-CONCURRENT-RUN — typically an overlapping cron invocation. Two concurrent walks of one spec would interleave cursor writes, so sluice refuses before touching anything (including a --restart, which would clear the state out from under the live walker). Wait for the other run to finish or its heartbeat to go stale, then re-run.

- The other refusals are equally deliberate: no orderable primary key → SLUICE-E-BACKFILL-NO-PRIMARY-KEY (there is intentionally no force flag — an unbounded UPDATE is the exact shape the command exists to avoid); a --set column that doesn't exist → SLUICE-E-BACKFILL-UNKNOWN-COLUMN before any UPDATE runs; a cursor written by an older sluice that provably mangled it → SLUICE-E-BACKFILL-CORRUPT-CURSOR (re-run with --restart).

## Safe-migrations branches: deploy-ddl + the control-tables bootstrap

A PlanetScale branch with safe migrations enabled refuses every direct DDL statement (Error 1105, &ldquo;direct DDL is disabled&rdquo;) — including sluice's own CREATE TABLE IF NOT EXISTS for its control tables, and the user-table CREATEs a fresh migrate or sync cold-start issues. sluice's ensure paths are detect-first (no DDL at all when the tables are current), and when DDL is genuinely needed the refusal is the coded SLUICE-E-PS-DIRECT-DDL-BLOCKED, echoing the exact refused statement. The way through is the governed channel, one command per statement:

    # 1. Print the exact CREATE statements for sluice's control tables (read-only, no credentials)
    sluice control-tables ddl

    # 2. Ship each statement via a deploy request (dev branch -> apply -> deploy -> cleanup, one command)
    sluice deploy-ddl --org myorg --database mydb --ddl '<one statement from step 1>'

    # 3a. For sync: pre-create the USER tables the same way, then skip schema-apply
    sluice schema preview --source-driver mysql --source "$SRC" --target-driver planetscale --target "$DST"
    sluice deploy-ddl --org myorg --database mydb --ddl '<one CREATE from the preview>'   # per table
    sluice sync start ... --schema-already-applied

    # 3b. For a one-time migrate: pre-create the user tables via deploy-ddl as in 3a, then just run it
    sluice migrate --source-driver mysql --source "$SRC" --target-driver planetscale --target "$DST"

deploy-ddl wraps ONE verbatim statement in the full safety machinery — safe-migrations preflight, dev branch with the freshness gate below, apply, deploy request, deploy, skip-revert finalize, always-cleanup — and --dry-run makes zero control-plane calls. It is also the general escape hatch for any ad-hoc schema change on a safe-migrations branch. Ship the control-table statements once, and backfill runs normally against the branch.

The shape gate: bootstrap → fresh migrate just works. In step 3b, migrate needs no flag at all: its pre-create shape gate detects each pre-created table, verifies its column shape matches what the migration would create (names, types, nullability — deploy-ddl-shipped indexes are fine, they're outside the compare), and skips the refused CREATE with an INFO. A pre-existing table whose shape does NOT match refuses upfront with SLUICE-E-TARGET-TABLE-SHAPE-MISMATCH, before any data moves. sync takes --schema-already-applied instead, skipping its schema-apply phase.

One more place safe migrations can bite: the deferred index build after a large copy (on migrate, restore, and sync cold-start alike). Arm the automatic deploy-request index-build fallback with --planetscale-org plus the service-token env vars on whichever command you're running, and still-pending indexes build through a dev branch + deploy request on the already-copied data — no re-copy. Unarmed, the refusal is SLUICE-E-INDEX-DIRECT-DDL-DISABLED (or SLUICE-E-INDEX-STATEMENT-TIME-LIMIT for the ~900 s statement wall), and --resume finishes just the indexes.

## Safe-migrations posture: sluice never touches the toggle

sluice never enables or disables safe migrations on your branch. It is a behaviour change on production (direct DDL becomes blocked from then on), and the enable/disable propagation lag makes toggling it around a run unsafe. So:

- expand-contract / deploy-ddl require it ON and refuse with SLUICE-E-PS-SAFE-MIGRATIONS-DISABLED when it's off — with it off, direct DDL works and you don't need them.

- migrate / sync / backfill work either way: with it ON, bootstrap via the flow above; with it OFF they issue DDL directly, as on any MySQL.

- If you hit SLUICE-E-PS-DIRECT-DDL-BLOCKED, the remedy is the governed channel (or a deliberate operator decision to disable safe migrations for a migration window) — never sluice flipping the toggle for you.

## The stale-base freshness gate

A newly created PlanetScale dev branch's schema can lag the production branch it was created from — observed live: a branch created 14 minutes after a deploy still lacked the deployed column, while another created 1 minute after was current; the lag is intermittent and its timing undocumented. A deploy request from such a branch silently proposes reverting the missing schema — on the contract leg, that would drop the freshly backfilled expand column. So expand-contract, deploy-ddl, and the index-build fallback all compare every dev branch's schema against production before applying any DDL, self-heal a stale base once (delete the branch → take an on-demand backup → recreate), and refuse with SLUICE-E-PS-BRANCH-STALE-BASE only if it's still stale after the rebase. Two more gates ride the same machinery: the deploy request's computed diff is fetched and refused if it touches any object the leg never intended, and production's schema is re-verified after a long review wait (a request that sat in a review queue while production moved would otherwise deploy against the old schema).

## What sluice checks for you

- SLUICE-E-BACKFILL-INCOMPLETE — the verify gate found rows still matching the --where guard; the contract step stays locked until a re-run brings the count to 0.

- SLUICE-E-BACKFILL-NO-PRIMARY-KEY / SLUICE-E-BACKFILL-UNKNOWN-COLUMN / SLUICE-E-BACKFILL-CORRUPT-CURSOR / SLUICE-E-BACKFILL-CONCURRENT-RUN — the backfill refuses (rather than degrades) on an unbounded-UPDATE shape, a typo'd column, a provably mangled legacy cursor, or a live concurrent walk of the same spec.

- SLUICE-E-PS-SAFE-MIGRATIONS-DISABLED — deploy requests can't be created into a branch without safe migrations; sluice names it instead of toggling the setting for you.

- SLUICE-E-PS-DIRECT-DDL-BLOCKED — a refused direct DDL statement (control table or user table) is caught with the exact statement echoed and the governed-channel remedy.

- SLUICE-E-PS-BRANCH-STALE-BASE — a dev branch whose schema lags production is rebased once and refused if still stale, so a deploy request can never silently revert newer schema.

- SLUICE-E-PS-DEPLOY-REQUEST-FAILED — a deploy request that errors, closes undeployed, computes an empty or out-of-scope diff, or outwaits --deploy-timeout is named with its number, state, and URL — plus the leg-specific recovery.

- SLUICE-E-TARGET-TABLE-SHAPE-MISMATCH — a pre-created table whose column shape differs from what migrate would create refuses before any data moves.

- SLUICE-E-INDEX-DIRECT-DDL-DISABLED / SLUICE-E-INDEX-STATEMENT-TIME-LIMIT — a blocked deferred index build names the deploy-request fallback arming flags; the copied data is never lost, --resume finishes just the indexes.

## Next steps

- Schema changes during a sync — the other half of the problem: keeping a running stream aligned through source DDL.

- backfill, expand-contract, deploy-ddl, control-tables ddl — the full flag references.

- Self-hosted MySQL → PlanetScale — the migration this pattern usually follows.

- Field note: the 20-second guillotine over a WAN — why bounded per-chunk UPDATEs are the only safe shape on Vitess.

- Field note: persist a resume cursor as JSON and it silently teleports — the story behind the corrupt-cursor refusal.

---
Canonical page: https://sluicesync.com/docs/planetscale-schema-changes/ · Full docs index: https://sluicesync.com/llms.txt
