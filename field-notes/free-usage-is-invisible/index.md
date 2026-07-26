# Your usage is invisible in the API for exactly as long as it's free

> The billing API omits every $0.00 line item, so a metered-but-unbilled resource returns nothing at all. The metrics endpoint can measure it — but its counters live on pods that rotate away, and the textbook increase() rule reads routine backend skew as counter resets and over-counts by 2.2×.

Observed &mdash; PlanetScale Postgres egress, measured against billing over three invoice snapshots and ~34 hours of one-minute polling (8,024 samples across four databases). Investigation, not a defect report: no product change resulted, but three wrong conclusions did, in sequence.

## The question

How much data is leaving this database? It sounds like a question with an answer, and the platform exposes two places to look: a billing API with invoice line items, and a Prometheus metrics endpoint with byte counters. Both of them mislead, in different and instructive ways.

## The invoice API omits what it does not charge for

The invoice line items came back with compute and storage, and no egress row at all. The obvious inference &mdash; egress is not billed here &mdash; is wrong, and the way it is wrong is worth internalising.

Comparing the API's response against a CSV export of the same invoice, joined on line-item ID, gives an unambiguous rule:

    CSV export       532 line items
    JSON API         225 line items
    missing          307  — of which $0.00: 307  (100%)
    returned         225  — of which $0.00:   0  (0%)

The API omits every zero-cost line item. Egress on this account is metered at a rate of $0.00 per 1 GB, so its rows &mdash; carrying real, non-zero quantities &mdash; are dropped for having a zero price. The categories that vanish are precisely the usage-based ones: storage-per-byte, IOPS, throughput, development-branch seconds, and egress.

So the resource is measured, the measurement is retrievable by a human via CSV export, and the API will not return it for exactly as long as it remains free &mdash; and would silently start appearing the day it became chargeable. Any integration that reads &ldquo;no egress row&rdquo; as &ldquo;no egress&rdquo; is not merely wrong; it is wrong in the direction of confident zero.

## The metrics endpoint can measure it, if you accumulate correctly

The metrics endpoint exposes the bytes directly. Summing the current values, though, gave a figure roughly 70&times; below the billed quantity &mdash; and the counters looked frozen for an hour at a stretch while the database was demonstrably committing transactions.

The counters are not broken; they are per edge pod, and the pod fleet rotates. Watching one branch across two hours:

    series count      8  →  6      (two connectors vanished, one appeared)
    surviving pod  2,156 → 90,445   (+88,289 — monotonic, as a counter should be)
    SUM           295,608 → 301,327 (+5,719 — because the departed pods
                                     took 196,379 bytes with them)

Every individual series is a well-behaved counter: monotonically increasing, reset to zero on restart, exactly as the Prometheus contract specifies. But a point-in-time sum across an ephemeral set is not cumulative anything. Pods that served traffic and then rotated away are simply gone from the total.

## The trap: the textbook rule over-counts by 2.2&times;

The standard fix is per-series accumulation &mdash; what increase() does: track each series, sum its deltas, and treat any decrease as a counter reset by crediting the new value. Over a clean 24-hour window that reconstructed egress to within 39% and 124% of billed &mdash; worse than the naive sum on one database.

The reason is a detail the contract does not cover. This endpoint's values dip constantly: 350 and 1,255 small decreases in that window, with the sample's own embedded timestamp still advancing and several series dipping in the same scrape. That is backend-view skew &mdash; successive scrapes served by replicas with slightly different views &mdash; not a counter restart. A representative event:

    901,858 → 900,640     a 0.14% dip

    textbook rule: "decrease ⇒ reset" ⇒ credit the ENTIRE 900,640 bytes
    reality:       the true delta was −1,218

One misread dip injects the whole counter. With a skew-tolerant rule instead &mdash; accumulate against a per-series high-water mark, and treat a decrease as a genuine reset only when it falls below a relative threshold of that mark &mdash; the same data reconstructs to 0.98&times; and 1.09&times; of billed.

                        billed      textbook increase()   high-water rule
    soak-pg231       0.442 MB/h    0.614  (1.39×)         0.432  (0.98×)
    d1cdc-pg         0.075 MB/h    0.168  (2.24×)         0.082  (1.09×)

## What is still unexplained &mdash; stated as such

One residual has no explanation and should not be dressed up as one. Over an earlier window, the same method reconstructed one database to 1.01&times; and another to 2.21&times;. Most of that gap turned out to be an artifact &mdash; the second database's stream was down for 7.5 hours of an 18-hour billing window, so the metrics covered only its active time &mdash; but correcting for the outage still leaves roughly 1.28&times; unaccounted for, between two databases on the same tier, in the same region, with identical pod counts, over the same window, with no series churn or counter resets on either. That is a question for the vendor, not a settled method.

## The transferable lesson

Three separate lessons fell out of one question, and each one first arrived as a wrong answer:

- An API that filters by one attribute can hide a different one entirely. A price filter silently became a quantity filter. Ask what your data source omits, not just what it returns &mdash; and treat &ldquo;no row&rdquo; as unknown, never as zero.

- Correct counters plus an ephemeral series set do not sum to a cumulative total. The contract is per series; the fleet is not.

- The standard accumulation rule assumes decreases are resets. On an endpoint with backend skew that assumption is expensive, because each misread costs an entire counter rather than a small error.

The meta-lesson is the one that cost the most: every intermediate conclusion here was internally consistent and confidently held, and each was overturned by a source that was independent of the previous one. If a measurement matters, get a second source before you build on the first &mdash; the CSV export is what falsified the API, and billing is what falsified the metrics.

## Primary sources

- Prometheus &mdash; counter semantics and increase(), including its reset handling.

- PlanetScale invoice line items API (requires the read_invoices scope) and the pricing dimensions that list egress for Postgres.

---
Canonical page: https://sluicesync.com/field-notes/free-usage-is-invisible/ · Full docs index: https://sluicesync.com/llms.txt
