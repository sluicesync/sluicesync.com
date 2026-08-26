# Your trigger-based CDC can't see replicated writes

> Postgres triggers have a firing dimension most people never touch: a plain CREATE TRIGGER fires for origin sessions only, never for DML applied under session_replication_role = 'replica'. That role is how logical-replication apply workers run — and how replication tools, sluice included, apply their own writes to bypass FK enforcement mid-stream. So a trigger-based capture installed on a database that is itself a replication target is silently blind to every replicated row: the rows land, the change log stays empty, the sync exits 0. And the privileged production applier is blind where the unprivileged dev one wasn't.

Observed &mdash; a 2026-08-26 audit of sluice's pgtrigger engine, ground-truthed on real PostgreSQL 16: an INSERT executed under session_replication_role = 'replica' lands in the table while the capture table records zero rows. A two-shape detection WARN (SILENT-CAPTURE-GAP RISK) shipped in sluice v0.131.5. The capture gap itself is by design still open &mdash; the full fix has its own hazard (below) and is deferred to a design decision; the at-risk topologies remain unsupported for trigger capture.

## The firing dimension nobody sets

Every Postgres trigger carries a firing mode: ENABLE (the default), ENABLE REPLICA, or ENABLE ALWAYS, set via ALTER TABLE &hellip; ENABLE ALWAYS TRIGGER. It interacts with a session-level parameter, session_replication_role: a default-mode trigger fires only when the session's role is origin (or local) &mdash; under replica, it does not fire at all. This is deliberate: replicated DML was already validated and side-effected on the origin, so the subscriber suppresses triggers and foreign-key enforcement rather than running them twice. Logical-replication apply workers run in exactly this mode.

The consequence for change capture: a capture-by-trigger design sees origin writes only. Install audit/capture triggers on a database that is a logical-replication subscriber and every replicated row is invisible to them &mdash; not delayed, not erroring, just absent. The table fills; the change log doesn't. Anything downstream of the capture &mdash; a sync, an audit trail, a cache invalidation &mdash; silently diverges at exit 0.

## The tool that blinds its own relay

The sharp version is self-inflicted. sluice's Postgres applier issues SET LOCAL session_replication_role = replica on each apply transaction when the connecting role holds the privilege (superuser or rds_superuser) &mdash; the standard replication-tool lever for applying rows without tripping FK ordering violations mid-stream. Which means in a relay topology &mdash; A → B applied by sluice, B → C captured by sluice's own trigger engine &mdash; the midpoint's capture triggers never fire for anything the upstream sync delivers. The relay forwards nothing, loudly reports nothing, and exits 0.

The privilege condition inverts the usual dev-vs-prod failure. In dev, the applier typically connects as an ordinary role, can't set replica role, applies as an origin session &mdash; and the capture triggers fire. The relay works. In production, the applier connects privileged, gets the FK-bypass &mdash; and goes dark. &ldquo;It worked in staging&rdquo; is normally evidence the code is fine; here staging worked because it was less privileged, and the environment where the loss fires is exactly the one you didn't test.

## Why ENABLE ALWAYS isn't the free fix

The obvious repair &mdash; install the capture triggers ENABLE ALWAYS so they fire under replica role too &mdash; trades one silent hazard for another. An always-firing capture records replicated echoes: on a relay it re-captures what the upstream already delivered, and on anything bidirectional it is a loop. Doing it safely needs origin-tagging &mdash; a way for the capture to distinguish &ldquo;a real local write&rdquo; from &ldquo;a write my own upstream applied&rdquo; &mdash; which is a design decision, not a flag flip. sluice defers it to its own ADR.

What shipped instead, in v0.131.5, is a detector: at trigger setup and at every stream open, the engine probes for the two shapes that produce the blindness &mdash; a source that is a logical-replication subscriber (pg_subscription), and a source that carries another sluice sync's own apply-target artifacts (the relay shape) &mdash; and emits a SILENT-CAPTURE-GAP RISK warning naming the gap. A probe error also warns rather than silently skipping. It is a detector, not a fix: the remedy it steers to is capturing from the origin instead &mdash; or, where the source supports replication slots at all, using the logical-replication (pgoutput) lane, which reads the WAL and has no trigger-firing blind spot. The trigger lane exists precisely for the slotless managed engines, so the steer is real work, not a link.

## The transferable lesson

Trigger-firing semantics are replication-role-scoped: &ldquo;triggers see every write&rdquo; is only true of origin writes, and the set of non-origin writers includes subscription apply workers, restore paths, and &mdash; easy to forget &mdash; your own tool's applier. Any capture-by-trigger design owes an explicit answer for replica-role writers, and &ldquo;we never sync into a capture source&rdquo; is an answer that a relay topology falsifies the day someone chains two syncs. And when the full fix would trade a silent loss for a silent loop, ship the detector first: a warning that names the blind spot converts works-in-dev/loses-in-prod into a caught misconfiguration, and buys the design decision time to be made in the open.

## Primary sources

- PostgreSQL documentation &mdash; ALTER TABLE &hellip; ENABLE REPLICA / ALWAYS TRIGGER and session_replication_role &mdash; the firing-mode &times; session-role matrix, and the note that logical-replication apply suppresses default-mode triggers.

- sluice v0.131.5 changelog &mdash; the two-probe SILENT-CAPTURE-GAP RISK preflight and its real-PG 16 mechanism pin (replica-role INSERT lands, change log stays empty).

- Related field note: The read replica is a better migrate source and a worse CDC source than the docs &mdash; another capability gated on the session's replication state rather than the SQL you ran.

---
Canonical page: https://sluicesync.com/field-notes/triggers-fire-for-origin-only/ · Full docs index: https://sluicesync.com/llms.txt
