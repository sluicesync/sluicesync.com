# Three alerts that could never fire, and nobody noticed because no wrong number was ever reported

> A metric fanned across pods, a selection cascade that honestly refused to guess, and three thresholds that sat silent for months. Honest-but-silent degradation is harder to catch than a wrong value, because everything downstream looks exactly like healthy.

Observed &mdash; PlanetScale control-plane metrics consumed for target-health alerting. Three separate signals, one shared root cause. Fixed in sluice v0.101.0.

## What happened

A storage-utilisation alert had never fired against a Postgres target. Not &ldquo;fired late&rdquo; or &ldquo;fired wrongly&rdquo; &mdash; never, since the day it shipped. The same was true of a replica-lag alert, on both engines. And nobody noticed, for the most uncomfortable reason available: at no point was a wrong number ever reported. The code was scrupulously honest. It simply said &ldquo;I cannot observe this&rdquo; and moved on, and an unobserved metric produces no alert, no error, and no log line anyone reads twice.

## Why the cascade refused

Control-plane metrics for a clustered database are emitted per pod, so a client wanting &ldquo;the write target's disk usage&rdquo; has to pick one series out of several. The obvious way is a cascade of increasingly loose matches, ending in a deliberate refusal:

    0. exact container match      → take it
    1. tablet_type=primary AND
       component=vttablet          → take it
    2. any tablet_type=primary     → take it
    3. exactly one series          → take it
    4. several, none identifiable  → REFUSE (report "unobserved")

Tier 4 is the right instinct: with three indistinguishable pods, guessing gives you a number that is wrong two-thirds of the time, and a wrong disk-usage figure is worse than none. But look at what the Postgres volume metric actually carries:

    planetscale_volume_available_bytes{
      planetscale_component="hzinstance",
      planetscale_pod="hzi-…-useast1c-…",
      planetscale_role="primary"          ← the only discriminator
    } 10133684224

No tablet_type. No container. Only planetscale_role &mdash; which nothing in the cascade read. Three pods, no recognised discriminator, straight to tier 4, forever. The escape hatch that existed for Postgres (match the container name) had been added for CPU and memory, which are emitted per container; the volume pair is emitted per pod and never carried that label at all. The rescue was one metric family short of the metric that needed rescuing.

## Replica lag: a category error, not a label mismatch

Lag failed for a different and more instructive reason. The same primary-selection was applied &mdash; and no primary series exists, on either engine. Obvious in hindsight: a primary has no replication lag. Every lag series is tagged replica, so primary-selection searched for something that cannot exist, found nothing, and refused. Any branch with two or more replicas therefore had lag permanently unobserved.

The right reduction was never &ldquo;pick the primary&rdquo; but &ldquo;take the worst&rdquo; &mdash; an alert cares about the furthest-behind replica &mdash; and on a single-replica branch that degenerates to the same value, which is why nothing looked broken in small deployments.

## And the primary was the wrong pod to watch anyway

Fixing the selector surfaced a third problem. With the primary now readable, the replicas turned out to be consistently fuller:

    role=primary   cell=useast1c   available 10,133,684,224   (5.62% used)
    role=replica   cell=useast1a   available 10,100,211,712   (5.93% used)
    role=replica   cell=useast1b   available 10,100,211,712   (5.93% used)

A storage alert exists to fire before a volume fills. The pod that fills first is the one to watch, and it is not reliably the primary &mdash; so &ldquo;correctly read the primary&rdquo; would still have been the wrong question. The answer is two signals, not one: the primary's figure, because that is the volume your own writes consume and therefore what write-rate throttling should act on; and the fullest pod's, because that is what an alert should watch. Merging them would silently change the meaning of every historical sample already stored.

## The transferable lesson

&ldquo;Unobserved&rdquo; is the correct behaviour and a terrible end state. A system that refuses to guess is right to refuse, but refusal is indistinguishable from healthy at every layer above it: no alert, no error, no anomalous value on a dashboard. If you have a threshold that has never fired, that is not evidence it never needed to &mdash; go and prove the metric behind it is actually being read. And when you consume a metric fanned across replicas, decide deliberately which reduction the question wants: the primary, the worst, or the sum. Each is right for a different question, and picking by habit is how you end up correctly reading the wrong pod.

## Primary sources

- PlanetScale Prometheus metrics (Vitess) and for Postgres &mdash; the per-pod label shapes above.

- Related field note &mdash; found=false is two different facts, the same honesty problem one layer down.

---
Canonical page: https://sluicesync.com/field-notes/alerts-that-could-never-fire/ · Full docs index: https://sluicesync.com/llms.txt
