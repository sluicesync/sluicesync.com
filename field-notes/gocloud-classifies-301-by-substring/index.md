# gocloud classifies "301" by substring — and ~2% of your S3 request IDs contain it

> sluice's backup-chain concurrent-writer guard is a compare-and-swap on S3's create-only conditional PUT: the loser of two racing PUTs gets a 412 PreconditionFailed, mapped to a coded conflict refusal. It was reading that 412 through gocloud's portable error class — and gocloud's s3blob classifier carries strings.Contains(err.Error(), "301"). S3 stamps a random hex RequestID on every response, so whenever that hex happens to contain the digits 301 — about 2% of requests — a genuine 412 is misclassified as NoSuchBucket. Classify from the structured API error, never from a substring of the rendered one.

Observed — surfaced as a v0.99.268 tag-CI flake on TestBlobStore_MinIO_ConditionalPutChainGuard, root-caused and fixed in v0.99.269. No data loss: the misclassification turned a coded conflict refusal into a confusing &ldquo;not found,&rdquo; loud either way — but the guard's whole job is to be legible at the moment two writers race, and this made it lie about why it refused. The gocloud substring hack is present and unchanged in the current release; sluice works around it locally.

## The guard and the status code it keys on

sluice's backup-chain concurrent-writer guard is a compare-and-swap built on S3's create-only conditional PUT (If-None-Match: *): when two writers race to claim the same chain slot, the loser's PUT is rejected with 412 PreconditionFailed, which sluice maps to &ldquo;someone else won, refuse loudly&rdquo; — the coded SLUICE-E-BACKUP-CHAIN-CONFLICT. The correctness of that guard depends on reliably telling a 412 apart from every other S3 error.

## The 2% misclassifier

sluice was reading the 412 through gocloud's portable error class rather than the raw API error. And gocloud's s3blob driver classifies some errors by substring-matching the rendered error string: strings.Contains(err.Error(), "301"), intended to catch an S3 invalid-bucket 301 redirect and map it to NoSuchBucket. The problem is what else contains the digits 301. S3 stamps a random hex RequestID (and HostID) on every response and folds them into the rendered error string. Whenever that hex happens to contain the substring 301 — about 2% of requests — a genuine 412 gets classified as NoSuchBucket, which gocloud surfaces as NotFound.

So the losing writer, perhaps 2% of the time, saw a baffling &ldquo;not found&rdquo; instead of the coded chain-conflict — and it stayed invisible until a CI run happened to draw RequestID 18C30130E2747EAB and flaked the MinIO CAS test. That same ~2% was latent in production the whole time for any real chain-conflict loser; CI just drew the unlucky hex first.

## The fix: read the structured code

The fix stops reading the rendered string entirely. sluice inspects the structured smithy API error — apiErr.ErrorCode() == "PreconditionFailed" — which is a field the AWS SDK populates from the response, not a phrase in a human-readable message. It falls back to gocloud's derived class only for the fileblob/memblob drivers, which carry no API error to inspect. A three-digit HTTP status is a needle; the rendered error string is a haystack full of opaque identifiers that can contain that needle by chance.

## The transferable lesson

Never classify an error by substring-matching its rendered text when a structured code is available. A rendered error string is written for humans and, on cloud APIs, salted with random per-request identifiers — request IDs, host IDs, trace tokens — so any digit sequence you match on will eventually appear by chance in one of them. A heuristic that is &ldquo;usually right&rdquo; on error text is a probabilistic misclassifier the instant that text carries a random ID: it doesn't fail loudly, it fails a stable small fraction of the time, which is the hardest kind of bug to catch. Reach past the portability layer to the provider's structured error code, and keep the string-matching only for backends that genuinely have nothing else.

## Primary sources

- sluice v0.99.269 changelog and fix commit — the smithy ErrorCode() detection with a fileblob/memblob fallback, and the RequestID 18C30130E2747EAB flake that surfaced it.

- gocloud.dev blob/s3blob — the portable error classification, including the 301 substring check in the vendored version.

- AWS SDK for Go v2 (smithy) — the structured API error type and ErrorCode(); S3's RequestId/HostId response fields.

- Related field note — object stores can now say &ldquo;that changed since you read it&rdquo; (the create-only CAS this conflict-classification lives inside).

---
Canonical page: https://sluicesync.com/field-notes/gocloud-classifies-301-by-substring/ · Full docs index: https://sluicesync.com/llms.txt
