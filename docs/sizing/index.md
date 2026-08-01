# Sizing & plan recommendations

> What to change as your dataset grows — because past a certain size the limit stops being sluice and starts being the target platform's plan, storage architecture, and per-statement limits.

sluice's defaults are tuned for the ordinary case: a schema of a few dozen tables and a few gigabytes of data, copied in one shot, with secondary indexes deferred to the end so the bulk load is fast. Below a certain size you should not need to think about any of this — run --dry-run, run the migration, run verify, and you are done.

Above that size, what changes is usually not sluice. It is the target: how much CPU the plan has while a burst workload lands on it, whether its storage is pre-provisioned or grows underneath you mid-copy, and whether the platform enforces a per-statement time limit that a large index build or foreign-key validation cannot fit inside. This page is the practical version of that — rough size bands, what each one changes, and the plan advice that has mattered most in real migrations.

## Three size bands

These are rules of thumb, not thresholds sluice enforces — row width, index count, and target tier all move the boundaries. Use them to decide how much attention a migration deserves, not as a spec.

Rough size · What changes · What to do ·

Small — under ~10 GB, a few million rows · Nothing. The copy is minutes to an hour, the deferred index build is quick, and no platform limit is anywhere near being reached. · Use the defaults. --dry-run, migrate, verify. On an elastic platform you may still ride one storage-autoscale event — see below — which is slower, not dangerous. ·

Medium — ~10–100 GB, tens of millions of rows · Hours, and the target becomes the bottleneck — the bulk copy is bound by the destination's CPU and write throughput, not by sluice. Storage autoscaling on elastic tiers is now near-certain to fire at least once. · Oversize the target plan for the run. Expect to use --resume at least once, and let it — it re-copies nothing that finished. ·

Large — 100 GB+, 100M+ rows · The long pole stops being the copy and becomes the post-copy phases: secondary index builds and foreign-key validation, both of which are single long-running statements the platform may refuse to let finish. · Prefer pre-provisioned local storage (on PlanetScale, a Metal plan). Oversize generously. Read the large-target flags section before you start rather than after the first failure. ·

## Size the target for the migration, not for steady state

A migration is a burst workload, and it is the least representative thing your database will ever do: it writes your entire dataset as fast as it can accept it, then builds every secondary index at once. Sizing the target for the traffic it will serve afterwards means the migration runs against the smallest plan you will ever have, during the single heaviest hour it will ever have.

So oversize the target plan for the run, and size it down afterwards. On PlanetScale in particular, cold-copy throughput is target-tier-CPU-bound — a bigger tier is a directly faster copy — and the deferred index build is the most CPU- and IO-hungry phase of the whole migration, arriving right at the end when you least want to be waiting. A plan one or two sizes above your steady-state target, held for the day of the migration, is usually the cheapest speed-up available and needs no flags at all.

This cuts both ways as a diagnostic. If a copy is slower than you expected, check the target's CPU before you reach for a parallelism flag — a saturated destination will not go faster because more writers are pointed at it, and on some platforms extra pressure during a storage event actively prolongs it.

## Before you size back down, wait for a fresh backup

Once the bulk of the copy is done and you are thinking about dropping the plan back to its steady-state size, confirm that a backup which already contains the imported data has completed first. A resize is an infrastructure operation on a database that has just absorbed its entire dataset in one go, and you want your most recent restore point to be on the far side of that import, not the near side. A backup taken before the migration will restore you to an empty database.

Two related checks before a resize, if you are running a continuous sync rather than a one-shot migrate:

- Let the sync catch up first. sluice sync status should show the stream healthy and lag low before you start an infrastructure operation underneath it.

- A resize can interrupt in-flight writes, the same way a storage-grow or a primary reparent does. sluice rides those windows automatically and warns while it does — but there is no reason to make it do that during a resize you chose the timing of.

Raising the plan before the copy and dropping it back afterwards is a manual step today. Doing it for you — including waiting on the backup — is an idea on the roadmap, not a shipped feature; there is no flag for it, so do not go looking for one.

## Elastic storage: what a mid-copy auto-grow actually does

Platforms whose storage grows on demand start a new database with a small volume and expand it in steps as data lands. That is normally invisible — but a bulk import is precisely the workload that walks up several steps in a single run, and the grow is not free.

On PlanetScale's non-Metal tiers this has been measured directly: a storage auto-grow at the first (~10 GB) boundary triggers a primary reparent — and it does so on every non-Metal size tested, including the largest. During that window writes are briefly refused with a Vitess 1105 “primary is not serving” and the copy stalls.

sluice rides this automatically, with no flags — across the cold-copy write path, the source read path, and the post-copy index and constraint phases. You will see WARN lines naming the transient and the retry; they are expected and self-clearing, and nothing is lost or duplicated. A genuine non-transient failure still surfaces loudly and promptly. What it costs is wall-clock: the copy waits out the window, and a large table crossing a boundary can spend minutes doing so.

Expect at least one on a first import. A freshly created database starts near the bottom of the storage ladder, so the first migration into it is the run that pays for climbing it. A second run into the same database — a re-launch after a failure, say — starts on the already-grown volume and sails past the boundary that stopped the first one. This is normal and is not a sign that anything is wrong with the earlier attempt.

## PlanetScale: when to pick Metal

PlanetScale's Metal plans put the database on local NVMe with storage pre-provisioned at the size of the plan, rather than on network-attached storage that grows on demand. For a migration that changes two things that matter, and the second one matters more than most people expect.

  · Non-Metal (elastic tiers) · Metal ·

Storage · Network-attached, starts small, grows in steps. Each grow is a stall plus a primary reparent. · Local NVMe, pre-provisioned with the plan. The whole auto-grow class does not arise. ·

Index builds · Slow enough that a large deferred build can exceed even a raised per-statement ceiling. · Fast enough that large builds finish comfortably. Measured: a deferred four-index build on a 153-million-row table completed in about 35 minutes. ·

Best for · Small and medium datasets. Cheaper, and the autoscale events are an inconvenience rather than a blocker. · Large datasets, and anything with big tables carrying several secondary indexes or foreign keys. ·

The measurement that decides it for large datasets is the second row. The same deferred index build that finishes in about 35 minutes on a Metal target exceeds even a 3600-second ceiling on network-attached storage — so on the elastic tiers a large index build is not merely slower, it can be outside what the platform will let a single statement do at all, and the migration has to route around it. That is the difference between “wait longer” and “take a different path”.

Recommendation. For small datasets a non-Metal plan is genuinely fine — take the cheaper tier and expect an autoscale event or two along the way. For large ones, prefer Metal, and combine it with the oversize-for-the-run advice above.

## Large-target flags on PlanetScale-MySQL

PlanetScale enforces a per-query statement wall (MySQL errno 3024, ~900 seconds by default). Past a certain table size a deferred ADD INDEX or an ADD FOREIGN KEY is a single statement that cannot finish inside it. sluice has several ways around that, and they compose:

Option · What it does, and when to reach for it ·

--upfront-indexes · Create secondary indexes before the bulk copy so they are maintained during load, instead of the default deferred post-copy build. Trades a slower load for no large index build at the end. On a Metal target this is usually the cleanest path and needs no other tuning. On network-attached storage it is less of a cure than it looks — a single bulk-copy insert has been measured hitting the same wall. ·

--planetscale-raise-query-timeout · Raises the target keyspace's query timeout to its 3600-second maximum for the run and reverts it afterwards, giving the direct path headroom. Opt-in, and needs --planetscale-org plus a service token. Read the caveat: the change is keyspace-wide and its rollout is a rolling tablet restart affecting anyone else on that keyspace, several minutes each way and again on revert. It is skipped automatically on a migration with no large table. It buys headroom on fast tiers; it does not rescue a build that needs more than 3600 seconds anyway. ·

Deploy-request fallback · With --planetscale-org and a service token present, a walled index build is routed to a PlanetScale deploy request, which builds it asynchronously. sluice narrates progress and waits. Nothing to enable beyond supplying the credentials. ·

--resume · The recovery, not a tuning knob — but the one to know. If an index build walls after the copy completed, the data is already there: --resume re-copies nothing and finishes only the indexes. Growing the target plan before the resume makes that build faster. ·

Foreign keys are handled for you. An ADD FOREIGN KEY on a large child table is heavier than an index build, because InnoDB validates every child row against the parent as it adds the constraint. sluice adds such a key metadata-only instead — the rows were just copied from a source where the constraint was enforced, so the validation is redundant — and then proves the child rows clean with a bounded orphan scan that stays under the wall. On the 153-million-row table this arc was built against, the add returned in 0.082 seconds. If the source really does contain an orphan, sluice drops the key it just added and refuses loudly with SLUICE-E-FK-SOURCE-ORPHAN, rather than leaving a constraint that the data does not satisfy. See Foreign keys on a Vitess / PlanetScale target.

As of v0.106.0 the two flags above are migrate flags. A sync cold-start runs the same copy path and the same knobs are being brought across to it — check sluice sync start --help on the build you are running rather than assuming either way.

## Practice that pays off at any scale

- --dry-run first, always. It prints the DDL sluice would apply and the type decisions it made, with no writes. On a large migration this is the cheapest hour you will spend — see Preview & validate.

- Let --resume do its job. Per-table state means an interrupted copy restarts from the tables that did not finish, not from zero. Resuming is the normal response to a transient failure, not an admission of defeat.

- verify after, not instead of. Verify & reconcile compares source and target once the copy is done; --format json makes it a CI gate.

- --analyze-after at cutover. A freshly bulk-loaded table has stale planner statistics, so the first queries after cutover plan badly until the target's own background statistics catch up. This refreshes them once, per table, after constraints and views are in place. It is advisory — a per-table failure warns and never fails the migration.

- Tune parallelism last, and only against a target that is not already saturated. --table-parallelism and --bulk-parallelism are in the migrate reference; the PlanetScale/Vitess-specific read and write axes are in PlanetScale & Vitess.

## Next steps

- PlanetScale & Vitess — the flavor's cold-start knobs, throttler signals, and storage-grow behaviour in full.

- How sluice copies your data — why the copy takes the path it does, and where the fast lanes are.

- Zero-downtime migration — when the source keeps taking writes and the copy is only the first half.

- Error & exit codes — every refusal named here, with its remedy.

---
Canonical page: https://sluicesync.com/docs/sizing/ · Full docs index: https://sluicesync.com/llms.txt
