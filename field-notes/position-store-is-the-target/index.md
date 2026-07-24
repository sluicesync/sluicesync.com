# The retry budget whose only proof of progress lived in the database that was down

> sluice persists its CDC apply position in a control table on the TARGET — the standard exactly-once move, since the position write rides the batch transaction. But the retry budget's only reset path was a successful position read against that same target, so when the store WAS the outage, progress between outages was never credited: the second target outage of a stream's lifetime exited 'budget exhausted' on its first failures, despite hours of verified progress in between.

Observed &mdash; sluice's v0.99.291 regression cycle (Bug 202), isolated to a deterministic ~60-second repro. Loud and zero-loss: a relaunch warm-resumed and full-table checksums matched, on both affected versions. Reachable in v0.99.290&ndash;v0.99.291 &mdash; precisely since target-outage ride-out first worked (before that, the first outage exited terminally anyway); fixed in v0.99.292.

## The exactly-once move that created the coupling

sluice persists its CDC apply position in a control table on the target &mdash; the standard exactly-once move, because the position write rides the same transaction as the batch it describes: apply and position commit or roll back together. The apply-retry budget sat on top: a bounded count of consecutive failures, so a target that never comes back fails loudly instead of looping forever. Its only reset path was &ldquo;the position read succeeded AND the token advanced&rdquo; &mdash; a read against that same target. Said out loud, the coupling is obvious: the budget's only proof of progress lived in the database whose unavailability it existed to ride out. Nobody said it out loud.

## The second outage

Target outage #1 burns attempts 1&ndash;7; the target returns; the stream converges in-process and applies hours of verified changes. Then outage #2 arrives &mdash; minutes or days later &mdash; and the reset-path read fails, because the store is the outage. The counter inherits the old count, and the first failures of the new outage exit apply retry budget exhausted after 8 consecutive failures at position "" within a second or two. The order differential is what pins the mechanism:

    target outage, then SOURCE outage   -> resets fine (attempt=1)
                                           the position read succeeds; the target is up
    target outage, then TARGET outage   -> never resets
                                           first failure of outage #2 = attempt 8, dead

## Gather the evidence where the outage can't reach it

The fix is an in-memory progress ledger, gathered while healthy, under the same discipline as the found=false note: a failed read is never evidence, in either direction. While each retry attempt flows, a bounded sentinel polls the persisted position on a 5-second cadence and records the latest successful observation; a counted failure is credited with a fresh budget only when some successful, anchor-bearing read showed the token moved since the token recorded at the previous counted failure &mdash; which, because the position rides the batch transaction, proves durable commits happened in between. The loud-failure floor survives intact: a genuinely stuck batch (reads succeed, token frozen) and a never-reachable target (no successful reads at all) both still exhaust in exactly the configured attempts.

## The transferable lesson

Any system that keeps its progress cursor in the store it retries against has this bug latent &mdash; and the class is common, because co-locating the cursor with the writes is the correct exactly-once design; the mistake is only letting the health machinery inherit the co-location. Proving progress must not require reading the thing whose unavailability you are riding out: gather the evidence in memory while the store is reachable, credit it under the failed-reads-are-not-evidence rule, and let the budget stay the loud floor for the cases where no evidence ever arrives.

## Primary sources

- sluice v0.99.292: the committed-progress sentinel and in-memory ledger (internal/pipeline/streamer_retry.go), RED-before-GREEN against the carryover repro (the pin fails with the exact budget exhausted &hellip; at position "" shape when the credit is absent); the two-outage repro script and the source-vs-target order differential, byte-identical pre-fix on v0.99.290.

- sluice ADR-0007 &mdash; the position write riding the apply batch's transaction (why a moved token is proof of durable commits).

- Related field notes &mdash; found=false is two different facts (the sibling: the same discipline applied to a destructive latch, one seam over) and your retry loop's blind spot is its own reconnect (the ride-out arc whose promise this defect quietly halved).

---
Canonical page: https://sluicesync.com/field-notes/position-store-is-the-target/ · Full docs index: https://sluicesync.com/llms.txt
