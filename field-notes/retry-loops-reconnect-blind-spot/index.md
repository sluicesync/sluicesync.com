# Your retry loop's blind spot is its own reconnect — and the errors there arrive with their causes stripped

> Three multi-day soaks against real managed infrastructure each died on an error the retry machinery was built for but couldn't recognize. The machinery existed and worked; the gap was classification coverage, twice over: a gRPC transport drop reported under the one status code a careful policy refuses to blanket-retry, and a reconnect failure inside the retry loop itself, where the driver flattens 'the peer dropped your pooled connection' into bare text with the structured cause gone.

Observed &mdash; sluice's multi-day soak fleet (PlanetScale MySQL, PlanetScale Postgres, Cloudflare D1), 2026-07. Every death was LOUD &mdash; clean exit, named error, durable resume position, zero data loss; each restart warm-resumed and drained its backlog in minutes. Fixed across sluice v0.99.286 and v0.99.288.

## Three deaths, one class

The soaks died hours apart on routine transients: a VStream read returning rpc error: code = Internal desc = server closed the stream without sending trailers after ~17 healthy hours; a D1 poll hitting net/http: TLS handshake timeout and, separately, a plain HTTP 500; and &mdash; the sharpest one &mdash; a ~30-second network blip where the stream error was correctly classified, the retry engaged&hellip; and the reopen died terminal at open target change applier: mysql: ping: invalid connection. In every case the bounded-retry machinery already existed. It just couldn't see these errors: the classifier is interface-driven, and these shapes arrived without the wrapper.

## The two coverage gaps

From the stream: grpc-go reports a routine long-lived stream drop under codes.Internal &mdash; exactly the status a careful retry policy refuses to blanket-retry, because a genuine server-authored Internal is a fault that must stay loud. The fix has to discriminate the transport-authored wordings (server-closed-without-trailers, unexpected EOF, RST_STREAM) from a server-authored Internal by message text, because the code alone cannot tell you.

From the reconnect: every retry attempt first re-establishes its connections &mdash; and a failure there is a site most classifiers never covered, in a wire format that has lost its cause. go-sql-driver reduces &ldquo;the peer dropped your pooled connection&rdquo; to the bare text invalid connection; pgx v5 flattens multi-host connect errors so even errors.Is(err, syscall.ECONNREFUSED) misses a refused dial. At the driver boundary you often have nothing but text. And the class keeps paying out: the very next post-release regression cycle caught two more sibling wordings (the Windows connectex: &hellip; actively refused dial text, and pgx's conn closed from a severed pool connection &mdash; the latter now honoured via pgconn's own SafeToRetry contract, whose definition is exactly the property a retry classifier wants: the error is guaranteed to predate any byte reaching the server), shipped a release later in v0.99.289 along with the SQLSTATE-level transients (57P01&ndash;57P03, class 08) the trigger-CDC poll's transport classifier had deferred.

Update &mdash; the ladder kept extending, twice. A third instance arrived within a day of the second (Bug 200, fixed v0.99.290): the retry stack's own APPLY path dials too. When a target restart severs the pool, the next apply's pool acquire (Postgres) or begin tx (MySQL) dials fresh into the refused window &mdash; and neither applier classifier had a dial-shape leg, so a mid-outage CDC apply exited terminally with zero retries, making the whole v0.99.288/289 connect-retry stack unreachable whenever writes were pending during the outage (the realistic case; the focus checks had passed only because they stopped the target with no writes in flight). Three instances on a ladder &mdash; the stream reopen, the connect phase, the apply path's own dial &mdash; give the thesis its short form: every seam that can dial is a classification site. Then a fourth instance (v0.99.291) proved the corollary. The mechanism this time was not a missing site but maintenance drift: the transient-shape vocabulary lived in four hand-mirrored lists (trigger-CDC poll, pipeline connect phase, both engine appliers' text legs), and within ONE release of Bug 199 they had already diverged &mdash; the Windows dial wordings never reached the trigger-CDC list, so a postgres-trigger-source sync on Windows still exited terminally on a routine managed-PG restart, the exact class fixed twice one file over. The fix collapsed all four sites onto one single-homed matcher (internal/nettransient) with per-site corpus-parity change-detectors, so a one-sided addition or a site that stops delegating fails CI. Corollary: if the sites can't share one classifier they WILL drift &mdash; single-home the list, and parity-gate every consumer against it.

## What sluice does about it

Classify positively and narrowly, at the site that still holds the signal. Structured checks first (sentinels, net.Error timeouts, syscall errnos, pgconn's SafeToRetry contract), then a pinned text-fallback list for the shapes that reach you as prose &mdash; and the list is a change-detector test, so widening the retry surface fails a pin instead of slipping in. Everything unmatched stays terminal: wrong DSN, bad credentials, unknown host, and every unknown shape. The bounded budget is the loud-failure floor either way &mdash; a target that never comes back exhausts it and fails with the cause named.

## The transferable lesson

A retry loop is only as good as its classifier's coverage, and the coverage has more sites than the happy read path: the reconnect inside the retry loop is itself a failure site. Audit where errors can arrive, not just where they usually do &mdash; and expect the driver boundary to hand you text with the structure stripped, so classify by positive match with a pinned shape set and let the budget, not the classifier, be your guarantee against looping forever.

## Primary sources

- sluice v0.99.286 and v0.99.288 CHANGELOG entries + the shared trigger-CDC transient classifier and the connect-phase marker/shape-matcher (internal/engines/internal/triggercdc/transient.go, internal/pipeline/streamer_connect_retry.go), each with both-ways shape pins.

- grpc-go transport error wordings under codes.Internal; go-sql-driver's ErrInvalidConn; pgx v5 pgconn.SafeToRetry.

- Related field note &mdash; the heartbeat that aged seven hours (what the soak fleet is for).

---
Canonical page: https://sluicesync.com/field-notes/retry-loops-reconnect-blind-spot/ · Full docs index: https://sluicesync.com/llms.txt
