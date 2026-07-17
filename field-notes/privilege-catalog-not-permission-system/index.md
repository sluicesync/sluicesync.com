# The privilege catalog is not the permission system

> Three live-proven ways a cloud provider's privilege catalog lied, in both directions. On RDS the master role shows rolreplication=f permanently yet creates and drops logical slots, because the capability is gated on membership in rds_replication, not the role attribute — so the stock "rolsuper OR rolreplication" preflight false-refuses the entire platform. On RDS MySQL, SHOW GRANTS shows RELOAD yet FLUSH TABLES WITH READ LOCK returns 1045. And a capability probe checked pg_create_event_trigger — a predefined role that exists in no stock PostgreSQL. The catalog describes a permission model; it is not the permission model.

Observed — live throwaway probes of AWS RDS PostgreSQL 16 and RDS MySQL during the v0.99.263 validation cycle (2026-07-16), each instance created, exercised, and torn down. The sluice-side false refusals fixed in v0.99.263; the platform behaviors are AWS by design. All three are ways the privilege catalog — pg_roles, SHOW GRANTS, a predefined-role membership check — disagreed with the permission system that actually adjudicates the operation.

## False negative: the role that can't replicate, but does

The RDS master role shows rolsuper=f, rolreplication=f — permanently, by design — and yet it creates and drops logical replication slots without complaint. RDS gates that capability on membership in the rds_replication role, not on the rolreplication attribute the catalog exposes. Any preflight that checks rolsuper OR rolreplication — the obvious, stock-correct query, and the one sluice shipped — false-refuses the entire platform, and by the same model all of Aurora. Worse, the refusal was deliberately given no opt-out flag, on the premise that &ldquo;the role genuinely cannot create a slot&rdquo; — a premise RDS quietly falsifies — and all three of its recovery suggestions were wrong or lossy there, so an RDS user could never even reach a refusal that contained a remedy that worked. The fix keeps the catalog check but adds the membership rule: pg_has_role(current_user, 'rds_replication', 'MEMBER'), guarded on the role's existence so a stock server still reads cleanly.

## False positive: the grant that's present but not honored

On RDS MySQL, SHOW GRANTS for the master user lists RELOAD — the privilege FLUSH TABLES WITH READ LOCK requires. Run FTWRL anyway and it returns 1045 Access denied. The platform blocks the operation above the grant layer, so the classic &ldquo;grant RELOAD and retry&rdquo; remediation is a dead end no grant can open. The honest hint sluice now emits doesn't promise a grant fixes it: it says the lock-free fallback is expected here, and to quiesce writers if the brief no-freeze window matters for the snapshot's consistency.

## The probe that was wrong everywhere

The event-trigger capability check tested membership in pg_create_event_trigger — a predefined role that exists in no stock PostgreSQL. PG 16's only pg_create* predefined role is pg_create_subscription. So the check evaluated to &ldquo;not a member&rdquo; on every host, making that capability tier effectively superuser-only everywhere, and it was doubly wrong on RDS, where the master role can create event triggers. This one wasn't a provider quirk at all — it was a phantom role name that made the catalog probe meaningless on every server.

## Why the fixes use different probe strategies

The transferable part is that the two Postgres hazards demanded opposite probe strategies, for a concrete reason. The event-trigger check became attempt-based: CREATE EVENT TRIGGER inside a transaction that always rolls back. An attempt is the only check that can't drift from a provider's patched permission model — it asks the permission system the exact question instead of reading a catalog that may not reflect it. But the slot check deliberately stayed catalog-based, with the membership rule added, because slot creation is non-transactional: a crashed attempt-probe leaks a slot that pins WAL on the source until someone drops it, and slot creation also fails for non-permission reasons an attempt would mis-attribute to a permission problem. The rule is: attempt-probe a capability when the attempt is cheap and fully reversible; read the catalog (correctly) when the attempt has a cost or a side effect a rollback can't undo. Closing beat, same provider: RDS couples wal_level to automated backups — set retention to 0 and wal_level drops to minimal, one notch below the replica every CDC doc assumes — so the cost-minimized instance is two steps from CDC-ready, not one.

## The transferable lesson

A privilege catalog is a description of a permission model, maintained by the same people who can override the model out of band — so on a managed platform it lies in both directions: a capability you have that the catalog denies (membership-gated, not attribute-gated), and a capability the catalog grants that the platform blocks above it. When correctness depends on whether an operation will actually succeed, and the operation is cheap and reversible, ask by attempting it inside a rolled-back transaction rather than by reading a catalog row. And when the attempt is not reversible — a slot that leaks, a change that persists — read the catalog, but read the whole permission model, membership rules included, not just the one attribute column that looks like the answer.

## Primary sources

- AWS RDS documentation — rds_replication role membership for logical replication; mysql.rds_* configuration and the RELOAD/FTWRL restriction on managed MySQL; the wal_level / backup-retention coupling.

- PostgreSQL documentation — predefined roles (pg_create_subscription; there is no pg_create_event_trigger) and pg_has_role().

- sluice v0.99.263 changelog and the RDS-Postgres / RDS-MySQL probe reports — the false-refusal fix, the membership-aware slot preflight, the attempt-based event-trigger probe, and the FTWRL and wal_level findings.

- Related field note — replication slots don't die with your process (why an attempt-probe that leaks a slot is the strategy you avoid).

---
Canonical page: https://sluicesync.com/field-notes/privilege-catalog-not-permission-system/ · Full docs index: https://sluicesync.com/llms.txt
