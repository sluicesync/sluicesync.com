# MySQL's own certificate can't pass verify-full

> The moment you decide to do MySQL TLS properly — tls=true, encrypt and verify the server — the handshake fails against a stock MySQL. Not because anything is misconfigured: the certificate mysqld generated for itself on first boot carries no SubjectAltName, and modern Go won't fall back to the Common Name to check the hostname. The two facts are structurally incompatible, and neither one makes that obvious on its own.

Observed — wiring an authenticated TLS source connection for a MySQL→Postgres sync against a server using its default auto-generated certificate. tls=skip-verify connected but authenticated nothing; tls=true refused the handshake outright with a certificate error, on a server that was working fine.

## What happened

A MySQL server started with no explicit certificate configuration doesn't run plaintext — since 5.7 it generates a self-signed CA and server certificate on first start and enables TLS automatically. So the encryption is there for free. The trouble is verifying it.

The Go MySQL driver's DSN offers a small set of TLS modes: tls=false (plaintext), tls=skip-verify (encrypt, verify nothing), and tls=true (encrypt and fully verify — the equivalent of Postgres's sslmode=verify-full). The obvious secure choice is tls=true. Against a stock MySQL it fails every time, with a hostname-verification error — even though you're connecting to exactly the server that minted the cert.

That leaves an unhappy binary choice: a verify-full mode that can't work, or skip-verify, which encrypts the pipe but authenticates the peer not at all — enough to stop a passive eavesdropper, useless against an active man-in-the-middle who simply presents their own cert. There's no in-between in the driver's DSN grammar.

## Why (the mechanism)

Two independent facts collide:

- MySQL's auto-generated server cert has no SubjectAltName. The Auto_Generated_Server_Certificate MySQL builds for itself puts the hostname (such as it is) only in the certificate's Common Name — the old, pre-2000 place for it. There is no SAN extension at all.

- Go stopped trusting the Common Name. Since Go 1.15, crypto/tls no longer falls back to a certificate's Common Name for hostname verification — a SAN is required. The CN is ignored for name-matching entirely. (This was a deliberate, security-motivated deprecation across the ecosystem, following the CA/Browser Forum; it isn't a Go quirk so much as where every modern TLS stack landed.)

Put them together and verify-full is unreachable by construction: the client demands a SAN to match the hostname against, and the server's certificate simply doesn't have one. The failure isn't &ldquo;your cert is wrong for this host&rdquo; — it's &ldquo;your cert has nothing to match any host.&rdquo; No amount of setting the right hostname helps, because there's no SAN on either side of the comparison.

The missing mode is the one that fits: verify the certificate chains to a CA you trust, and skip only the hostname check the SAN-less cert can't satisfy anyway. That's exactly what Postgres has had all along as sslmode=verify-ca — a real authentication (a cert not signed by your CA is refused) that stops short of binding to a hostname. MySQL's driver has no such named mode; you can only get it by descending into Go's RegisterTLSConfig and building a tls.Config with your CA in RootCAs, InsecureSkipVerify: true to bypass the built-in hostname check, and a custom VerifyPeerCertificate callback that verifies the chain against the CA with no DNS name — which, counterintuitively, still runs even under InsecureSkipVerify. Get the callback subtly wrong (verify against the system pool instead of your CA, or return nil on error) and you've built blind skip-verify wearing a verify-ca label — which is why the load-bearing test is the one that presents a cert signed by the wrong CA and insists the handshake fails.

## Where it bit us

We were making a sync's MySQL source connection authenticated rather than merely encrypted. tls=true was the intended answer and it wouldn't connect; skip-verify connected but defeated the point. The realization was that against MySQL's default certificate there is no DSN mode that both authenticates the server and completes the handshake — the secure-and-working combination lives only in a hand-built TLS config. So sluice grew --source-tls-ca / --target-tls-ca: point them at the CA (MySQL writes one out next to the server cert), and they build the verify-ca config, register it with the driver, and rewrite the DSN's tls= to use it. The connection is then genuinely authenticated — a server not holding a cert signed by that CA fails the handshake — just not hostname-bound, which is the most a SAN-less cert can offer.

## The transferable lesson

MySQL's default TLS posture quietly forces you into verify-ca, and the reason is a two-part gotcha that neither half reveals alone: the server's auto-generated certificate carries no SubjectAltName, and the modern TLS client won't consult the Common Name to make up for it. So tls=true — the mode anyone reaches for when they want to &ldquo;do TLS properly&rdquo; — can never validate a stock MySQL server, and the tooling often presents only that or blind skip-verify, making authenticated TLS look impossible when it's merely unnamed. If you're connecting to any MySQL (or MariaDB, or a managed service) that presents a private-CA or self-signed certificate, the mode you actually want is verify-ca: trust the CA, verify the chain, skip the hostname the cert can't satisfy. Postgres names it for you; with MySQL you may have to build it yourself — and the one thing you must not get wrong is that &ldquo;skip the hostname&rdquo; is not the same as &ldquo;skip the CA.&rdquo;

## Primary sources

- MySQL Reference Manual — Creating SSL and RSA Certificates and Keys using MySQL: the server auto-generates a self-signed CA + server certificate at first startup when none is configured, identifying the server in the Common Name rather than a SubjectAltName.

- Go 1.15 release notes — crypto/tls: the deprecated, CommonName-based fallback for hostname verification is disabled by default; certificates must carry a SubjectAltName. (The x509ignoreCN GODEBUG that briefly re-enabled it was removed in Go 1.17.)

- PostgreSQL documentation — SSL Support: sslmode=verify-ca verifies the certificate chains to a trusted CA; only verify-full additionally checks that the certificate's name matches the host.

---
Canonical page: https://sluicesync.com/field-notes/mysql-cert-no-san/ · Full docs index: https://sluicesync.com/llms.txt
