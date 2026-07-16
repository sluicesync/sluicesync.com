# The Parquet library nulled every false — and the round-trip test couldn't see it

> Hand parquet-go rows as map[string]any and it decides NULL-vs-present for optional columns by asking whether the Go value is the zero value — so false, 0, -0.0, "", the epoch, and midnight all silently export as NULL. The sharper half is why nobody notices: a Parquet NULL's accessors read back as exactly the Go zero value, so a naive write-then-read test writes false, reads false, and goes green while the file says NULL.

Observed — building sluice's backup export-as-parquet surface (ADR-0164, v0.99.251), against parquet-go/parquet-go v0.30.1. Caught at implementation and independently re-verified by the pre-land value-fidelity review; the silent-null shape was never in any published version of sluice.

## What happened

sluice's Parquet export feeds rows to parquet-go as map[string]any — the natural shape when your rows are dynamically typed. parquet-go's map-row deconstruction has to decide, for each optional column, whether the entry is present or NULL, and it decides with reflect.Value.IsZero: a Go zero value in an optional column is treated as parquet NULL.

That single inference nulls an entire family of perfectly legitimate SQL values: boolean false, integer 0, float 0.0 and -0.0, the empty string, the zero time (and with it any epoch instant or midnight time-of-day that encodes to it), day-zero dates, an unscaled-zero decimal. Every one of them is a real, present value in the source database. Every one of them would have exported as NULL.

## Why the obvious test is blind

The reason this class survives testing is structural, not sloppiness. In Parquet, a NULL value's accessors return the type's default — which in Go-shaped terms is exactly the zero value. So the naive round-trip oracle:

    write false  ->  read back  ->  got false  ->  green

passes perfectly while the file durably says NULL. The test is blind at precisely the values the bug eats, because at the accessor layer NULL and zero are indistinguishable. The only honest oracle reads below the accessor layer, where presence is first-class — parquet-go's raw column values expose value.IsNull(), and any downstream engine (DuckDB, Spark) will show you the NULL too. It's the columnar cousin of a discipline we learned the hard way on database targets: ground-truth on the layer where the two outcomes actually differ, not on a layer that collapses them.

## What sluice does about it

The fix is one named wart at one chokepoint: boxLeafValue wraps every scalar leaf value in a pointer before it enters the writer. A non-nil pointer is never &ldquo;zero,&rdquo; so the presence signal becomes what SQL semantics demand — nil means NULL, everything else means the value. (List elements are unaffected; parquet-go's repeated path doesn't zero-collapse, and that's pinned too.)

Two kinds of test keep it honest. First, IsNull()==false pins on every zero-shaped value in every type family, asserted on the raw column values, at both the unit level and against a live-Postgres integration corpus. Second — and this is the part we'd argue for anywhere — a tripwire that proves the wart is real in the pinned library version: it deliberately bypasses the boxing, writes a bare false, and asserts it comes back NULL. If a future parquet-go upgrade changes the upstream semantics, that test fails loudly and says so, instead of leaving boxLeafValue behind as cargo-cult defensive code nobody remembers the reason for. Assert your workaround's necessity, not just its effect.

As of this writing the behavior is unfiled upstream with parquet-go (pinned v0.30.1). It may well be intended map-row semantics — at this API level there is no presence opt-out akin to omitempty — which is a design question for upstream, but the trap for integrators is real either way.

## Reproducing it

Minimal Go program against parquet-go v0.30.1 (adapted from sluice's tripwire pin), then let DuckDB be the below-the-accessors oracle:

    package main

    import (
        "os"
        "github.com/parquet-go/parquet-go"
    )

    func main() {
        schema := parquet.NewSchema("row", parquet.Group{
            "v": parquet.Optional(parquet.Leaf(parquet.BooleanType)),
        })
        f, _ := os.Create("out.parquet")
        w := parquet.NewGenericWriter[map[string]any](f, schema)
        w.Write([]map[string]any{{"v": false}})   // a bare Go zero value
        w.Close()
        f.Close()
    }

    $ duckdb -c "SELECT v, v IS NULL FROM 'out.parquet'"
    -- v = NULL, IS NULL = true      <- the false was exported as NULL

Read the same file back through parquet-go's row accessors and you get false — green to any naive round-trip. Boxing the value as a pointer (map[string]any{"v": &b}) exports it present. (DuckDB also confirms the fix: v = false, IS NULL = false.)

## The same export refused another silent-loss shape

A supporting beat from the same chunk: Postgres does not declare array dimensionality in the type system — int[] and int[][] are one and the same column type — so a Parquet schema derived from the catalog can only ever say LIST<element>. When a multi-dimensional value shows up at export time, the faithful options are refuse or flatten, and flatten is exactly the silent dimensionality collapse we've been burned by before (a numeric[][] that quietly became one-dimensional through a different codec). The export refuses loudly. If your schema-derivation step can't know the shape, the value-encoding step must not guess it.

(A cheerful aside for the analytics-minded: sluice's backup chunks are JSON-Lines under gzip, which DuckDB reads directly via read_json_auto — the zero-export path. The Parquet surface exists for when you want columnar files; the wart above is what it cost to make them faithful.)

## The transferable lesson

A serialization library that infers presence from value shape makes every zero-shaped value a silent-loss candidate — false, 0, "", and the epoch are data, not absence, and any bridge from SQL to such a library needs an explicit presence signal (a pointer, an option type, a validity bit) rather than trusting the value to speak for itself. And test it at the layer where NULL and zero are distinguishable: round-trip tests that read through accessors will wave this entire class through, green, forever.

## Primary sources

- parquet-go — GenericWriter over map[string]any rows and the raw column-value API (Value.IsNull) used as the honest oracle.

- Apache Parquet format — definition levels: presence in an optional column is first-class metadata, distinct from any default value.

- sluice ADR-0164 — backup export-as-parquet; &ldquo;The zero-value-as-null wart (named, pinned)&rdquo;.

---
Canonical page: https://sluicesync.com/field-notes/parquet-zero-value-null/ · Full docs index: https://sluicesync.com/llms.txt
