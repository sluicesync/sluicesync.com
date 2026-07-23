# Your retry loop's blind spot is its own reconnect — and the errors there arrive with their causes stripped

> Three multi-day soaks against real managed infrastructure each died on an error the retry machinery was built for but couldn't recognize. The machinery existed and worked; the gap was classification coverage, twice over: a gRPC transport drop reported under the one status code a careful policy refuses to blanket-retry, and a reconnect failure inside the retry loop itself, where the driver flattens 'the peer dropped your pooled connection' into bare text with the structured cause gone.

Observed &mdash; sluice's multi-day soak fleet (PlanetScale MySQL, PlanetScale Postgres, Cloudflare D1), 2026-07. Every death was LOUD &mdash; clean exit, named error, durable resume position, zero data loss; each restart warm-resumed and drained its backlog in minutes. Fixed across sluice v0.99.286 and v0.99.288.

## Three deaths, one class

The soaks died hours apart on routine transients: a VStream read returning rpc error: code = Internal desc = server closed the stream without sending trailers after ~17 healthy hours; a D1 poll hitting net/http: TLS handshake timeout and, separately, a plain HTTP 500; and &mdash; the sharpest one &mdash; a ~30-second network blip where the stream error was correctly classified, the retry engaged&hellip; and the reopen died terminal at open target change applier: mysql: ping: invalid connection. In every case the bounded-retry machinery already existed. It just couldn't see these errors: the classifier is interface-driven, and these shapes arrived without the wrapper.

## The two coverage gaps

From the stream: grpc-go reports a routine long-lived stream drop under codes.Internal &mdash; exactly the status a careful retry policy refuses to blanket-retry, because a genuine server-authored Internal is a fault that must stay loud. The fix has to discriminate the transport-authored wordings (server-closed-without-trailers, unexpected EOF, RST_STREAM) from a server-authored Internal by message text, because the code alone cannot tell you.

From the reconnect: every retry attempt first re-establishes its connections &mdash; and a failure there is a site most classifiers never covered, in a wire format that has lost its cause. go-sql-driver reduces &ldquo;the peer dropped your pooled connection&rdquo; to the bare text invalid connection; pgx v5 flattens multi-host connect errors so even errors.Is(err, syscall.ECONNREFUSED) misses a refused dial. At the driver boundary you often have nothing but text. And the class keeps paying out: the very next post-release regression cycle caught two more sibling wordings (the Windows connectex: &hellip; actively refused dial text, and pgx's conn closed from a severed pool connection), fixed on main within hours.

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
