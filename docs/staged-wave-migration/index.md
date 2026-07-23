# Staged (wave) migration — a few tables at a time

> Move your biggest or most self-contained tables first, cut them over, then bring the rest across in later waves.

Not every migration wants to be one event. On a large database it is often safer to move the biggest or most self-contained tables first, cut the application over for just those, let them bake in production for a while, then bring the rest across in later waves. Each wave is small enough to reason about, and a problem in wave 3 doesn't implicate the tables that have been running fine since wave 1.

sluice supports this today. This guide covers the two mechanisms, which one to use on which source engine (they are not interchangeable), how foreign keys constrain your wave ordering, and the one thing sluice deliberately does not do: replicate writes back from the target to the source.

## Two mechanisms

 · One growing stream · Several independent streams ·

Shape · a single --stream-id whose table scope expands · one --stream-id per wave, running side by side ·

Add a wave with · sluice schema add-table · another sluice sync start ·

Cut over · all tables together, at the end · per wave, independently ·

Postgres source · supported · supported — needs a per-stream --publication-name ·

MySQL / PlanetScale / Vitess source · supported · supported ·

The distinction that matters is whether you need to cut waves over independently. If the point of staging is to de-risk the copy — everything lands eventually, in one cutover, but you'd rather not snapshot 4 TB in a single run — use one growing stream. If the point is to de-risk the cutover — wave 1 serving production traffic from the target while wave 2 is still copying — you need independent streams. Both source families support that; a Postgres source additionally needs a per-stream --publication-name (below).

## Mechanism A — one growing stream

Start a stream scoped to your first wave, then extend its scope as you go. The stream keeps one CDC position, one slot, one control-state row.

    sluice sync start \
        --source-driver postgres --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --include-table 'orders,order_items' \
        --stream-id appdb

Later, bring users into the same stream. On a Postgres source this works without draining the running stream:

    sluice schema add-table users \
        --source-driver postgres --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --stream-id appdb --no-drain

schema add-table creates the table on the target, bulk-copies its rows from a consistent snapshot, extends the source publication, and hands the table to the running CDC stream — the same gapless snapshot to CDC boundary a cold start gets. It prompts for typed confirmation (the table name) unless you pass --yes.

--no-drain is Postgres-only in this release. On a MySQL-family source, use the drained workflow: sync stop --wait, then schema add-table, then sync start again. Re-running sync start with the same --stream-id warm-resumes from the persisted position — it does not re-snapshot.

One table per invocation; repeat it per table or script the loop. On a Postgres source this is the mechanism that grows scope safely — it extends the publication additively, so it can't disturb tables already in scope.

## Mechanism B — several independent streams

Each wave gets its own --stream-id, its own CDC position, and — on engines with a replication-slot concept — its own --slot-name. The waves are fully independent: you cut wave 1 over and stop its stream while wave 2 is still snapshotting.

    # Wave 1 — cut over first, weeks before the rest.
    sluice sync start \
        --source-driver mysql    --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --include-table 'orders,order_items' \
        --stream-id wave1

    # Wave 2 — started later, runs alongside wave 1.
    sluice sync start \
        --source-driver mysql    --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --include-table 'users,sessions' \
        --stream-id wave2

--include-table is comma-separated, repeatable, and glob-aware (audit_*), and it scopes both legs — the cold-start snapshot and the live CDC apply. CDC state is keyed per stream, so waves never contend for position. On a MySQL-family source each stream opens its own binlog / VStream reader and there is no shared server-side object to collide over.

### Why Postgres needs two per-stream names

On a Postgres source each wave needs both --slot-name and --publication-name:

    sluice sync start \
        --source-driver postgres --source "$SRC" \
        --target-driver postgres --target "$DST_WAVE1" \
        --include-table 'orders,order_items' \
        --stream-id wave1 --slot-name wave1 --publication-name wave1

--slot-name is the obvious one: without it every stream lands on the default sluice_slot and they collide immediately — a loud, hard-to-miss failure.

--publication-name is the one that matters more, because forgetting it used to fail silently. The replication slot is per-stream, but the publication — the table filter pgoutput applies — is a separate object, and streams that share one fight over it: each cold start scopes the publication to its own table list with ALTER PUBLICATION … SET TABLE …, which replaces the member set atomically. Two waves sharing the default sluice_pub would de-scope each other, leaving the first wave's slot healthy and advancing while it received nothing for its tables.

sluice will not let that happen quietly. A cold start that would remove tables from a publication while another sluice slot exists on that source refuses with SLUICE-E-CDC-PUBLICATION-SCOPE-CONFLICT, naming the at-risk tables and the conflicting slot (labeled active or inactive) — and refuses before mutating anything, so a refused attempt leaves every running stream untouched. Existence, not activity, is the signal (v0.99.289): an inactive slot is a stream someone stopped mid-migration that will resume expecting its scope, so merely stopping a wave doesn't release its claim — decommissioning it does: once a wave is finished for good, sluice sync decommission drops its slot and per-stream publication and clears its control row in one gated command. Widening or equal-scope rescopes remove nothing and never trigger it, so a fleet of same-scope streams and schema add-table are unaffected.

Both flags share the sluice_ prefix convention — wave1 becomes sluice_wave1 — so every sluice-owned source object is findable the same way: pg_replication_slots WHERE slot_name LIKE 'sluice\_%' and pg_publication WHERE pubname LIKE 'sluice\_%'. MySQL, PlanetScale, and Vitess sources have neither object and ignore both flags.

## Foreign keys decide your wave ordering

This constrains wave composition more than table size does. A wave-1 table with a foreign key pointing at a wave-2 table cannot have that constraint created — the referenced table isn't on the target yet. Two ways through:

- Order waves along the FK dependency edges. Parents before children. This is the clean answer when the graph allows it, and it is worth drawing the graph before you pick waves.

- Use --skip-foreign-keys when it doesn't. Cyclic dependencies, or a wave you can't reorder, need the escape hatch. It creates no FK constraints on the target and — importantly — synthesizes a backing index on each skipped FK's referencing columns, so the join performance the FK's index was providing doesn't quietly regress while you wait for the later wave. Every skipped constraint is named in the run's output; add them back after the final wave lands.

This is a different situation from row-level filtering, which orphans children of rows that were filtered out and refuses loudly. See Copy a subset of tables if you're staging by rows rather than by tables.

## Cutting a wave over

Per wave, the sequence is the standard cutover scoped to that wave's tables:

    # 1. Prime the target's identity columns past the source's high-water mark.
    sluice cutover \
        --source-driver mysql    --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --include-table 'orders,order_items' \
        --sequence-margin=1000

    # 2. Flip application traffic for these tables. (Your step, not sluice's.)

    # 3. Drain and stop this wave's stream.
    sluice sync stop \
        --target-driver postgres --target "$DST" \
        --stream-id wave1 --wait

    # 4. Prove it landed.
    sluice verify \
        --source-driver mysql    --source "$SRC" \
        --target-driver postgres --target "$DST" \
        --include-table 'orders,order_items' --depth=sample

cutover takes --include-table too, so a wave's sequences get primed without touching tables that are still source-authoritative. Skipping it is the classic staged-migration failure: application writes to the target start allocating IDs that collide with rows CDC is about to deliver.

Use --wait on sync stop. Without it the stop is asynchronous and late in-flight changes may not have landed.

## Split-brain is yours to prevent

sluice doesn't own the traffic switch — the cutover moment is application-specific. The consequence is that sluice cannot tell whether a wave's tables are still being written on the source.

If writes keep landing on the source after you've cut a wave over, CDC faithfully replicates them on top of the application's writes to the target. Per row, last writer wins, and nothing surfaces as an error — this is the one place in a staged migration where you can lose data quietly. The stream is doing exactly what you asked; the problem is upstream of it.

The only real protection is on the source side, at the moment of cutover: revoke INSERT/UPDATE/DELETE on the wave's tables from the application role, install a rejecting trigger, or take the source write path out of the application entirely for those tables. "We updated the config and believe nothing writes there any more" is not protection — make the source refuse.

## What sluice does not do: write-back to the source

Some managed-import products keep a reverse stream running after cutover, so writes landing on the new database replicate back to the old one and you can fail back if the new database can't take the load. sluice has no equivalent today, and it isn't a small gap.

The blocker is that sluice's CDC apply path carries no origin marker — nothing says "this change is one I applied, don't re-emit it." A reverse sync start running alongside a forward one is therefore a replication loop.

There is a narrower version the wave design makes tractable, worth understanding even though it is not a supported feature: once a wave is cut over and its forward stream is stopped, nothing is streaming those tables source to target any more, so a reverse stream scoped to exactly that wave's tables is table-disjoint from every live forward stream and isn't a loop. What still stands in the way: the source's identity columns would need priming past the target's; a cross-engine reverse needs a reverse-direction schema that round-trips, which the forward migration doesn't guarantee; and it has never been tested. It is a plausible composition of shipped primitives, not a validated path.

If you need genuine fail-back today, keep the source authoritative until you're confident: cut a wave's reads over first, leave writes on the source, and move writes only once the target has proven itself under real read load. That captures most of the risk reduction without a reverse stream.

## Choosing waves: a checklist

- Draw the FK graph. It constrains ordering more than size does. Parents before children; note the cycles that will need --skip-foreign-keys.

- Prefer self-contained clusters. A wave whose tables reference only each other cuts over cleanly and can be verified in isolation.

- Put the scariest table in wave 1, not last. The point of staging is to learn early, on the table most likely to surprise you, while the blast radius is smallest and rollback is still just "keep using the source."

- On a Postgres source, set --slot-name AND --publication-name per wave. Independent per-wave cutover needs Mechanism B, and on Postgres both per-stream names are required for it to be correct. sluice refuses loudly if you forget, but it is cheaper to pass them up front.

- Decide the write fence per wave before you start, not at the cutover window.

- Budget the stream count. Each concurrent wave is a full CDC reader (and on Postgres, a slot). A handful is fine; dozens is not a design, it's a load test.

## Next steps

- Zero-downtime migration — the single-wave cutover flow this guide generalizes.

- Copy a subset of tables — scoping with --include-table in depth, including cross-engine namespace mapping.

- Schema changes during a sync — schema add-table in the broader schema-evolution context.

- Migrate many databases or schemas — staging by namespace instead of by table.

- Verify & reconcile — proving each wave landed before you start the next.

---
Canonical page: https://sluicesync.com/docs/staged-wave-migration/ · Full docs index: https://sluicesync.com/llms.txt
