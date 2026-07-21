# Staged (wave) migration — a few tables at a time

> Move your biggest or most self-contained tables first, cut them over, then bring the rest across in later waves.

Not every migration wants to be one event. On a large database it is often safer to move the biggest or most self-contained tables first, cut the application over for just those, let them bake in production for a while, then bring the rest across in later waves. Each wave is small enough to reason about, and a problem in wave 3 doesn't implicate the tables that have been running fine since wave 1.

sluice supports this today. This guide covers the two mechanisms, which one to use on which source engine (they are not interchangeable), how foreign keys constrain your wave ordering, and the one thing sluice deliberately does not do: replicate writes back from the target to the source.

## Two mechanisms

 · One growing stream · Several independent streams ·

Shape · a single --stream-id whose table scope expands · one --stream-id per wave, running side by side ·

Add a wave with · sluice schema add-table · another sluice sync start ·

Cut over · all tables together, at the end · per wave, independently ·

Postgres source · supported · unsafe today — see the caveat below ·

MySQL / PlanetScale / Vitess source · supported · supported ·

The distinction that matters is whether you need to cut waves over independently. If the point of staging is to de-risk the copy — everything lands eventually, in one cutover, but you'd rather not snapshot 4 TB in a single run — use one growing stream. If the point is to de-risk the cutover — wave 1 serving production traffic from the target while wave 2 is still copying — you need independent streams, and today that means a MySQL-family source.

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

On Postgres, give each stream its own --slot-name — without it every stream lands on the default sluice_slot and they collide. sluice prepends sluice_ if your name doesn't already start with it, so every slot stays findable:

    sluice sync start ... --stream-id wave1 --slot-name wave1   # creates slot "sluice_wave1"

Postgres sources: don't run concurrent streams with different table scopes. The replication slot is per-stream, but the publication is not — every Postgres-source stream shares a single publication (sluice_pub) and scopes it to its own table list at cold start, replacing the whole set. Cold-starting a second wave against the same source therefore drops the first wave's tables out of the publication: its slot stays healthy and keeps advancing, but it silently replicates nothing from that moment on. Until this is addressed, on a Postgres source use Mechanism A, or run waves strictly sequentially — fully stopping one wave's stream before cold-starting the next. MySQL, PlanetScale, and Vitess sources are unaffected (they have no publication). The fix is designed in ADR-0175.

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

- Confirm your source engine supports the mechanism you want. Independent per-wave cutover needs Mechanism B, which needs a MySQL-family source today.

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
