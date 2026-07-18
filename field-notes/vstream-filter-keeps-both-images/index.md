# The change stream that won't drop your row

> Filtering a continuous change stream has one genuinely hard case: a row updated so it no longer matches the filter has to become a target DELETE, or the now-out-of-scope row leaks forever. When you push that filter server-side into someone else's stream — a Vitess VStream rule — the load-bearing question is what the stream emits for a row that leaves the filter. Assume it drops the event and you leak. The Vitess source settles it: for a non-vindex filter, when either the before- or after-image passes, VStream emits the change with BOTH images — so the move-out arrives as a full UPDATE, never dropped. The catch is that it tells you the row touched the filter, not which side matched, so you still have to decide the move direction yourself.

Observed — building continuous filtered sync on the Vitess / PlanetScale VStream path (sluice sync --where, v0.99.278, ADR-0174 Piece 2). Ground-truthed against the vendored Vitess v0.24.2 vstreamer source and proven on a real Vitess-24 cluster.

## The move-out is the whole difficulty

Filtering a one-shot copy is easy — push the WHERE into the read and only matching rows cross the wire. Filtering a continuous stream is the partial-replication problem, and its hard case is the row that leaves the filter: an UPDATE that changes a row so it no longer matches has to become a target DELETE, or the stale, now-out-of-scope row sits on the target forever. Evaluate each event's new image in isolation and you drop that UPDATE (its after-image doesn't match) — a silent leak. Getting it right needs the row's old image too, so you can see it used to be in scope.

## Pushing the filter into someone else's stream

Vitess VStream can filter server-side: each table's rule takes a query, and select * from t where (<predicate>) makes vtgate evaluate the predicate itself — filtering the copy phase and the streaming phase natively, with the source's own collation, no client-side scan. That's the efficient path. But it raised the fear that gates the whole design: when a row updates out of the filter, does VStream deliver a DELETE, or does it just… stop matching the row and silently drop the event? For a filter that isn't on the sharding key, Vitess VReplication has historically had exactly this stale-row caveat. If VStream dropped the move-out, sluice would never see it — and never delete it. The leak would be invisible.

## What the source actually does: both images, if either matches

The answer is in vstreamer.processRowEvent. For each row change it computes whether the before-image passes the filter and whether the after-image passes, then:

    if !afterOK && !beforeOK {
        continue                 // neither in scope -> genuinely dropped
    }
    if !hasVindex {              // a plain --where, no sharding-key term
        afterOK = true           // ...emit BOTH images if EITHER passed
        beforeOK = true
    }

So for a non-vindex filter, a row where either image matches is emitted with both its before- and after-images. A move-out — before-image in scope, after-image out — is not dropped and not reshaped into something lossy: it arrives as a complete UPDATE carrying the old in-scope row and the new out-of-scope row. sluice's client-side row-move table reads that as "was in scope, now isn't" → a target DELETE by key. Validated end-to-end on a real Vitess-24 cluster: filtered copy excludes out-of-scope rows server-side, a move-in becomes an INSERT, a move-out becomes a DELETE, nothing leaks.

## The twist: it tells you *that*, not *which*

The sharp part is what VStream does not tell you. Because it forces both flags true whenever either matched, the event carries both images unconditionally — it reports that the row touched the filter's scope, never which side matched. So you cannot read the move direction off the event; you have to re-evaluate the predicate yourself, on both images, to distinguish a move-in (INSERT) from a move-out (DELETE) from an in-scope update. The server-side filter is an efficiency layer — it thins the stream to rows that matter — but the classification is still yours, and it has to agree with what the server filtered on (which is why the client-side evaluation must reproduce the source's collation exactly; see linking the source's comparator).

One more consequence of "server-side, at open": the VStream copy sends its filter rules to vtgate when the stream is constructed, before your code gets the handle back. A filter applied a moment later — after the stream opens — is too late for the first table's copy, which has already started unfiltered. The predicate has to be threaded into the open, not set afterward, or the first table leaks.

## The transferable lesson

When you push a filter (or a projection, or a subscription) into a stream you don't own, the load-bearing question isn't "will it filter" — it's "what does it emit for a row that leaves the filter." Three answers are common and only one is safe: it drops the event (you silently leak the stale row), it emits a synthetic delete (convenient, but now you trust its delete semantics), or it hands you both images and makes you classify (more work, no lost information). Find out which before you rely on it — read the source or test the move-out explicitly on the real system, because the happy-path "rows I want show up" test passes under all three. Vitess picked the third, which is why a filtered VStream is safe to build a delete-on-move-out on; do not assume the stream you're pushing into made the same choice.

## Primary sources

- Vitess v0.24.2 — go/vt/vttablet/tabletserver/vstreamer/vstreamer.go processRowEvent ("if the target is not sharded, pass both images if either after or before passes"). sluice ADR-0174 Piece 2; the vitesscluster-tagged move-out cluster test.

- Companion field notes — the optimization that trimmed away the column a later feature needed (why the move-out needs the full before-image) and you can't reimplement MySQL's = (why the client-side re-classification must match the source's own evaluation).

---
Canonical page: https://sluicesync.com/field-notes/vstream-filter-keeps-both-images/ · Full docs index: https://sluicesync.com/llms.txt

---
Canonical page: https://sluicesync.com/field-notes/vstream-filter-keeps-both-images/ · Full docs index: https://sluicesync.com/llms.txt
