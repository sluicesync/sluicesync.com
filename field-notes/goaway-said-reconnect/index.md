# The transport said “please reconnect”; the driver reported “your request is malformed”

> HTTP/2's polite drain arrives through gRPC as InvalidArgument, because the status code describes the envelope-parse failure rather than your request. A classifier that correctly treats InvalidArgument as terminal therefore kills an unattended stream on routine platform maintenance.

Observed &mdash; a PlanetScale/Vitess CDC stream against a managed source. Fixed in sluice v0.101.0; loud and zero-loss, but the stream stayed down until a human restarted it.

## What happened

A continuous replication stream exited on its own, cleanly, with this:

    rpc error: code = InvalidArgument desc = protocol error: incomplete envelope:
    http2: server sent GOAWAY and closed the connection;
    LastStreamID=1, ErrCode=NO_ERROR, debug="graceful_stop"

Nothing was wrong. An edge pod was being rotated &mdash; ordinary platform maintenance &mdash; and the server did precisely what the protocol says it should: it sent a GOAWAY frame carrying NO_ERROR, which is HTTP/2's way of saying &ldquo;this connection is going away; open a new one.&rdquo; It is the politest thing a server can do before disappearing.

## Why a correct classifier gets this wrong

The trouble is where that message surfaces. gRPC hands it up as codes.InvalidArgument &mdash; and InvalidArgument means, in every sane reading, the caller sent something wrong. Retrying a malformed request unchanged is the textbook thing you must not do: it burns the retry budget and masks a real fault. So a careful client treats InvalidArgument as terminal, and that rule is right.

The rule is right and the outcome is still wrong, because the status code is describing a different subject than you think. It is not classifying the operator's request; it is classifying the envelope parse that failed when the connection went away mid-frame. The transport's &ldquo;please reconnect&rdquo; has been re-labelled, by the layer in between, as the application's &ldquo;you asked wrongly.&rdquo;

That is the transferable shape, and it is not specific to gRPC or HTTP/2: when a lower layer's condition is reported through a higher layer's vocabulary, the code you switch on may be answering a question you did not ask. Any place you map a transport event onto an application-level taxonomy, some conditions arrive wearing the wrong label.

## The fix, and the part that must not be simplified

The recovery is trivial &mdash; reconnect &mdash; but the detection has one trap worth stating plainly. It is tempting to match on the word GOAWAY. Do not. A GOAWAY is only benign when its error code is benign:

    ErrCode=NO_ERROR            → graceful drain; reconnect (retriable)
    ErrCode=PROTOCOL_ERROR      → the peer rejects how you are speaking
    ErrCode=ENHANCE_YOUR_CALM   → you are being throttled off
    ErrCode=INADEQUATE_SECURITY → your TLS posture was refused

Those last three are the peer telling you that reconnecting identically will fail identically. So the predicate has to be a conjunction &mdash; a GOAWAY and a no-error code &mdash; which is precisely what a plain substring match cannot express. Implementations also attach a free-text debug field (vtgate sends debug="graceful_stop"); that is corroborating only, and must not be load-bearing, because it is a peer-chosen string that can change without notice while the standards-defined error code cannot.

One further sharp edge: the same drain reaches more than one call site. In a Vitess deployment it hits the replication reader directly, and it also arrives on the write path wrapped inside a MySQL Error 1105, because vtgate packages the upstream gRPC status into a MySQL error for its clients. Fixing the reader alone leaves the writer exposed to the identical event.

## The transferable lesson

If you operate against a managed platform, its pods rotate; that is not an incident, it is Tuesday. Any long-lived connection you hold will be drained, politely, on someone else's schedule. Ask what your client does with that drain &mdash; and specifically, ask whether the status code you branch on is describing your request or describing the plumbing. A continuous process that stops on routine maintenance is not continuous, and the failure looks like a clean exit rather than a crash, so nothing pages anyone.

## Primary sources

- RFC 9113 &sect;6.8 &mdash; GOAWAY, and &sect;7 error codes (NO_ERROR = 0x00).

- gRPC status code definitions &mdash; what INVALID_ARGUMENT is meant to signify.

- Related field note &mdash; your retry loop's blind spot is its own reconnect.

---
Canonical page: https://sluicesync.com/field-notes/goaway-said-reconnect/ · Full docs index: https://sluicesync.com/llms.txt
