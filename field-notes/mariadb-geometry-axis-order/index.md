# MariaDB and MySQL 8 disagree on which coordinate comes first

> Migrate a POINT in SRID 4326 from MariaDB to MySQL 8 and a naive ST_AsText diff shows the longitude and latitude swapped — POINT(-122.4194 37.7749) on the source reads POINT(37.7749 -122.4194) on the target. Nothing is corrupt. sluice copied the WKB faithfully and re-attached the SRID; the point is in the same place, and ST_Latitude/ST_Longitude match to the digit. The two engines just default to opposite axis orders when they render a geographic SRID as text. Compare the coordinates, not the string.

Observed — live-validating MariaDB as a migrate source (2026-07-17): MariaDB 11.4 → vanilla MySQL 8.4 and MariaDB 11.4 → PlanetScale (MySQL) on the shipped mariadb flavor. A places table with a POINT REF_SYSTEM_ID=4326 column migrated with the SRID carried and a clean row count — and a first-glance ST_AsText comparison showed the coordinates reversed. This note is why that reversal is a display convention, not data loss.

## The diff that looks like corruption

The source point on MariaDB renders as POINT(-122.4194 37.7749) — longitude first. Read the same migrated point back on the MySQL 8 target with plain ST_AsText and you get POINT(37.7749 -122.4194) — latitude first. If your validation is a text diff of ST_AsText(geom) source vs target, every SRID-4326 geometry flags as a mismatch, and a raw byte comparison of ST_AsBinary(geom) differs too. It reads exactly like the coordinates were transposed in flight.

## What sluice actually moved

sluice's geometry value contract (docs/value-types.md) is raw WKB — Well-Known Binary — carried as bytes, with the column's SRID recorded separately (read, for MariaDB, from the OGC-standard information_schema.GEOMETRY_COLUMNS view, since MariaDB won't echo the SRID any other way — see the sibling note below). On write, the MySQL row writer prepends MySQL's on-wire <srid uint32 little-endian> prefix to that byte-identical WKB payload and hands it to the server. WKB, by the OGC standard, is always stored in Cartesian x-y (longitude-latitude) order regardless of SRID, and ST_GeomFromWKB reads it that way — so the point MySQL stores is the same point MariaDB held. The proof is in the coordinate accessors, which are axis-order-agnostic: on the target, ST_Latitude(geom) = 37.7749 and ST_Longitude(geom) = -122.4194 — matching the source to the digit. The location did not move.

## Two engines, two default axis orders

What differs is only how each engine renders a geographic SRID back to text and to output-WKB. EPSG:4326 formally defines its axis order as latitude-then-longitude. MySQL 8 honors that: its ST_AsText and ST_AsBinary default to lat-long for a geographic SRS. MariaDB defaults to long-lat (x-y) display for the same SRID. Same stored point, two conventions for printing it — so the text renderings disagree while the geometry is identical. It is the geospatial cousin of comparing two dates by their formatted strings: 07/08 and 08/07 can be the same day.

## How to compare correctly

Do not diff ST_AsText(geom) or ST_AsBinary(geom) across the two engines. Compare with the axis-order-agnostic accessors — ST_Latitude(geom) and ST_Longitude(geom) — or pin the rendering explicitly: on the MySQL 8 target, ST_AsText(geom, 'axis-order=long-lat') reproduces the MariaDB source string exactly. Either check confirms what the migration actually did: preserved the point, byte-faithful in the WKB and correct in its SRID.

## The transferable lesson

A byte-level or text-level diff of a geometry across engines tests the engines' rendering conventions, not the fidelity of the value. sluice's job at the boundary is to move the WKB and the SRID intact, and it does — but SRID 4326 carries a standardized axis order that MySQL applies to its output functions and MariaDB does not, so the honest comparison is one that reads the coordinates by name, not by position. When a spatial value &ldquo;looks swapped&rdquo; after a cross-engine copy, reach for ST_Latitude/ST_Longitude before you reach for the panic button; a naive ST_AsText diff is comparing two spellings of the same place.

## Primary sources

- sluice geometry value contract (docs/value-types.md: ir.Geometry = raw WKB) and the MySQL row writer's <srid LE><wkb> prefix; live-validated mariadb:11.4 → mysql:8.4 and → PlanetScale (2026-07-17), ST_Latitude/ST_Longitude matched source to target.

- MySQL 8.0 Reference Manual — geographic-SRS axis order; the axis-order option to ST_AsText/ST_GeomFromText; WKB is SRS-independent x-y.

- MariaDB Knowledge Base — geometry ST_AsText / axis-order handling for SRID 4326.

- Related — the Migrating from MariaDB guide, and sibling MariaDB notes: MariaDB accepts a geometry SRID it won't show you (where the SRID lives) and MariaDB 11.4's default collation doesn't exist on MySQL 8 (another correct-by-design MariaDB divergence).

---
Canonical page: https://sluicesync.com/field-notes/mariadb-geometry-axis-order/ · Full docs index: https://sluicesync.com/llms.txt
