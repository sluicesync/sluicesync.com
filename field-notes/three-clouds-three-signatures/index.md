# Three clouds, three ways to return an ECDSA signature

> AWS and GCP hand back an ECDSA signature as ASN.1 DER; Azure returns raw r‖s. Only GCP signs Ed25519, and only GCP wants a CRC32C integrity handshake in both directions. Adding two clouds to a working KMS signer was not a copy-paste — it was normalizing three wire formats to one.

Landed — KMS-backed backup-manifest signing, where the private key stays in the cloud HSM and verification is pure local crypto. AWS KMS came first; GCP KMS and Azure Key Vault completed the three-cloud matrix. Signing is opt-in.

## What happened

sluice can sign a backup manifest with a key that never leaves a cloud KMS: an AsymmetricSign / Sign call returns a signature, and a later restore verifies it locally against the operator's trusted public key. That worked cleanly with AWS. Extending it to GCP KMS and Azure Key Vault behind the same scheme — so a GCP- or Azure-signed chain verifies identically to an AWS one — turned out to be almost entirely about reconciling how each provider encodes what is, mathematically, the same signature.

## Why (the mechanism)

An ECDSA signature is a pair of integers (r, s). There are two common ways to put that on the wire, and the three clouds don't agree:

- AWS and GCP return ECDSA as ASN.1 DER — the SEQUENCE { INTEGER r, INTEGER s } encoding.

- Azure returns raw r‖s — the two integers concatenated as fixed-width big-endian, the IEEE P1363 form, no DER wrapper.

That fixed width is where a specific trap lives: for P-521 each half is 66 bytes (521 bits rounds up to 66 bytes), an odd width that off-by-one conversions get wrong precisely because it isn't a clean power of two. Two more divergences: only GCP offers Ed25519 signing (and Ed25519 signs the whole message with no client-side pre-digest, unlike the ECDSA/RSA-PSS digest-then-sign flow), and only GCP wraps its calls in a CRC32C wire-integrity handshake — the server echoes the CRC of the digest it received and returns a CRC of the signature it produced. Finally, the providers disagree on how they hand you the public key for verification: AWS and GCP export SPKI (the standard SubjectPublicKeyInfo DER), while Azure exports a JWK (a JSON object of base64url key parameters).

## The repro

Ask each provider to sign the same digest with a P-256 key and look at the bytes:

    # AWS KMS  -> DER:      30 44 02 20 <r...> 02 20 <s...>
    # GCP KMS  -> DER:      30 45 02 21 00 <r...> 02 20 <s...>
    # Azure KV -> raw r||s: <32 bytes r><32 bytes s>   (P-256; P-521 = 66+66)

    # A verifier that only speaks DER (ecdsa.VerifyASN1) accepts the first two
    # and rejects Azure's bytes outright -- they must be transcoded r||s -> DER
    # BEFORE they reach the verifier. Get P-521's 66-byte half wrong and the
    # transcode silently produces a signature that never verifies.

## What sluice does about it

The verifier stays single-form: it validates ECDSA as DER and never has to know which cloud produced the signature. The provider-specific work is pushed into the signer adapters. Azure's adapter converts r‖s to ASN.1 DER before returning — and that conversion is pinned across P-256, P-384, and P-521, with P-521's 66-byte half specifically covered, because a codec that dispatches on curve width has to be tested at every width, not one representative. GCP's CRC32C is checked in both directions and any mismatch is refused loudly rather than emitting a possibly-corrupted signature; its Ed25519 path is wired through the same scheme. Azure's JWK public key is rebuilt into a standard-library key (with the RSA exponent range-guarded). Critically, the provider is not recorded in the on-disk format at all — only the algorithm is — so an AWS-, GCP-, or Azure-signed chain all verify by exactly the same code path, and verification always anchors on the operator's supplied trusted key, never a key the manifest names.

## The transferable lesson

&ldquo;We support KMS signing&rdquo; hides a lie of composition: KMS signing is not one API, it is three (or more) APIs that happen to compute the same primitive and then disagree about how to hand it back — signature encoding, public-key export, integrity framing, which algorithms exist at all. If you're going to verify signatures across providers, do the normalization at the edge: convert every provider's native wire form to one canonical form as it enters, keep the verifier single-form, and pin the conversion at every parameter (every curve, every key size) the provider can emit — the P-521 odd-width half is exactly the case a single representative test will miss.

## Primary sources

- RFC 8032 — EdDSA / Ed25519 (signs the whole message, no pre-digest).

- RFC 3279 §2.2.3 — the ASN.1 DER Ecdsa-Sig-Value SEQUENCE { r, s } AWS and GCP return; contrast the raw fixed-width r‖s of IEEE P1363 that Azure returns.

- RFC 7517 — JSON Web Key (JWK), the form Azure Key Vault exports a public key in.

- Google Cloud KMS — data-integrity guidelines — the CRC32C request/response checksums.

- The signature that verified the wrong data — A signature that verified green while restoring the wrong table's rows.

---
Canonical page: https://sluicesync.com/field-notes/three-clouds-three-signatures/ · Full docs index: https://sluicesync.com/llms.txt
