# A poller that re-reads all of history every tick

> A backup broker rebuilt its entire lineage chain on every 30-second tick — one object-store GET per manifest, even when nothing had changed. On a week-old stream that's ~2,000 GETs a tick, forever, with a tick that could outlast its own interval. The cost was tied to the age of the stream, not the size of the change.

Observed — the backup broker following a live backup chain on object storage to replay new increments into a target. Internally the broker chain-cache fix.

## What happened

The broker follows a growing backup chain and, every 30 seconds, replays whatever is new into the target. To find "what's new," it rebuilt the entire lineage chain from the root on every tick — one object-store GET plus a JSON decode per manifest — even when nothing had changed since the last tick. On a week-old stream rolling over every 5 minutes, the chain is ~2,000 manifests, so an idle tick did ~2,000 GETs, and a single tick could take longer than the 30-second interval that was supposed to trigger the next one.

## Why (the mechanism)

The walk was O(history) per tick — not quadratic, but a per-tick cost that grows linearly with total accumulated history and never levels off. A poller that re-derives its state from the full history on every interval has a cost bound to the age of the stream rather than the size of the change, so the steady-state (nothing happened) is also the expensive case, and it gets more expensive every day the stream runs. On object storage the sting is doubled: each chain-walk read is a billed GET with real network latency, so "re-read everything, find nothing changed" is both slow and a line item.

## What sluice does about it

Cache the walked chain, keyed on a cheap change-token: the raw-byte identity of the two objects that are rewritten whenever the chain changes — lineage.json (rewritten on every structural change) and the tail manifest (rewritten in place per checkpoint). Read the token before the rebuild, so a racing writer can only ever make the cached key look older, never let a stale chain be served — the worst case is one unnecessary rebuild, never a wrong answer. An idle tick drops from ~2,000 GETs to exactly two.

## The transferable lesson

A polling system that re-derives its state from full history on every tick has a per-tick cost that grows without bound as the history grows — invisible on day one, a self-inflicted slowdown (and a storage bill) by week two, precisely because the idle path is the expensive one. The fix isn't to poll less often; it's to make "nothing changed" cheap: cache on a small change-token, validate the token before the expensive rebuild, and order the reads so a concurrent writer can only invalidate conservatively. This is the same family as two other things that bit this project — rewriting the whole manifest per chunk and re-encoding the whole state blob per checkpoint — all three pay for the entire accumulated size on every small step, and all three pass every fresh, small-scale test and only bite with age or volume.

## Primary sources

- Object-store request cost & latency (why per-tick GET counts matter) — S3 request pricing.

- Change-token / conditional-read patterns — HTTP conditional requests (ETag/If-None-Match, the same idea applied to a cache key).

- sluice's backup chain & broker — Sync from a backup chain.

---
Canonical page: https://sluicesync.com/field-notes/poll-cost-grows-with-history/ · Full docs index: https://sluicesync.com/llms.txt
