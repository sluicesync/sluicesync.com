# Postgres rounds your fractional seconds through a C double

> PostgreSQL parses a timestamp's fractional seconds as rint(strtod(fraction) * 1000000) — the digit string goes through an IEEE-754 double before rounding, so the result is not exact decimal round-half-even: .0001255 becomes 125.4999…µs in the double and rounds to .000125, where exact half-even on the digits gives .000126. A textbook half-even reimplementation agreed with PG on every hand-picked boundary value and silently diverged on ~0.1% of 7-digit fractions.

Observed &mdash; building the Postgres arm of sluice's engine-faithful temporal-literal normalization (the parent arc), caught by a value-fidelity review before the tag: the wrong rounding never reached a published binary. The engine behavior itself is by design and decades-stable (datetime.c, unchanged through PG 16/17); observed live on PG 16.14, 2026-07-23.

## One line of datetime.c

When Postgres parses '2026-01-15 10:00:00.0001255', the fractional-second digits don't go through decimal arithmetic. The line is:

    fsec = rint(strtod(fraction) * 1000000);     /* datetime.c */

    '.0001255'  strtod -> the double nearest 0.0001255, which is a hair BELOW it
                * 1e6  -> 125.4999...          rint -> 125    (exact half-even: 126)
    '.0001265'  lands a hair ABOVE             rint -> 127    (exact half-even: 126)

The rule is nominally round-half-even &mdash; rint under the default rounding mode &mdash; but the digit string becomes an IEEE-754 double first, and most decimal fractions aren't exactly representable in binary. An input that sits exactly on a decimal .5&micro;s boundary lands slightly above or slightly below it as a double, and then rint isn't rounding a half at all &mdash; it's rounding whichever side the binary landed on. Exact decimal half-even on the digits gives a different microsecond on roughly 0.1% of 7-digit fractions.

## The bit-for-bit Go reproduction is two standard-library calls

Reproducing this faithfully sounds like it needs C interop. It doesn't &mdash; it needs the same two semantics, which Go's standard library provides exactly:

    f, _ := strconv.ParseFloat("0."+digits, 64)  // correctly-rounded parse == strtod
    micros := int64(math.RoundToEven(f * 1e6))    // rint under the default mode

strconv.ParseFloat is a correctly-rounded IEEE-754 parse &mdash; the same double strtod produces &mdash; and math.RoundToEven is rint's default behavior. Byte-equivalent, no cgo. The trap was the plausible alternative: sluice's first cut implemented textbook exact-decimal half-even on the digit string &mdash; the rule the documentation-level description of PG's behavior suggests &mdash; and it agreed with the server on every hand-picked boundary value in the test set before diverging in the wild of the full input space.

## Hand-picked boundaries cannot gate a rounding mode

That's the durable lesson, and it's about testing, not floating point. Boundary values you pick by hand are the ones your mental model says are hard &mdash; and both implementations shared the mental model, so they agreed exactly there. The divergence lives where the binary representation disagrees with the decimal one, which no human shortlists. The shipped gate is a randomized server-as-oracle sweep: several hundred random fractions per run, half of them forced onto exact-half decimal boundaries (the population where the two rules can split), each one's parse compared against a live Postgres, seed logged for replay. That pins the class &mdash; any future re-derivation of the rounding that isn't double-mediated fails within a run or two, instead of shipping green.

## The transferable lesson

When you reimplement an engine's parsing or rounding, reproduce its computation, not its documented rule &mdash; the two differ exactly at the boundaries you care about, and the computation is often easier to copy than the rule is to get right (here: two stdlib calls). And when the property under test is a rounding mode, a comparison function, or any dense mapping, hand-picked cases are structurally incapable of gating it: randomize the input, use the real system as the oracle, and log the seed.

## Primary sources

- sluice v0.99.291: pgFractionMicros (internal/rowpredicate/predicate.go &mdash; the datetime.c citation and the observed divergence pair) and the randomized real-PG fraction sweep in the temporal ground-truth matrix (half the samples forced onto exact-half boundaries, seed logged); the exact-decimal first cut was RED against this oracle on live PG 16.14 before the correction &mdash; both cuts landed inside the same release.

- PostgreSQL source &mdash; src/backend/utils/adt/datetime.c, the rint(strtod &hellip; * 1000000) fractional-second parse.

- Go standard library &mdash; strconv.ParseFloat (correctly-rounded), math.RoundToEven.

- Related field note &mdash; one literal, three verdicts (the cross-engine arc this rule is the Postgres arm of).

---
Canonical page: https://sluicesync.com/field-notes/postgres-fractional-seconds-double/ · Full docs index: https://sluicesync.com/llms.txt
