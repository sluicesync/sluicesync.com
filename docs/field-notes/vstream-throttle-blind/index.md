# vtgate erases the throttle signal: every VStream consumer is throttle-blind

> Our stream went silent under a write burst, a progress watchdog called it a failover hang, the process restarted, resumed at the same stuck position, and stalled again — indefinitely. The one in-band signal that would have said “this is a throttle, wait” is deleted before any client can see it.

Observed — PlanetScale/Vitess source over VStream, and confirmed against a self-hosted Vitess-24 cluster. Internally Bug 141.

## What happened

A continuous sync from PlanetScale wedged into a crash-loop during a write burst. The stream went silent; our 45-second progress watchdog interpreted the silence as a failover hang and restarted the process; it resumed at the same stuck position and stalled again — indefinitely. From the outside, a throttled-but-healthy stream looked identical to a broken one, so the watchdog did exactly the wrong thing.

## Why (the mechanism)

Finding this took a self-hosted Vitess cluster and per-event instrumentation, and the cause is in Vitess itself. The tablet sets VEvent.Throttled only on heartbeat events. But vtgate then drops every tablet heartbeat — the source comment reads literally &ldquo;Remove all heartbeat events for now.&rdquo; — and synthesizes its own, flag-less heartbeats in their place. The single in-band signal that distinguishes &ldquo;this stream is throttled, wait&rdquo; from &ldquo;this stream is hung&rdquo; is erased before any external gRPC client can observe it. So no VStream consumer can tell a throttled stream from a hung one. Worse, under heavy throttle vtgate goes fully silent — no events, no heartbeats — for up to ten minutes before dropping the stream, which is precisely the shape that trips a naive progress watchdog.

Two corollaries we confirmed while chasing it: upsizing the cluster does not clear a replica-lag throttle (the throttler gates on lag, not CPU), and the throttle is shard-scoped, so routing to the primary doesn't escape it.

## The repro

There's no one-line repro — surfacing it took a self-hosted Vitess-24 cluster plus per-event VStream instrumentation to see the Throttled flag get set on the tablet and then vanish at vtgate. The behavior is legible directly in the public source, though: the tablet-side flag on heartbeats in go/vt/vttablet/tabletserver/vstreamer/vstreamer.go, and vtgate's heartbeat-dropping plus flag-less synthesis in go/vt/vtgate/vstream_manager.go (the &ldquo;Remove all heartbeat events for now&rdquo; comment and the surrounding synthesis). Reading those two files side by side shows the signal being created and then deleted before it can leave the gateway.

## What sluice does about it

Since the in-band throttle flag can't reach us, sluice can't treat silence alone as a failure. The watchdog was made throttle-aware: a silent stream is no longer sufficient evidence of a hang, and the resume/restart logic no longer fights a throttle by restarting into the same stuck position (which never helps — the throttle is shard-scoped and lag-driven, so a fresh connection lands in the same wait). The operator-facing guidance is documented so a throttled stream reads as &ldquo;waiting on the source,&rdquo; not &ldquo;broken.&rdquo;

## The transferable lesson

&ldquo;No data for a while&rdquo; is ambiguous, and if the protocol's disambiguating signal is stripped in transit, a watchdog built on silence-means-dead will amplify a backpressure event into an outage. When you consume a stream you don't control, find out whether &ldquo;throttled&rdquo; and &ldquo;hung&rdquo; are actually distinguishable on the wire before you build automatic recovery on the distinction — and if they aren't, make silence a non-fatal state rather than a restart trigger.

## Primary sources

- Vitess source (public): tablet-side Throttled flag in go/vt/vttablet/tabletserver/vstreamer/vstreamer.go; vtgate heartbeat handling in go/vt/vtgate/vstream_manager.go (github.com/vitessio/vitess).

- Vitess tablet throttler (gates on replica lag) — vitess.io tablet-throttler docs.

---
Canonical page: https://sluicesync.com/docs/field-notes/vstream-throttle-blind/ · Full docs index: https://sluicesync.com/llms.txt
