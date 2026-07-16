# Object stores can now say "that changed since you read it" — the portability layer can't ask

> Every writer of a backup chain shared one read-modify-write JSON catalog with no arbitration — last Put wins, loser's update silently vanishes. The fix wants compare-and-swap on the object, and the major stores now have it — but the portable object-store surface exposes only create-if-absent. You can build a CAS out of create-only (since ground-truthed live on real S3). You can also be honest about the millisecond window it can't close — and about the fact that the primitive that would close it exists upstream, one abstraction layer away.

Observed — hardening sluice's backup-chain catalog (ADR-0160, shipped v0.99.246), then ground-truthed against real AWS S3 (us-east-1, 2026-07-16): conditional-PUT enforcement, exactly-one-winner concurrency, and sluice's own coded conflict refusal all observed end to end through the production path. The unguarded race was real but never field-observed; the design constraint — no portable conditional overwrite — turned out to be a property of the portability layer, not the stores, and that reversal is the note.

## What happened

A sluice backup chain has one structural record: a lineage catalog, a JSON object listing every segment and its parentage. Every writer — full-backup finalize, cron'd incrementals, stream rollovers, compaction, prune — loaded it, mutated it in memory, and Put it back whole. Two concurrent writers (two cron incrementals, a backup racing a prune, an operator double-start) interleave, the last Put wins, and the loser's structural update silently vanishes: a lost catalog append at best, a mis-parented chain at worst. The data chunks themselves are write-once at distinct paths; the catalog read-modify-write was the one unguarded shared object.

The textbook fix is conditional overwrite — Put-if-ETag-matches, a true CAS on the object. The stores themselves have it: AWS S3 gained conditional writes in late 2024 — If-None-Match creates and, with them, If-Match ETag overwrites — GCS has always had generation-match preconditions, Azure has If-Match. But sluice's cloud backends ride a portable abstraction (gocloud.dev/blob), and the portable surface exposes exactly one conditional primitive: create-if-absent (mapping to If-None-Match: * on S3 and Azure, a generation-0 precondition on GCS, O_EXCL on local files). No If-Match — the writer options simply have no field for it (verified in source: nothing in v0.46.0's blob/ handles it, and no plan is visible). For years that was the fleet's fault — S3 had no conditional writes at all, and the portable layer tracked the floor of the fleet. The floor has moved; the abstraction hasn't.

## Building CAS from create-only

The catalog write becomes a compare-and-swap on a chain write-generation, arbitrated by create-only claim markers at the chain root (lineage.gen/g-<N>):

- Observe, then read. At load, list the markers and record the max claimed generation — before reading the catalog. The order is load-bearing: reversed, you can observe past a competitor's just-landed update and silently clobber it; observe-first turns that window into a spurious-but-safe conflict.

- Claim, then Put. At write, create marker g-<observed+1>. Create-if-absent guarantees exactly one concurrent writer wins the slot; the loser's create fails and the write refuses loudly — coded, with the marker's forensic body (host, pid, timestamp) pointing at the other writer — having changed nothing.

- GC a trailing window of old markers after success.

The liveness property is the part worth stealing: an orphaned marker from a crashed writer is not a stale lock. The next writer's observation lists markers, not catalog content, so the orphan simply becomes the new base and the next generation is claimed after it. No TTLs, no leases, no clock trust, no manual unlock. The rejected alternative makes the contrast sharp — storing the generation counter inside the catalog would turn a crashed claim into a permanent conflict with the recorded counter, a bricked chain needing manual repair. Listing markers as the observation source is what buys lock-free liveness.

## Verified on the real thing

The scheme was originally pinned against MinIO and derived for AWS from documentation; a 2026-07-16 probe against real S3 (us-east-1) closed that gap, both at the raw API and through sluice's production path. Raw layer: If-None-Match: * PUT returns 200 on a fresh key and 412 PreconditionFailed on an occupied one; two concurrent conditional PUTs on one fresh key produce exactly one 200 and one 412, final content the winner's. Through sluice's own BlobStore (gocloud's s3blob), eight concurrent claim attempts produced exactly one winner and seven coded losers, and the full interleaved-writer scenario ended in the coded SLUICE-E-BACKUP-CHAIN-CONFLICT refusal naming the other writer's marker, with the loser having written nothing. The library genuinely sends the header — s3blob.go sets IfNoneMatch = "*" when asked, and a 412 on a PUT is only possible if a precondition was sent and enforced server-side. Real create-only CAS, end to end, no silent-ignore.

One nuance the probe surfaced without reproducing: under truly simultaneous in-flight conditional PUTs, S3 can hand the loser a 409 ConditionalRequestConflict instead of the 412. gocloud maps only the 412 to the failed-precondition error the guard's conflict branch keys on, so a 409 loser would fall through to the guard's capability-degrade path — an unguarded write plus a WARN whose &ldquo;the store may not support conditional PUTs&rdquo; wording would be wrong in that instant. Safe direction (the loser is unguarded, never corrupted-by-guard, and the store's own arbitration already refused it), but it's a mapped-wrong degrade rather than the coded refusal; sluice v0.99.263 closed it by treating the 409 as a conflict, not a capability signal — a 409 means another conditional request was in flight and nothing was written, so the PUT is retried once (a clean retry means this writer won after all), and any still-contended outcome routes to the coded chain-conflict refusal, never the degrade path. The transferable half: when you build on a conditional primitive, audit the error mapping too — a store can refuse your precondition with a status your library doesn't translate.

## The residual, stated honestly

A create-only CAS narrows the race; it cannot close it. Claim and Put are two operations, and a competitor whose observation lands inside another writer's claim-to-Put window — normally milliseconds, a marker PUT followed by the catalog PUT of an already-marshaled body — reads the pre-Put catalog, claims the next generation, and both writers Put unconditionally: last-write-wins again, undetected. The guard shrinks the silently-vulnerable window from the whole seconds-wide read-modify-write span to that millisecond gap. (The probe confirmed the window is real on live S3: the final catalog Put is an unconditional 200-overwrite.) True closure needs conditional overwrite on the catalog object itself — and the same probe confirmed that primitive now exists on the store: If-Match PUT returned 200 against the current ETag and 412 against a stale one, exactly the lost-update refusal the catalog wants. Closure no longer waits on the provider; it waits on the portability layer growing If-Match, or on a per-provider SDK write (aws-sdk-go-v2's PutObject takes it today). That residual is documented in the ADR and accepted for v1 — a guard whose limits you can state is worth more than one you believe is airtight.

## The transferable lesson

If your coordination lives on an object store, inventory the conditional primitives you actually have — and check which layer is withholding them. Portably it may be create-if-absent and nothing else, even when every store underneath now offers conditional overwrite; the constraint that shapes your design can belong to the client library, not the service. Know the two patterns create-only buys you: exactly-one-winner arbitration (claim markers) and lock-free liveness (observe the markers, not the guarded object, so a crashed claimant is a base, not a blocker). Order matters twice (observe before read; claim before put), and the honest accounting matters most: create-only CAS is a race-narrower, the claim-to-Put gap is the price of building on the one primitive your abstraction exposes — and when the missing primitive appears one layer up, say so, because that turns &ldquo;accepted residual&rdquo; into &ldquo;closable, per-provider, whenever it's promoted.&rdquo; This is the same family as our database-side note that CREATE &hellip; IF NOT EXISTS is not a lock — existence checks arbitrate creation, never modification.

## Primary sources

- gocloud.dev/blob — WriterOptions.IfNotExist and its per-provider mapping (S3/Azure If-None-Match: *, GCS generation-0, local O_EXCL); no If-Match field in v0.46.0 (verified in source).

- AWS S3 — conditional requests: If-None-Match creates and If-Match ETag overwrites (GA November 2024); 409 ConditionalRequestConflict on overlapping in-flight conditional writes.

- Real-AWS ground-truth probe (2026-07-16, us-east-1) — the 412/409 matrix, exactly-one-winner concurrency, and wire-level confirmation that gocloud sends the precondition header through sluice's own BlobStore path.

- sluice ADR-0160 — the backup-chain concurrent-writer guard: the marker scheme, the rejected alternatives, and the claim-to-Put residual.

---
Canonical page: https://sluicesync.com/field-notes/object-store-create-only-cas/ · Full docs index: https://sluicesync.com/llms.txt
