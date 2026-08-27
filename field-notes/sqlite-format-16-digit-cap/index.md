# SQLite's format('%.17g') silently caps floats at 16 significant digits

> format('%.17g', x) is the textbook way to render a double as text that reads back exactly — 17 significant digits is the IEEE-754 round-trip guarantee, and C's printf has honored it for decades. SQLite's format() looks exactly like C's printf and silently isn't: its %g conversion caps output at 16 significant digits, one short of what a double needs, and %.16g, %.17g, %.20g, %.25g all emit the same 16-digit render. ~46% of swept doubles came back a different double. Only the obscure ! flag lifts the cap.

Observed &mdash; sluice's SQLite/D1 trigger-CDC value capture, caught by an adversarial value-fidelity corpus on its first trigger-CDC run and fixed in v0.131.2. Measured on modernc's bundled SQLite 3.53.3 and on real Cloudflare D1: 2295 of 5007 swept doubles (~46%) fail to round-trip through %.17g. The pure Go-side renders (strconv, the flat-file and parquet writers) were never affected; the exposure was the paths that rebuild a REAL's text inside the engine &mdash; the capture triggers and the D1 cold-start projection that reuses the same format() expression.

## The guarantee everyone leans on

Rendering a binary64 double with 17 significant digits guarantees the text reads back to the identical double &mdash; that is IEEE-754 arithmetic, and printf("%.17g") is its canonical spelling. Trigger-based CDC on SQLite has to render values in SQL, inside the trigger, so sluice's capture expression leaned on exactly that: format('%.17g', col) for every REAL column. SQLite's format() documents itself as a printf-style function, and for most conversions it is one.

## The cap

Not for %g. SQLite's own printf implementation caps floating-point output at 16 significant digits. The precision spec is honored below the cap and clamped at it: %.15g gives you 15 digits, but %.16g, %.17g, %.20g, and %.25g all emit the same 16-digit render &mdash; one digit short of what a double needs. So format('%.17g', 0.30000000000000004) returns "0.3", and a 17-digit-shaped value comes back as the 16-digit "0.1234567890123457" &mdash; a different double, in a value no target could refuse, at exit 0. And at the magnitude extreme it stops being silent: 16-digit rounding pushes the maximum double up, rendering "1.797693134862316e+308" &mdash; out of range, killing the stream loudly at decode. A worth-admitting coda: sluice's first shipped explanation blamed a SQLite 3.43 rewrite of format(), and that was wrong &mdash; direct experiment showed precision is honored below the cap and clamped at it, longstanding printf behavior, so %.17g was never lossless here. Even the postmortem needed the experiment.

How it hid: the old regression test pinned one representative value &mdash; &pi;, whose shortest representation is exactly 16 digits &mdash; and stayed green straight through the loss. The corpus that caught it swept the worst-case doubles of the family against the real engine.

## The one-character fix, and its version story

The escape is a SQLite-specific spelling most people have never needed: the alternate-form-2 flag. format('%!.20g', col) lifts the cap (from 16 to 26 significant digits), and the same 5007-double sweep then measures 0 misses &mdash; on modernc's SQLite and on real D1. The obvious worry &mdash; what does ! do on an older SQLite? &mdash; has an unusually clean answer: the ! handling in SQLite's printf predates the SQL-level printf() function itself (added 3.8.3 in 2014, renamed format() in 3.38.0), so no shipped SQLite has the function without honoring the flag &mdash; a library too old to honor ! is too old to have the function, and fails the write loudly with &ldquo;no such function&rdquo; rather than silently clamping. sluice still doesn't take that on faith at runtime: a render-fidelity probe runs the production capture expression over a 17-digit double on the connected engine at every stream open and refuses on a clamp, and a capture-shape door refuses an installed trigger still carrying the old lossy body &mdash; so a stale install can't keep capturing wrong. The one residual, named in the code: a third-party application's own SQLite library firing a local capture trigger renders with that library's printf, which no probe from sluice's process can grade.

## The transferable lesson

A printf-style precision spec is an engine behavior, not a language constant &mdash; a function that borrows printf's syntax has not thereby promised printf's semantics, and the divergence hides precisely because the format string parses identically. If you serialize floats through a database's own string-formatting function, round-trip the worst-case double of the family against the real engine and version &mdash; a representative value that happens to fit 16 digits proves nothing &mdash; and keep a negative control in the gate so the question reopens if the engine changes again.

## Primary sources

- SQLite documentation &mdash; the built-in printf &mdash; the 16-significant-digit behavior and the ! alternate-form-2 flag for floating point.

- SQLite documentation &mdash; format() &mdash; added as printf() in 3.8.3, renamed format() in 3.38.0.

- sluice v0.131.2 changelog &mdash; the corpus finding (2295/5007), the %!.20g capture expression, and the capture-shape door; v0.131.4 &mdash; the render-fidelity probe and the version-history bound on the ! flag.

- Related field notes: SQLite's DECIMAL is a suggestion &mdash; the reader-side float-rendering trap on the same lane; Postgres rounds your fractional seconds through a C double &mdash; another engine's float-rendering seam.

---
Canonical page: https://sluicesync.com/field-notes/sqlite-format-16-digit-cap/ · Full docs index: https://sluicesync.com/llms.txt
