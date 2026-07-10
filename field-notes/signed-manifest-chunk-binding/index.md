# A signature that verified green while restoring the wrong table's rows

> A signed, encrypted backup flattened every table's row chunks into one file-sorted list with no parent-table token. Swap the chunk lists of two tables that share a column set and the signed bytes are byte-identical — every guard passes, and one table's rows restore into the other.

Observed — signed, encrypted backup chains (signing is opt-in). Found by an internal audit of the manifest-signing format; a skeptic confirmed it by execution. Fixed by binding the parent table into both the signature and the encryption.

## What happened

Backup manifest signing exists to make store-level tampering detectable: an adversary with write access to the backup bucket (but not the encryption key) should not be able to alter a signed backup without the signature failing. It caught whole-manifest rollback, change-list truncation, and table renames. But it did not catch one thing: reassigning row chunks between two existing tables that share a column set. Swap the row-chunk lists of orders_2023 and orders_2024 — or any two same-schema shards or multi-tenant clones — and the manifest and lineage signatures both verify GREEN, the encrypted chunks decrypt cleanly, the column-set and row-count checks pass, and table B's rows restore into table A. Silent cross-table corruption, surviving the exact feature built to prevent tampering.

## Why (the mechanism)

A signature only authenticates the associations it actually encodes into its signed bytes. The manifest canonicalization flattened every table's row chunks into one globally file-sorted list of rowchunk | file | sha256 | rowcount tokens — with no parent-table token in each entry. Change chunks bound their replay ordinal; schema deltas bound their table name; row chunks were the gap. So the signed byte stream encoded &ldquo;this set of chunk files exists, with these hashes and row counts&rdquo; but not &ldquo;this chunk belongs to that table.&rdquo; Swapping two same-column-set tables' chunk lists preserves the exact multiset of tokens — same files, same hashes, same counts — so the canonical bytes are identical and the signature still matches. The second layer didn't cover it either: the encrypted-chunk GCM AAD (the authenticated-but-not-encrypted associated data that ties a ciphertext to its context) bound only the manifest identity and the chunk's file path — not the table — so a ciphertext moved between tables still passed its GCM tag.

## The repro

Two tables with the same column set, in a signed encrypted chain; swap their chunk assignments so the per-table totals are preserved:

    # Signed, encrypted backup with two same-column-set tables A and B.
    # A store-write adversary swaps the row-chunk lists in the manifest:
    #   A.chunks <-> B.chunks   (per-table row totals unchanged)
    #
    # Verify:
    #   manifest signature   -> GREEN  (token multiset identical)
    #   lineage signature    -> GREEN
    #   column-set header    -> passes (A and B share columns)
    #   per-table row counts -> passes
    #   GCM chunk decrypt    -> passes (AAD binds path, not table)
    # Restore: B's rows land in A and A's in B. Exit 0.

The audit's skeptic didn't argue this on paper — a throwaway test that swapped the two tables' chunk slices produced byte-identical canonical bytes, confirming the forgery.

## What sluice does about it

The fix binds the parent table on both layers, each independently versioned and fail-closed. The signature canonicalization is bumped v3→v4 to fold each row chunk's (schema, name) into its signed token, reusing the existing length-prefixed framing so the encoding stays injective. Independently, a signed encrypted backup's row-chunk GCM AAD is bumped to a new backup FormatVersion that appends the schema and table to the associated data — so a ciphertext moved between tables fails its GCM tag even without the signature. The dual-version verifier is unchanged: signatures written by older releases still verify byte-for-byte, a v4 signature presented to an older binary refuses as an &ldquo;upgrade sluice&rdquo; version gap rather than a false tamper accusation, and a v4→v3 downgrade-relabel that tried to strip the new parent tokens fails the MAC — so the back-compat path is not a downgrade oracle. Table renames were always caught; this closes chunk reassignment between existing same-column-set tables.

## The transferable lesson

A signature is not a general-purpose integrity charm — it authenticates exactly the bytes you canonicalize, and nothing you leave out. If two genuinely different states can serialize to the same signed bytes, the signature cannot tell them apart, and no amount of key strength changes that. The property to reason about is canonicalization injectivity: distinct logical states must map to distinct signed bytes. When you sign a structure, enumerate every association a consumer will act on after verification — here, which chunk belongs to which table — and make sure each one is inside the signed bytes (and, for encrypted data, inside the AEAD's associated data too). The gap is always the association you assumed was implied.

## Primary sources

- RFC 5116 — authenticated encryption with associated data (AEAD): what the &ldquo;associated data&rdquo; is for and why binding context into it matters.

- NIST SP 800-38D — Galois/Counter Mode (GCM), the AEAD whose AAD now carries the table identity.

- The three-cloud signer feeding these signatures — Three clouds, three ways to return an ECDSA signature.

- sluice's encrypted-backup model — Encrypted backups.

---
Canonical page: https://sluicesync.com/field-notes/signed-manifest-chunk-binding/ · Full docs index: https://sluicesync.com/llms.txt
