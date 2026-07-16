# The parent table that returns rows it doesn't own

> Old-style Postgres inheritance presents parent and children to information_schema as ordinary, unrelated BASE TABLEs — while a SELECT on the parent, without ONLY, also returns every child's rows. The standard migration recipe (enumerate BASE TABLEs, copy each) therefore lands the child data twice: flattened into the parent's target table and again in each child's. Silently, exit 0; the only symptom is a row count that's too big.

Observed — a preflight-gap review comparing sluice's Postgres census against a vendor discovery tool's (roadmap item 68, 2026-07-15; refused loudly since v0.99.253), then proven live by the post-release regression cycle in a before/after differential on the last unguarded release — the numbers are below. This one is a confession as much as a note: the silent-duplication window was every prior sluice release with a Postgres source. The declarative-partition twin of the same trap was guarded back in v0.92.0; the legacy twin never was, and our own changelog now advises anyone who migrated an INHERITS hierarchy through v0.99.252 to verify their target for duplicated child rows.

## What happened

Postgres has two table-hierarchy mechanisms. Declarative partitioning (PARTITION BY) is the modern one; old-style inheritance (CREATE TABLE child () INHERITS (parent)) is the pre-PG-10 ancestor, still fully supported and still in the wild. Both share the query-time behavior that matters here: reading the parent without the ONLY keyword returns the children's rows too.

Where they differ is catalog visibility, and that difference decided which trap got caught four months before the other. A declarative partition parent announces itself — it has a row in pg_partitioned_table, its relkind is 'p', and information_schema shows the children oddly enough to make you look. We hit that in v0.92.0 (Bug 100), saw the silent flatten-plus-duplicate shape, and shipped a loud refusal. An INHERITS parent announces nothing: parent and children all present to information_schema.tables as plain BASE TABLEs, relkind 'r', indistinguishable from any other tables. The only catalog signal that a hierarchy exists at all is a row in pg_inherits whose parent has relkind 'r' — a system catalog the standard enumeration recipe never consults.

So the recipe every migration tool starts from — SELECT &hellip; FROM information_schema.tables WHERE table_type = 'BASE TABLE', copy each — does exactly the wrong thing: it copies each child as its own table, and it copies the parent with a SELECT that, lacking ONLY, sweeps in every child's rows again. The ground truth is compact enough to pin in one pair of queries (this is the real-PG assertion in our integration suite):

    -- one row inserted into the child, zero into the parent:
    SELECT count(*) FROM measurements;        -- 1  (parent SELECT sees the child's row)
    SELECT count(*) FROM ONLY measurements;   -- 0  (the parent owns nothing)

An unguarded migration copies that row twice — once into the parent's target table, once into the child's.

## The live differential

The claim above started as a code-read plus that integration pin. The post-release regression cycle then ran the whole shape live, same source both times: a parent with 3 rows of its own, child1 () INHERITS (parent) with 4 rows, child2 with 2 — so SELECT count(*) FROM parent reads 9 and FROM ONLY parent reads 3.

    binary       exit   target parent   duplication
    ---------    ----   -------------   --------------------------------------
    v0.99.252    rc=0   9 rows          child1's 4 ids present TWICE on the
                        (3 own + all    target (in parent AND in child1's own
                        6 child rows)   table); no warning, no signal anywhere
    v0.99.253    rc=1   refused         pre-DDL: target database has 0 tables;
                        (nothing        refusal names the parent, the double-
                        landed)         land mechanism, all three recovery paths

The unguarded run is the silent-loss shape in full: exit 0, every table &ldquo;migrated,&rdquo; and the only tell is that the parent's target count is 9 where the source's ONLY count is 3. The guarded run refuses before any DDL, so a refused migration leaves the target untouched rather than half-built. The same cycle also proved the recovery path (--exclude-table on the parent proceeds, child checksums source==target) and that the two hierarchy probes don't cross-fire: a declarative partition parent still refuses via the original Bug-100 wording with no INHERITS text — relkind 'r' and 'p' stay disjoint live, not just in the catalog query.

## The second beat: the same filter hides tables entirely

The same table_type = 'BASE TABLE' filter has an inverse failure. FDW foreign tables are relkind 'f' — not BASE TABLEs — so they never enter the enumeration at all. That skip is arguably correct (a foreign table holds no local rows; materializing another server's data would be its own surprise), but it was silent: an FDW-fronted table simply vanished from the migration with no signal that data the application sees wasn't coming along. The census for those lives in pg_foreign_table joined to pg_foreign_server — again, system catalogs, not information_schema.

Put together: for migration purposes, information_schema.tables both double-counts (inheritance parents return rows they don't own) and under-counts (foreign tables don't appear at all). The portable view is a flattened projection of a catalog whose relkind distinctions are exactly the ones a copy tool needs. This beat got its live differential too: on v0.99.252 a foreign table vanished from the run with no signal at all; on v0.99.253 the WARN names both the table and the foreign server its data actually lives on, the data outcome is identical, and excluding the table acknowledges and silences it.

## What sluice does about it

Since v0.99.253, two disjoint relkind-aware probes. Inheritance parents (pg_inherits parents with relkind 'r' — deliberately disjoint from Bug 100's relkind 'p' probe) are a loud refusal at migrate and sync cold start, not a WARN: both outcomes of proceeding — duplication if parent and children are in scope, quiet hierarchy loss if not — are data-shape corruption an operator would only discover by counting rows. Foreign tables get a WARN naming each skipped table and the foreign server its data actually lives on; the skip itself stays, because the wart was the silence, not the skip. Both are filter-aware — excluding the offending tables acknowledges and silences them.

The refusal's recovery paths carry one more trap worth spelling out. The obvious fix — exclude the parent, copy the children individually — is only safe if the parent stores no rows of its own, so the refusal tells the operator to check SELECT count(*) FROM ONLY parent first: a non-zero count means the parent's own rows would silently vanish from the migration instead. The guard against double-counting must not become an instrument of under-counting.

## Reproducing it

Any Postgres, no special setup — this is the exact fixture the regression cycle ran:

    CREATE TABLE parent (id int PRIMARY KEY, note text);
    CREATE TABLE child1 () INHERITS (parent);
    CREATE TABLE child2 () INHERITS (parent);
    INSERT INTO parent VALUES (1,'p'),(2,'p'),(3,'p');
    INSERT INTO child1 VALUES (11,'c1'),(12,'c1'),(13,'c1'),(14,'c1');
    INSERT INTO child2 VALUES (21,'c2'),(22,'c2');

    SELECT count(*) FROM parent;        -- 9  (children included)
    SELECT count(*) FROM ONLY parent;   -- 3  (what the parent owns)

Now migrate with any tool that enumerates information_schema BASE TABLEs and copies each — sluice &le; v0.99.252 (sluice migrate --source 'postgres://...' --target ...) exhibits it: exit 0, target parent has 9 rows, and child1's four ids exist twice on the target (SELECT count(*) FROM parent p JOIN child1 c USING (id) on the target = 4). sluice &ge; v0.99.253 refuses rc=1 before any DDL. The ONLY-count check above is also the guard to run before taking the exclude-the-parent recovery path.

## The transferable lesson

If you enumerate Postgres tables for any copy-shaped purpose, information_schema is not enough: consult pg_inherits and relkind, or you will double-count inheritance hierarchies and never see foreign tables at all. The meta-lesson is about catalog signals and time-to-detection: we caught the declarative twin of this bug four months earlier not because it was worse but because its catalog signal exists — the trap with no signal is the one that ships. When you fix a class, ask which of its siblings differs only in being quieter; and when your recovery advice says &ldquo;just exclude the parent,&rdquo; check what the parent owns before you drop it from the copy.

## Primary sources

- PostgreSQL documentation — inheritance (SELECT on a parent includes children unless ONLY is used) and the pg_inherits, pg_class (relkind), pg_foreign_table, and pg_foreign_server catalogs.

- PostgreSQL documentation — information_schema.tables (foreign tables are not BASE TABLE; inheritance is not represented).

- sluice v0.99.253 changelog — the INHERITS refusal and foreign-table WARN census, including the verify-your-target advice for prior releases; the v0.92.0 changelog for the declarative twin (Bug 100).

---
Canonical page: https://sluicesync.com/field-notes/inherits-rows-it-doesnt-own/ · Full docs index: https://sluicesync.com/llms.txt
