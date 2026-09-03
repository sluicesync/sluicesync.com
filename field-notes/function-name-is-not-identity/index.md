# A Postgres function's name is not its identity

> PostgreSQL identifies a function by (name, argument types), so a catalog read scoped by proname alone can resolve to a row that nothing executes — and CREATE OR REPLACE of the real function cannot remove an overload, so the obvious repair never clears the decoy. Three checkable catalog facts decide whether auditing an installed function against the one your tool renders means anything: overloading, the three columns a definition actually spans, and the one genuinely helpful property — prosrc is stored byte-verbatim.

Observed &mdash; a pre-publish value-fidelity review of sluice v0.137.0, ground-truthed on real PostgreSQL 16; every fact below was re-measured for this note on 16.14 and 17.11. The honest framing, stated up front: the door in question &mdash; the trigger engine's capture-function body check &mdash; was written and fixed inside that same release, while its GitHub release was still a draft. v0.137.0 shipped with the arity scope in place, and no released sluice binary ever carried the bypassable read. This is written up because the catalog facts are general and genuinely surprising, not because there is a defect to disclose.

## proname does not identify a function

PostgreSQL identifies a function by its name and its argument types. Several pg_proc rows can share one name in one schema, and a read scoped by proname alone can therefore return more than one &mdash; which is easy to forget for trigger functions specifically, because they are always 0-arg. PostgreSQL refuses declared arguments on RETURNS trigger outright:

    ERROR:  trigger functions cannot have declared arguments
    HINT:   The arguments of the trigger can be accessed through
            TG_NARGS and TG_ARGV instead.

&ldquo;There can only be one&rdquo; feels like a consequence of that. It isn't. Nothing stops a different, same-named function existing beside it with a different signature and a different return type &mdash; and the decoy need not even be well-formed code. plpgsql's creation-time validator is a syntax check, not a resolution check: a body referencing a table that does not exist is accepted and stored verbatim under the default check_function_bodies = on (measured). Turning it off relaxes even the syntax check, so a body that is not plpgsql at all is stored intact. Either way the catalog ends up holding whatever text you handed it.

Which makes the attack on a name-only audit three statements. CREATE OR REPLACE the real 0-arg function with a body that does nothing &mdash; every trigger stays in place, correctly named, correctly shaped, pointing at a function that records nothing. Then plant a same-named 1-arg function whose body looks exactly like the real one. The audit's read now returns two rows, and whichever it keeps, half its answers concern a function nothing executes. Where the read collapses rows into a map keyed by name &mdash; the natural way to write it &mdash; the last row wins, and the decoy is what gets graded.

## And the obvious repair does not clear it

The part that turns a bypass into a permanent one: CREATE OR REPLACE FUNCTION f() replaces the 0-arg function and leaves the 1-arg overload completely untouched. Measured &mdash; two rows named f before, two rows after. So the remediation such a tool prescribes (&ldquo;re-run setup to reinstall the real definition&rdquo;) restores the thing that executes and leaves the thing being graded exactly where it stood. The audit keeps passing, the repair reads as successful, and nothing in the loop ever closes.

## A definition is three columns, and only one is the body

The second fact is about what &ldquo;compare the definition&rdquo; has to reach. PostgreSQL splits a function's definition across three pg_proc columns: prosrc holds the text between the dollar quotes, the SET clauses land in proconfig, and SECURITY DEFINER in prosecdef. A prosrc-only comparison &mdash; the obvious first cut &mdash; sees the body and misses every GUC pin.

That is exactly where the hardening lives. SET search_path is the injection pin that makes a SECURITY DEFINER function safe to run at all. In a data-capture function, SET bytea_output = hex and SET extra_float_digits = 3 are value-fidelity pins: without them the function serializes bytea and float columns through the firing session's settings, which is silent corruption on the way to a target, decided by whichever application happened to write the row. An audit that reads prosrc and stops passes an install missing all three, and reports it as matching.

## The counterweight: prosrc is stored byte-verbatim

The genuinely helpful fact, and an unusual one. PostgreSQL stores prosrc exactly as written &mdash; no re-parse, no canonical re-render. Most catalog objects do not work this way: a CHECK constraint, an index definition or a view body all come back normalized, which is why comparing them against your own render is a canonicalization problem. Function bodies are not. Exact equality against the text your tool would install is achievable, and is the right default.

Which then makes normalization the discipline rather than the escape hatch. The only transforms that cannot hide a semantic change are line-ending normalization and trailing whitespace per line &mdash; what a dry-run plan pasted through a Windows editor or through psql undergoes, with no SQL meaning attached. Anything looser is a hole: collapse internal whitespace and a body differing only inside a string literal or a quoted identifier compares equal. proconfig needs its own normalization, applied to both sides, into the name=value form PostgreSQL itself stores &mdash; and since that round trip is a premise about the server rather than about your code, it is worth asserting against a real one instead of assuming it.

## The fix shape, and why arity is the one that closes

Two options, and they are not equivalent in reach. Scope the read &mdash; AND p.pronargs = 0. Or stop reading by name at all and resolve through the OID actually bound: pg_trigger.tgfoid for a table trigger, pg_event_trigger.evtfoid for an event trigger, so what you grade is by construction what executes.

Arity is worth spelling out because it closes the class completely rather than narrowly, which is the property to check before accepting any scope as a fix. A 0-arg decoy cannot coexist with the real function: the same signature means CREATE OR REPLACE replaces it, and a differing return type is refused outright &mdash; ERROR: cannot change return type of existing function. So exactly one row can match per name, and no legitimate function is ever excluded. Belt and braces for the same class: if two rows ever do come back for one name, refuse rather than pick a winner. Silently keeping one of two definitions is the defect the scope exists to close, and a tie-break rule would quietly reintroduce it.

## The transferable lesson

When you audit a database object against what your tool renders, the read must be scoped by the object's real identity, not by the part of it that shows up in your error messages. For functions that identity is (name, argument types); operators and aggregates carry the same shape. And a scope only counts as a fix if it makes the ambiguous state unrepresentable &mdash; the tell here is that arity also makes the repair path sound, whereas &ldquo;take the first row&rdquo; or &ldquo;take the one with the right return type&rdquo; would leave the decoy standing and the prescribed remedy quietly unable to clear it. If your scope narrows the read but leaves the bad state constructible, you have moved the bug, not removed it.

## Primary sources

- PostgreSQL documentation &mdash; CREATE FUNCTION (overloading by argument types; CREATE OR REPLACE cannot change a function's argument types or return type) and pg_proc &mdash; prosrc, proconfig, prosecdef.

- PostgreSQL documentation &mdash; check_function_bodies &mdash; the validator is not a resolution check even when on.

- Measured for this note on stock postgres:16 (16.14) and postgres:17 (17.11) containers &mdash; the declared-arguments refusal, the surviving overload after CREATE OR REPLACE, the return-type refusal, and body storage under both check_function_bodies settings.

- sluice internal/engines/pgtrigger/cdc_capture_body.go at v0.137.0 &mdash; captureFunctionArity, captureFunctionShapeQuery and the file header: the arity scope, the three-column comparison, and the two normalizations. Since v0.138.0 the door resolves through the OID actually bound — pg_trigger.tgfoid / pg_event_trigger.evtfoid, compared by namespace before name — in cdc_capture_shape.go; captureFunctionArity no longer exists, so a same-named function in another schema is never what gets graded.

- Related field note: The index that shares only a name &mdash; the same family one object type over: &ldquo;already exists&rdquo; is not &ldquo;already correct.&rdquo;

---
Canonical page: https://sluicesync.com/field-notes/function-name-is-not-identity/ · Full docs index: https://sluicesync.com/llms.txt
