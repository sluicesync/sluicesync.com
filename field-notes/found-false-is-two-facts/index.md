# found=false is two different facts

> A sync retry loop read the persisted CDC position between attempts to choose 'force a clean re-establishment' vs 'warm resume' — through a (found bool, err error) API whose error it discarded, and both engines report found=false when the read FAILS. So 'the target is down and I could not read the anchor row' was indistinguishable from 'no anchor row exists', and the destructive branch latched. The kicker: a pure reliability improvement made it reachable, by keeping the process alive through the outage window a terminal exit had always masked.

Observed &mdash; the 2026-07-23 blind audit of sluice's sync retry seam, every link code-verified. The destructive latch was reachable in v0.99.288&ndash;v0.99.289 only (it predates them, but a terminal connect exit had always masked it); fixed in v0.99.290.

## The idiom with no channel for &ldquo;I don't know&rdquo;

Go's (T, bool) comma-ok idiom is great for maps, where a lookup cannot fail &mdash; only miss. Put the same shape on a network read and it acquires a third state the signature can't express:

    found, err := readPersistedPosition(ctx)   // err discarded with _
    if !found {
        latch = RestartFromScratch             // "no anchor row" ... or was it
    }                                          // "the read FAILED"?

Both of sluice's engines returned found=false when the read errored, and the caller discarded the error &mdash; so &ldquo;I looked and there is no row&rdquo; (a fact about the data) collapsed into &ldquo;I could not look&rdquo; (a fact about the network). The discriminator used !found to mean the first fact and latched the destructive branch: force a clean re-establishment instead of a warm resume. Mid-outage &mdash; the exact moment reads fail &mdash; is precisely when it ran.

## What the latched branch destroys

On the first successful reconnect after a routine target restart, the forced fresh cold start ignored a perfectly valid persisted position. On native MySQL targets: in-scope tables dropped and re-copied. On idempotent paths the damage is quieter and worse: a re-snapshot whose replication slot is recreated at NOW never replays source DELETEs committed before the new snapshot &mdash; deleted rows persist on the target as silent divergence, exactly where a warm resume would have replayed them from retained WAL. The fix is a rule worth naming: a destructive branch in a resumption state machine requires positive proof of absence &mdash; a successful read observing no row &mdash; never absence of proof. A failed read now leaves the latch at its prior value, defaulting to warm resume whenever any successful read observed the anchor this run.

## The reliability fix opened the window

The latch was old code. What made it reachable was the previous two releases' connect-phase retry hardening &mdash; a pure availability improvement, the kind nobody writes new tests for downstream of. Before it, a mid-outage process died with a terminal connect error, and the fresh process always warm-resumed correctly; after it, the process survived the outage window &mdash; long enough to execute the destruction the latch had been silently arming all along. Every reliability fix extends downstream state machines into failure windows they were never tested in; keeping a process alive through conditions that used to kill it means every latch, cache, and discriminator now runs during those conditions for the first time.

## The transferable lesson

Three, stacked. Never discard the error beside a found flag &mdash; (T, bool) has no channel for &ldquo;I don't know,&rdquo; so the moment a lookup can fail rather than merely miss, the idiom is lying to its caller. Destructive branches demand positive proof of absence, never absence of proof. And when you ship a resilience improvement, re-audit what now executes inside the failure window it created &mdash; the bug it exposes will be older than the fix.

## Primary sources

- sluice v0.99.290: the successful-read-only discriminator (internal/pipeline/streamer_retry.go; both engines' ReadPosition found-on-error semantics), pinned at the retry seam &mdash; transient apply error + failing position read must warm-resume; a genuine successful-read-no-row must still force the clean re-copy.

- The 2026-07-23 audit's D0-4 chain (latch site, the discarded error, the dispatch ranking, and the re-snapshot-at-NOW divergence argument), every link code-verified.

- Related field notes &mdash; your retry loop's blind spot is its own reconnect (the reliability arc that opened the window) and the alert that cleared when the slot died (the same class in a monitor: a failed observation misread as a benign fact).

---
Canonical page: https://sluicesync.com/field-notes/found-false-is-two-facts/ · Full docs index: https://sluicesync.com/llms.txt
