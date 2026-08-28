# ENABLE ALWAYS fires for everyone

> The prequel note ends on the trap: ENABLE ALWAYS makes triggers fire for replicated writes — including writes you wish it didn't. The sequel is what shipping it actually takes. The posture is not a CREATE TRIGGER clause but a separate ALTER TABLE per trigger; a native subscriber's TRUNCATE, applied through a separate executor path, still fires an ALWAYS statement trigger, observed end-to-end on a real subscription; and Postgres exposes no origin evidence to a trigger, so 'capture replicated writes, except my own applier's' cannot be built — the safety boundary has to move from filtering rows to refusing topologies, keyed on what can recur, not what is currently running.

Observed &mdash; the ground truth behind sluice ADR-0185, on a real two-container PostgreSQL 16 publisher→subscriber pair (CREATE PUBLICATION → CREATE SUBSCRIPTION): with the capture triggers flipped to ENABLE ALWAYS, replicated INSERT/UPDATE/DELETE and TRUNCATE all reach the change log &mdash; observed capture sequence IUDIIT, end to end. Shipped in sluice v0.133.0 as the opt-in sluice trigger setup --capture-replicated-writes, closing the gap the prequel note left deliberately open. This note is what closing it took.

## The posture isn't where you'd write it

PostgreSQL has no ENABLE ALWAYS spelling on CREATE TRIGGER itself. The firing mode is table-level trigger state, set after the fact &mdash; ALTER TABLE &hellip; ENABLE ALWAYS TRIGGER, one statement per trigger, after each create. A capture design that wants the posture therefore emits it as follow-up ALTERs for every trigger it installs &mdash; the row trigger and the FOR EACH STATEMENT truncate trigger &mdash; and re-emits them any time a trigger is recreated. And because the posture is one ALTER away from silently drifting in either direction, sluice records the intended posture in its install metadata and refuses at stream open when the installed enablement doesn't match it: an opt-in install found running plain triggers is silently uncapturing replicated writes, and a plain install found running ENABLE ALWAYS is someone hand-flipping into replica-role capture without the echo-loop vetting below.

## The cell you observe, not assume

A native subscriber does not apply everything through one path. Row DML is applied by the logical-replication apply workers &mdash; the replica-role writers the prequel covers &mdash; but TRUNCATE goes through a separate executor path (apply_handle_truncate in the subscription worker), so nothing about the row-DML result generalizes to it for free. An ENABLE ALWAYS row trigger firing for a replicated INSERT tells you nothing about whether an ENABLE ALWAYS statement-level truncate trigger fires when that other executor runs. The observed answer: it does. On the rig, a replicated TRUNCATE fired the truncate trigger and landed in the change log as an ordinary T event, completing the IUDIIT sequence &mdash; so the full DML+TRUNCATE surface of the plain capture survives the flip, and the opt-in ships with no truncate residual to document.

One residual is stated rather than tested: a subscription created with copy_data = true runs its initial tablesync under replica role too, so the opt-in captures the whole initial copy as ordinary INSERT rows &mdash; genuine rows, but a large burst. The rig pins the live-apply path (copy_data = false); ADR-0185 records the tablesync-burst shape as a noted, untested residual.

## There is no &ldquo;except mine&rdquo;

ENABLE ALWAYS is one bit: fire for everyone. And &ldquo;everyone&rdquo; includes a writer you'd rather it didn't &mdash; your own sync's applier one hop upstream. As the prequel lays out, a privileged replication applier (sluice's included) writes under session_replication_role = 'replica' to bypass FK ordering; to an always-firing capture trigger, those applied rows are indistinguishable from a subscriber's. The fix you want to write is &ldquo;capture replicated writes, but skip the ones my own tool applied&rdquo; &mdash; and it cannot be built honestly at the trigger layer, because Postgres exposes no cheap per-row origin evidence to a plpgsql trigger. Replication origins exist as infrastructure, but their session state isn't visible to a trigger without superuser-ish probing; a capture function can know that it fired, never for whom. So on a relay &mdash; A→B applied by your sync, B→C captured always-firing &mdash; every row the upstream applies would be re-captured and forwarded as a new change: duplicated fan-out at best, unbounded re-application in any cyclic topology.

## Refuse the topology, keyed on existence

Since filtering rows is unbuildable, the shipped safety boundary moves up a level: refuse the topology. When the opt-in is active and the source database also carries sluice's own apply bookkeeping &mdash; the control table an upstream sync writes where it applies &mdash; setup (dry-run included) and every CDC stream open refuse with a coded error (SLUICE-E-CDC-TRIGGER-ECHO-LOOP) naming the loop and the ways out: capture from the origin, decommission the finished upstream and drop its control table, or install without the flag.

The design detail that carries the lesson is what the refusal keys on: the control table's existence, not its liveness. Grading the refusal on heartbeat freshness &mdash; refuse only if the upstream sync looks currently alive &mdash; sounds more precise and is exactly wrong: a paused upstream resumes straight into the loop, and the operational lull while it is paused is precisely when an operator gets around to running setup. Liveness grading under-refuses at the worst possible moment. Existence keying refuses anything that can recur, and leaves an explicit decommission step as the honest way to say &ldquo;this upstream is finished for good.&rdquo; One more edge held closed: a failed probe under the opt-in refuses rather than passing &mdash; a check that gates a refusal must not degrade into permission.

## The transferable lesson

When a capture mechanism cannot distinguish provenance, the safety boundary has to move from filtering rows to refusing topologies &mdash; and a topology refusal should key on what can recur (the machinery's existence), not on what is currently running (its liveness). Two smaller lessons ride along: an always-firing posture that lives in ALTER-able state rather than the trigger's own definition needs its intent recorded and graded, or it drifts silently in either direction; and when the mechanism under test has more than one executor path &mdash; row apply versus apply_handle_truncate &mdash; each path is its own cell, observed on a real rig, not derived from its sibling.

## Primary sources

- PostgreSQL documentation &mdash; ALTER TABLE &hellip; ENABLE ALWAYS TRIGGER and session_replication_role &mdash; the firing-mode &times; session-role matrix; there is no ENABLE ALWAYS clause on CREATE TRIGGER.

- PostgreSQL source &mdash; src/backend/replication/logical/worker.c &mdash; apply_handle_truncate, the subscriber's separate TRUNCATE apply path.

- sluice ADR-0185 and the v0.133.0 changelog &mdash; the opt-in flag, the two-container subscription rig and its IUDIIT pin, the origin-evidence analysis behind rejecting row filtering, the existence-not-liveness refusal design, and the noted-not-tested copy_data = true tablesync residual.

- Prequel field note: Your trigger-based CDC can't see replicated writes &mdash; why default triggers are blind to replica-role writes in the first place; this note is its sequel.

---
Canonical page: https://sluicesync.com/field-notes/enable-always-fires-for-everyone/ · Full docs index: https://sluicesync.com/llms.txt
