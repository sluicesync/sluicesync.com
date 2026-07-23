# One cancel, three different errors — database/sql's abort identity depends on where the cancel lands

> Cancel a context mid-way through a database/sql loop and the error you get back is chosen by scheduling: 'sql: statement is closed' when the pool reaps the prepared statement out from under you, 'context canceled' when the exec observes it directly, or a driver-specific message on a Commit/BeginTx/Prepare. All three mean 'we were cancelled' — but errors.Is(err, context.Canceled), or a retry classifier, sees three different identities. Normalize at the single return boundary, not per call site.

Observed &mdash; sluice's Cloudflare D1 --stage-local staging path, surfacing the way these always do: a release-tag CI run went red on a build byte-identical to one that had passed the same -race job two hours earlier. Fixed in sluice v0.99.288 (present, latent, since the staging path landed in v0.99.167); never a safety issue &mdash; the stage always aborted correctly, only the error's identity was nondeterministic.

## The error-identity lottery

The staging loop makes five kinds of DB calls &mdash; BeginTx, Prepare, exec, Commit, and the pool's own statement management &mdash; and a context cancel can land on any of them. Each surfaces the abort differently:

    cancel lands on...            error you get back
    the exec itself               context canceled
    the pool reaping the stmt     sql: statement is closed
    Commit / BeginTx / Prepare    driver-specific message

All three mean the same thing. But the test asserted errors.Is(err, context.Canceled) &mdash; and a production retry classifier makes exactly the same kind of judgment &mdash; so which identity came back was decided by the scheduler. Under the CI -race scheduler it flaked; on a developer machine it &ldquo;always&rdquo; passed.

## Placement, not cleverness

The first instinct &mdash; wrap the cancel at the failing call site &mdash; covers one of five sites and leaves the class open. The fix is a named-return defer at the function's single return boundary: if the context is done and the outgoing error chain doesn't already carry it, wrap the error with ctx.Err() &mdash; preserving the driver detail underneath. Done there, a sixth DB call added to the loop next year cannot reintroduce the nondeterminism; done per-site, it can. Stress-verified 50/50 on the previously flaky test.

## The transferable lesson

database/sql under cancellation is an error-identity lottery across its call sites, and any errors.Is on a cancellation identity &mdash; in a test or in a retry classifier &mdash; is a flake until someone guarantees that identity. Guarantee it where the guarantee can't rot: normalize the outgoing error at the return boundary, wrapping rather than replacing so the underlying cause survives for the log line.

## Primary sources

- sluice v0.99.288 CHANGELOG (the D1 cancelled-stage fix) and the 50/50 stress verification; the flake record from the v0.99.287 tag CI.

- Go database/sql &mdash; statement lifecycle under context cancellation; driver.ErrBadConn semantics.

- Related field notes &mdash; the JSON cursor that teleported and int64 at the JSON boundary (the same family: Go-boundary behaviors that only bite under specific runtime conditions).

---
Canonical page: https://sluicesync.com/field-notes/one-cancel-three-errors/ · Full docs index: https://sluicesync.com/llms.txt
