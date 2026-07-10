# The zero value is a loaded gun

> Twice in this project a config field that “defaults on” silently defaulted off (or worse) for every caller that didn't go through the CLI — because in Go, every construction site that doesn't set a field gets the zero value. Both had real database consequences.

Observed — two config-defaulting bugs with database consequences. The first (a CDC resnapshot path) is the v0.99.51 trap behind ADR-0093; the second is Bug 180, an un-extendable encrypted backup chain (fixed v0.99.185).

## What happened

Twice, a config field meant to "default on" silently defaulted off — or to an unreachable value — for every caller that didn't construct it through the CLI. Both looked correct in a unit test and both had a real database consequence: one a CDC resnapshot path, the other an encrypted backup chain you couldn't extend.

## Why (the mechanism)

In Go, every struct construction site that doesn't set a field gets that field's zero value — false for a bool, "" for a string. The CLI is one construction site; every test, every internal broker/chain path, and every future caller is another, and they all get the zero value unless they explicitly set the field. A field named for its on-behavior silently inverts to off for all of them.

- Round one — a boolean defaulting the wrong way. AutoResnapshotOnInvalidPosition was intended to default true. But every test and internal construction that didn't set it got false and took the suppressed branch. The race-detector integration job surfaced it as a nil-deref panic on that branch — an intended-on safety behavior was off everywhere except the CLI.

- Round two — a default that made a feature unreachable, and it shipped. The backup encrypt-mode feature "omit --encrypt-mode to inherit the chain's mode" keyed the inherit branch on an empty string. But kong, the CLI parser, fills the flag's declared default ("per-chain") whenever the operator omits it — so no CLI invocation could ever produce the empty string the inherit branch needed. The branch was dead from the parser's side. The unit test passed "" directly and went green, sailing right past the layer that made it unreachable. The operator-visible result: extending or resuming a per-chunk-encrypted backup chain via the natural "omit the flag" invocation was refused.

## The repro

    type Streamer struct {
        // intended to default ON — but every caller that doesn't set it
        // gets the zero value (false) and silently takes the OFF branch:
        AutoResnapshotOnInvalidPosition bool
    }

    s := Streamer{}          // a test, a broker path, a future caller...
    // s.AutoResnapshotOnInvalidPosition == false  -> suppressed branch

    // The kong variant: a direct-call test cannot see a default the parser injects.
    //   flag omitted on the CLI -> kong fills "per-chain" -> inherit branch (keyed
    //   on "") is unreachable; but a unit test that passes "" directly goes green.

## What sluice does about it

Two rules fell out, both now project doctrine. First: name a boolean config for its opt-out (SuppressX, NoX), never EnableX-defaulting-true-by-intent, so the zero value is the safe, common behavior and no construction site can silently invert it. Second: pin any omitted-flag semantics through the real argument parser, not a direct call — a unit test that hands the function a value the parser would never produce (an empty string kong fills with a default) proves nothing about the actual CLI path. Bug 180's fix is verified end-to-end: omitting --encrypt-mode now resolves to "", flows to the orchestrator, and correctly inherits the chain's mode, so an incremental into a per-chunk chain succeeds and restores byte-exact.

## The transferable lesson

In any language with zero-value initialization, the default that matters is the one an unset field takes, not the one your primary constructor writes — and your CLI is only one of many constructors. Make the zero value the safe, common case. And when a behavior is gated on a specific config value, especially an omitted or empty one, test it through the real parser: a framework default (kong, argparse, a builder's fallback) can quietly make a branch unreachable while a direct-call unit test that supplies the value by hand stays green. The green test is testing a code path no user can reach.

## Primary sources

- Go zero values — the language spec on zero values.

- kong, the CLI parser sluice uses (default injection) — github.com/alecthomas/kong.

- sluice encrypted-backup chains and modes — Take encrypted backups and Sync from a backup chain.

---
Canonical page: https://sluicesync.com/docs/field-notes/zero-value-config-trap/ · Full docs index: https://sluicesync.com/llms.txt
