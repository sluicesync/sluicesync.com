# Two things the Parquet export directory doesn't tell you

> Two things a file-based export doesn't tell its readers — and what spec-compliant readers assume in the silence. GeoParquet defines an omitted crs as "this is lon/lat degrees" — so omission is an assertion, and an EPSG:3857 export without the stamp reads Web-Mercator meters as degrees, no error, wrong planet positions. And the standard read_parquet('dir/*.parquet') recipe treats the directory as the catalog — but a re-export doesn't unwrite old files, so a dropped table's stale .parquet keeps answering the glob as current data. The fix for the second grew a third act: the first orphan sweep deleted without an ownership proof, and a cleanup pass without one is a hazard of its own.

Observed — the 2026-07-15 repo audit (MED-D0-4 and MED-D0-5) against sluice's backup export-as-parquet, then exhibited live as a before/after differential by the v0.99.258 regression cycle on a real geometry corpus (details below). Both were sluice's own writer bugs: the schema knew the SRID the whole time (the IR carries it) and the writer simply didn't say it; the orphan sweep was simply never written. Fixed in v0.99.258 — and the sweep's first cut then over-deleted (the 2026-07-16 confirming audit's HIGH-2, live-reproduced), corrected in v0.99.262; that's the third act below. The GeoParquet omitted-crs default is spec behavior — nothing to file upstream.

## First: the omission that means something

GeoParquet's geo footer metadata has a crs field per geometry column, and the spec defines its absence: an omitted crs means OGC:CRS84 — longitude/latitude degrees. That makes omission an assertion, not a gap. sluice's export emitted only the encoding and geometry types; a geometry(Point, 3857) column — Web-Mercator, coordinates in meters — exported with no crs, and every spec-compliant reader dutifully interpreted millions-of-meters coordinates as degrees. GeoPandas and DuckDB-spatial don't error on that: the values are numerically plausible, the shapes render, and every position is wrong.

The live differential (v0.99.258 cycle, a corpus of SRID 4326 + 3857 + 32633 columns): the v0.99.257 export's geo block carries no crs at all — the 3857 column reads back as degrees under the spec default. The v0.99.258 export embeds canonical PROJJSON for the bundled SRIDs (4326 as GeographicCRS/WGS 84, 3857 as ProjectedCRS/Pseudo-Mercator), and read-back verification confirmed the round trip: DuckDB-spatial types the columns GEOMETRY('EPSG:4326') / GEOMETRY('EPSG:3857'), and GeoPandas reconstructs both CRSs.

The repair has its own subtlety, worth spelling out because it's the same trap one level down. For an SRID sluice can't render to PROJJSON (the corpus's 32633), the honest stamp is an explicit null — which the spec defines as &ldquo;CRS undefined,&rdquo; semantically different from omitting the key (&ldquo;CRS is CRS84&rdquo;) — plus a WARN and an index note naming the SRID and the downstream remedies (GeoPandas set_crs, DuckDB ST_Transform). The key is never omitted. When a spec assigns meaning to your silence, &ldquo;I don't know&rdquo; has to be said out loud.

## Second: the directory is the catalog

The analytics cookbook pattern — SELECT &hellip; FROM read_parquet('exports/*.parquet') — makes the directory listing the table catalog. But sluice's re-export wrote the fresh files and an updated index, and deleted nothing. Drop a table (or exclude it) and re-export with --force-overwrite: the fresh index no longer lists it, but its old .parquet file still sits in the directory, still matches the glob, and still serves last week's rows as current data. No reader consults the index; the glob is the query surface.

Live differential, same cycle: on v0.99.257 a dropped table's tbl2.parquet orphan survives a --force-overwrite re-export and keeps answering the glob. On v0.99.258 the re-export deletes every .parquet the fresh index does not claim, logging each by name (deleted a stale .parquet not claimed by this export's index), and the sibling files are untouched.

## Third: the fix that over-reached — cleanup needs an ownership proof

Honesty requires the third act: the v0.99.258 sweep closed the orphan hole and opened a bigger one. Its scope was &ldquo;every .parquet the fresh index does not claim&rdquo; — but it listed the output root recursively, and it ran whenever --force-overwrite was set, ungated on a prior sluice export existing there at all. sluice only ever writes top-level <schema>.<table>.parquet names, so a nested .parquet is by construction someone else's — yet the 2026-07-16 confirming audit (HIGH-2) reproduced a first-ever forced export into a directory that also held foreign Hive-style datasets (other-tool/dt=&hellip;/part-0001.parquet, a Spark output tree) deleting all of them, irreversibly, named at INFO only after the fact. &ldquo;Not claimed by my index&rdquo; describes every Parquet file on earth; a delete keyed on the absence of a claim has no boundary.

v0.99.262 draws the boundary the first cut skipped, and it's a positive proof, not a broader filter: the sweep touches only top-level names — the shapes sluice could have written — and only when the destination's prior parquet_index.json proves a sluice export owned the directory; everything unclaimed outside that boundary is WARN-named as unmanaged and never deleted. The index that no reader consults (act two's complaint) turns out to have a second job: it is the writer's own ownership sentinel, the artifact that licenses the delete.

## Reproducing it

Any MySQL or Postgres with a geometry column (this is the regression-cycle corpus shape):

    CREATE TABLE geo (id INT PRIMARY KEY,
                      p4326 POINT NOT NULL SRID 4326,
                      p3857 POINT NOT NULL SRID 3857);
    -- insert a few rows, then:
    sluice backup full --source-driver=mysql --source '<dsn>' --out ./store
    sluice backup export-as-parquet --from-dir ./store --out ./exports

    # inspect the geo metadata (duckdb):
    SELECT key, value FROM parquet_kv_metadata('exports/geo.parquet');
    # <= v0.99.257: the geo block has NO "crs" key — 3857 meters read as degrees
    # >= v0.99.258: PROJJSON for 4326 + 3857; unbundled SRIDs get explicit "crs": null + a WARN

    # the orphan: drop a table, take a fresh backup, re-export
    sluice backup export-as-parquet --from-dir ./store2 --out ./exports --force-overwrite
    ls exports/*.parquet
    # <= v0.99.257: the dropped table's file is still there, still answers the glob
    # >= v0.99.258: "deleted a stale .parquet not claimed by this export's index" naming it

    # the third act: a foreign nested dataset in the same destination
    mkdir -p fresh-exports/other-tool/dt=2026-07-01   # no prior sluice export here
    cp elsewhere/part-0001.parquet fresh-exports/other-tool/dt=2026-07-01/
    sluice backup export-as-parquet --from-dir ./store --out ./fresh-exports --force-overwrite
    # v0.99.258-261: the foreign nested .parquet is DELETED — on a first-ever export
    # >= v0.99.262: top-level-only + prior-index ownership gate; foreign files WARN-named as unmanaged, untouched

For the misread itself: import geopandas; geopandas.read_parquet('exports/geo.parquet').crs — pre-fix that reports EPSG:4326-equivalent (the spec default) for a column whose numbers are meters.

## The transferable lesson

Common thread: in a spec'd file format, whatever the reader is defined to assume in the absence of your metadata is part of your writer's contract — read the spec's defaults as obligations, and when you genuinely don't know a value, say so explicitly rather than omitting the key, because the two silences can mean different things. And when the directory is the catalog — every glob-based lake pattern — deleting is part of writing: an exporter that only adds files leaves every consumer reading the union of all its historical runs. But the license to delete extends exactly as far as ownership does, and ownership must be a positive proof (a sentinel you wrote, names only you emit), never the absence of a claim — a cleanup pass scoped by what it doesn't recognize will eventually meet a directory it shares.

## Primary sources

- GeoParquet specification — the geo metadata's crs field: omitted means OGC:CRS84; explicit null means undefined; PROJJSON as the encoding.

- sluice v0.99.258 changelog — the per-column CRS stamp (canonical PROJJSON for 4326/3857, explicit null + WARN for unbundled SRIDs) and the --force-overwrite orphan sweep; audit findings MED-D0-4/5.

- sluice v0.99.262 changelog — the sweep's ownership boundary: top-level names only, gated on the prior parquet_index.json sentinel, unmanaged files WARN-named and never deleted; the 2026-07-16 confirming audit's HIGH-2 (foreign nested datasets deleted on a first-ever forced export, live-reproduced).

- sluice-testing session report v0.99.258 (F6) — the live differential on the 4326/3857/32633 corpus, including the DuckDB-spatial and GeoPandas read-back.

- Companion field note — The Parquet library nulled every false (the same surface's earlier silent class: the library nulled every false; here the spec degrades every omission).

---
Canonical page: https://sluicesync.com/field-notes/parquet-directory-doesnt-tell-you/ · Full docs index: https://sluicesync.com/llms.txt
