# pgx's AfterConnect replaces, it doesn't chain

> pgx stdlib gives you one slot to run setup on each new physical connection. Install two features through it — a session GUC pin and a PostGIS codec registration — and the second silently evicts the first. Whichever you register last is the only one that runs. No error, no warning; one of your two features just quietly stops working, on exactly the connections that need it.

Observed — while wiring an engine-wide extra_float_digits pin as a per-connection default (Bug 194's belt, shipped v0.99.265). Caught during code review before it shipped, so this was never a released defect — but the trap is one refactor away for anyone using pgx's connection hooks, so it is worth writing down.

## What happened

Fixing a float-rendering class (a server default of extra_float_digits=0 rounds floats rendered as text) called for a belt-and-suspenders default: every pgx pool sluice opens should run SET extra_float_digits = 3 on each new physical connection. Why per-connection rather than trusting the typed decode path? Because the typed lanes are only immune while pgx returns binary results. A DSN carrying default_query_exec_mode=exec or simple_protocol flips pgx to text results, where the float decoder parses whatever the session happened to render. So the pin has to be a genuine per-connection default, not a one-shot on a single connection.

The natural home for that is stdlib.OptionAfterConnect — a callback pgx runs after each connection opens. The problem is its shape: it is a single option that holds one function, and registering it replaces whatever was there. It does not chain. sluice's change applier already used AfterConnect to register the PostGIS geometry codec on its connections. Installing the float pin as a pool default the obvious way would have overwritten that registration — so the geometry codec would silently stop loading on exactly the pools that apply CDC changes. Wire it the other way and the pin is the one that gets dropped. Either ordering is a silent one-or-the-other: two features, one slot, last writer wins.

## The mechanism, stated plainly

OptionAfterConnect is a set-the-callback API, not an add-a-callback API. It reads like registration — &ldquo;run this after connect&rdquo; — but it is assignment: the field holds exactly one function, and each call clobbers the previous one. Two independent features that both legitimately need per-connection setup collide with no diagnostic, because assignment doesn't fail; it just wins.

## What sluice does about it

The fix is a one-line compose helper that explicitly chains hooks — it wraps the existing callback so both run, in order — and every place that needs AfterConnect installs through it. It is unit-pinned, so a future third hook can't quietly reintroduce the eviction: the test asserts that composing two hooks runs both.

## The transferable lesson

When a library exposes a single-slot callback for per-connection (or per-anything) setup, treat &ldquo;install my hook&rdquo; as &ldquo;overwrite whoever's hook was there.&rdquo; Before you add one, grep for existing installers of the same slot — and if you find one, don't reorder the two calls and call it fixed, because the collision will come back the next time someone adds a third. Make composition the only supported way to install: a helper that chains, and a test that fails if a raw assignment sneaks back in. This is the connection-hook cousin of a broader rule — a single-writer slot is a shared resource, and shared resources need an arbiter, not a convention.

## Primary sources

- pgx stdlib documentation — OptionAfterConnect (the per-connection callback and its last-wins assignment semantics) and the query exec modes (exec / simple_protocol) that select text vs binary results.

- sluice Bug 194 review finding F2 and CHANGELOG v0.99.265 — the engine-wide extra_float_digits per-connection pin, the geometry-codec collision, and the composeAfterConnect helper with its unit pin.

- sluice field note — the one-line fix that unpinned itself through the pooler (the float-rendering class this belt backs up).

---
Canonical page: https://sluicesync.com/field-notes/pgx-afterconnect-replaces/ · Full docs index: https://sluicesync.com/llms.txt
