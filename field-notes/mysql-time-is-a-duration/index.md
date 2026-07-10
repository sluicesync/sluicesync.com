# MySQL TIME is a duration, not a time of day

> A MySQL TIME column ranges -838:59:59 to 838:59:59 and models elapsed duration, not clock time. Postgres time is a time-of-day, 00:00 to 24:00 — so any negative or over-24-hour MySQL TIME has no home there. The faithful target is interval.

Observed — MySQL → Postgres migration of a TIME column. Internally the TIME → ir.Interval type mapping.

## What happened

A MySQL-to-Postgres migration mapped a TIME column to Postgres time by name — the obvious pairing — and rows carrying values like 500:30:00 (a stopwatch total) or -12:30:00 (a negative offset) had nowhere to land. The names match; the semantics do not.

## Why (the mechanism)

MySQL's TIME is a signed duration, documented range -838:59:59 to 838:59:59 — roughly &plusmn;35 days. It is designed to hold elapsed time (a lap time, a total worked, a delta), which is why it goes negative and well past 24 hours. Postgres time is a time of day: 00:00:00 to 24:00:00, a point on the clock, with no notion of negative or "more than a day." They share a name and a HH:MM:SS spelling, and diverge completely at the edges. Any MySQL TIME outside [00:00, 24:00) — negative, or over 24 hours — simply cannot be represented as a Postgres time. The correct Postgres home for a duration is interval, which is signed and unbounded in exactly the way TIME needs.

## The repro

    -- MySQL: TIME holds durations, signed, well past 24h
    CREATE TABLE laps (id INT, elapsed TIME);
    INSERT INTO laps VALUES (1, '500:30:00'), (2, '-12:30:00');  -- both valid

    -- Postgres time is a clock reading — these have no representation:
    SELECT '500:30:00'::time;   -- ERROR: date/time field value out of range
    SELECT '-12:30:00'::time;   -- ERROR: invalid input syntax for type time
    -- the faithful target:
    SELECT '500:30:00'::interval;  -- 500:30:00
    SELECT '-12:30:00'::interval;  -- -12:30:00

## What sluice does about it

sluice maps MySQL TIME to the IR's Interval type, which lands on Postgres interval — so the full signed, &plusmn;838-hour range round-trips instead of clipping or erroring at the time boundary. The name-based TIME → time pairing is exactly the trap the IR exists to avoid: translation is by semantics, resolved in one place, not by matching type spellings across engines.

## The transferable lesson

Two databases can give a type the same name and the same surface syntax and mean different things by it — MySQL TIME is a duration type wearing a time-of-day costume. When you translate types across engines, map on the value's semantics and range, not its name: the question isn't "does Postgres have a time?" but "what does MySQL let this column hold, and what's the Postgres type that holds all of it?" The answer for TIME is interval, and you only learn that by looking at the range, not the label.

## Primary sources

- MySQL TIME range and duration semantics — The TIME Type (&minus;838:59:59 … 838:59:59).

- Postgres time vs interval — date/time types.

- sluice's type-mapping policy — Type mapping.

---
Canonical page: https://sluicesync.com/field-notes/mysql-time-is-a-duration/ · Full docs index: https://sluicesync.com/llms.txt
